export type OverflowPolicy = "block" | "drop-oldest";

export interface BoundedQueueOptions<T> {
	capacity: number;
	/** What `put` does when the queue is full. Defaults to `block`. */
	overflow?: OverflowPolicy;
	/** Called synchronously with each item evicted under the `drop-oldest` policy. */
	onDrop?: (item: T) => void;
}

export class QueueClosedError extends Error {
	constructor() {
		super("Queue is closed");
		this.name = "QueueClosedError";
	}
}

interface PendingPut<T> {
	item: T;
	resolve: () => void;
}

type Taker<T> = (result: IteratorResult<T, undefined>) => void;

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * An async FIFO queue with a fixed capacity, for any number of producers and consumers.
 *
 * When full, `put` either waits for space (`block`) or evicts the oldest buffered item
 * (`drop-oldest`). After `close`, further puts are rejected, but everything already
 * accepted, including puts still waiting for space, is delivered before consumers see
 * the end of the queue.
 */
export class BoundedQueue<T> implements AsyncIterable<T> {
	readonly capacity: number;
	readonly overflow: OverflowPolicy;
	readonly #onDrop: ((item: T) => void) | undefined;
	readonly #items = new Fifo<T>();
	readonly #putters = new Fifo<PendingPut<T>>();
	readonly #takers = new Fifo<Taker<T>>();
	#closed = false;
	#peakSize = 0;

	constructor(options: BoundedQueueOptions<T>) {
		if (!Number.isInteger(options.capacity) || options.capacity < 1) {
			throw new RangeError(
				`capacity must be a positive integer, got ${options.capacity}`,
			);
		}
		this.capacity = options.capacity;
		this.overflow = options.overflow ?? "block";
		this.#onDrop = options.onDrop;
	}

	/** Number of items currently buffered, excluding puts waiting for space. */
	get size(): number {
		return this.#items.length;
	}

	/** Largest number of items buffered at any one time. */
	get peakSize(): number {
		return this.#peakSize;
	}

	get closed(): boolean {
		return this.#closed;
	}

	put(item: T): Promise<void> {
		if (this.#closed) {
			return Promise.reject(new QueueClosedError());
		}
		// A waiting taker implies an empty buffer, so hand the item straight over.
		const taker = this.#takers.shift();
		if (taker) {
			taker({ done: false, value: item });
			return Promise.resolve();
		}
		if (this.#items.length < this.capacity) {
			this.#buffer(item);
			return Promise.resolve();
		}
		if (this.overflow === "drop-oldest") {
			const dropped = this.#items.shift() as T;
			this.#buffer(item);
			try {
				this.#onDrop?.(dropped);
			} catch (error) {
				return Promise.reject(error);
			}
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#putters.push({ item, resolve }));
	}

	/** Resolves with the next item, or with `done` once the queue is closed and drained. */
	take(): Promise<IteratorResult<T, undefined>> {
		if (this.#items.length > 0) {
			const value = this.#items.shift() as T;
			const putter = this.#putters.shift();
			if (putter) {
				this.#buffer(putter.item);
				putter.resolve();
			}
			return Promise.resolve({ done: false, value });
		}
		if (this.#closed) {
			return Promise.resolve(DONE);
		}
		return new Promise((resolve) => this.#takers.push(resolve));
	}

	/** Marks the end of input. Idempotent. */
	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		// Waiting takers imply an empty buffer and no pending puts, so nothing more will arrive.
		for (
			let taker = this.#takers.shift();
			taker;
			taker = this.#takers.shift()
		) {
			taker(DONE);
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
		while (true) {
			const result = await this.take();
			if (result.done) {
				return;
			}
			yield result.value;
		}
	}

	#buffer(item: T): void {
		this.#items.push(item);
		this.#peakSize = Math.max(this.#peakSize, this.#items.length);
	}
}

/** Array-backed FIFO with amortised O(1) `shift`, unlike `Array.prototype.shift`. */
class Fifo<T> {
	#items: T[] = [];
	#head = 0;

	get length(): number {
		return this.#items.length - this.#head;
	}

	push(item: T): void {
		this.#items.push(item);
	}

	shift(): T | undefined {
		if (this.#head === this.#items.length) {
			return undefined;
		}
		const item = this.#items[this.#head];
		this.#head++;
		if (this.#head * 2 >= this.#items.length) {
			this.#items = this.#items.slice(this.#head);
			this.#head = 0;
		}
		return item;
	}
}
