/**
 * What `put` does when the queue is full.
 *
 * - `block`: wait until a consumer takes an item. Nothing is lost; producers slow down.
 * - `drop-oldest`: evict the oldest buffered item to make room. Producers never wait.
 */
export type OverflowPolicy = "block" | "drop-oldest";

/** Options for {@link BoundedQueue}. */
export interface BoundedQueueOptions<T> {
	/** Maximum number of buffered items. Must be a positive integer. */
	capacity: number;
	/** What `put` does when the queue is full. Defaults to `block`. */
	overflow?: OverflowPolicy;
	/** Called synchronously with each item evicted under the `drop-oldest` policy. */
	onDrop?: (item: T) => void;
}

/** Rejection reason for `put` on a queue that has been closed. */
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
 *
 * Items are delivered in the order they were accepted, and each to exactly one consumer.
 *
 * @example
 * ```ts
 * const queue = new BoundedQueue<string>({ capacity: 10 });
 * const consumer = (async () => {
 *   for await (const item of queue) console.log(item);
 * })();
 * await queue.put("a");
 * queue.close();
 * await consumer; // logs "a", then ends
 * ```
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

	/** @throws {RangeError} If `capacity` is not a positive integer. */
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

	/** Whether `close` has been called. Items may still be waiting to be taken. */
	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * Adds an item to the back of the queue.
	 *
	 * Resolves once the item is accepted: immediately if there is room (or under
	 * `drop-oldest`), otherwise when a consumer frees a slot.
	 *
	 * @throws {QueueClosedError} (as a rejection) If the queue is closed.
	 * Under `drop-oldest`, also rejects with whatever `onDrop` throws; the new item is
	 * accepted regardless.
	 */
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
			// The buffer is full, so there is an oldest item to drop.
			const dropped = this.#items.shift() as T;
			// Buffer first, so the queue is consistent even if `onDrop` throws or re-enters.
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

	/**
	 * Removes and returns the item at the front of the queue, waiting if it is empty.
	 *
	 * @returns The next item as `{ done: false, value }`, or `{ done: true }` once the
	 * queue is closed and everything accepted has been taken.
	 */
	take(): Promise<IteratorResult<T, undefined>> {
		if (this.#items.length > 0) {
			const value = this.#items.shift() as T;
			// Pending puts only exist while the buffer is full, so one slot just opened:
			// move the oldest waiting item in, keeping FIFO order, and release its putter.
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

	/**
	 * Marks the end of input. Idempotent.
	 *
	 * Later puts reject. Buffered items and puts already waiting for space are still
	 * delivered; consumers then see the end of the queue.
	 */
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

	/** Takes items until the queue is closed and drained. Breaking out early takes nothing more. */
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
		// Compact once at least half the array is consumed slots. Each copy is paid for by
		// as many earlier shifts, which keeps `shift` amortised O(1).
		if (this.#head * 2 >= this.#items.length) {
			this.#items = this.#items.slice(this.#head);
			this.#head = 0;
		}
		return item;
	}
}
