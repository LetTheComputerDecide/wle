import { describe, expect, test, vi } from "vitest";
import { BoundedQueue, QueueClosedError } from "../src/queue.ts";

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Tracks whether a promise has settled without awaiting it. */
function track<T>(promise: Promise<T>) {
	const state: { settled: boolean; value?: T; error?: unknown } = {
		settled: false,
	};
	promise.then(
		(value) => Object.assign(state, { settled: true, value }),
		(error: unknown) => Object.assign(state, { settled: true, error }),
	);
	return state;
}

async function drain<T>(queue: BoundedQueue<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of queue) {
		items.push(item);
	}
	return items;
}

describe("construction", () => {
	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects capacity %s",
		(capacity) => {
			expect(() => new BoundedQueue({ capacity })).toThrow(RangeError);
		},
	);

	test("defaults to the block policy", () => {
		expect(new BoundedQueue({ capacity: 1 }).overflow).toBe("block");
	});
});

describe("ordering", () => {
	test("delivers items in FIFO order", async () => {
		const queue = new BoundedQueue<number>({ capacity: 10 });
		for (const n of [1, 2, 3]) {
			await queue.put(n);
		}
		queue.close();
		expect(await drain(queue)).toEqual([1, 2, 3]);
	});

	test("delivers falsy items", async () => {
		const queue = new BoundedQueue<unknown>({ capacity: 10 });
		for (const item of [undefined, null, 0, "", false]) {
			await queue.put(item);
		}
		queue.close();
		expect(await drain(queue)).toEqual([undefined, null, 0, "", false]);
	});

	test("keeps FIFO order across many items", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1000 });
		const items = Array.from({ length: 1000 }, (_, i) => i);
		for (const n of items) {
			await queue.put(n);
		}
		queue.close();
		expect(await drain(queue)).toEqual(items);
	});
});

describe("take", () => {
	test("waits until an item is put", async () => {
		const queue = new BoundedQueue<string>({ capacity: 1 });
		const take = track(queue.take());
		await flush();
		expect(take.settled).toBe(false);

		await queue.put("a");
		await flush();
		expect(take.value).toEqual({ done: false, value: "a" });
	});

	test("serves waiting takers in arrival order", async () => {
		const queue = new BoundedQueue<string>({ capacity: 1 });
		const first = queue.take();
		const second = queue.take();
		await queue.put("a");
		await queue.put("b");
		expect(await first).toEqual({ done: false, value: "a" });
		expect(await second).toEqual({ done: false, value: "b" });
	});
});

describe("block policy", () => {
	test("put waits while the queue is full", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		await queue.put(1);
		const put = track(queue.put(2));
		await flush();
		expect(put.settled).toBe(false);
		expect(queue.size).toBe(1);

		expect(await queue.take()).toEqual({ done: false, value: 1 });
		await flush();
		expect(put.settled).toBe(true);
		expect(queue.size).toBe(1);
		expect(await queue.take()).toEqual({ done: false, value: 2 });
	});

	test("admits waiting putters in arrival order", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		await queue.put(1);
		void queue.put(2);
		void queue.put(3);
		queue.close();
		expect(await drain(queue)).toEqual([1, 2, 3]);
	});

	test("never buffers more than capacity", async () => {
		const queue = new BoundedQueue<number>({ capacity: 3 });
		for (let n = 0; n < 10; n++) {
			void queue.put(n);
		}
		expect(queue.size).toBe(3);
		queue.close();
		expect(await drain(queue)).toHaveLength(10);
		expect(queue.peakSize).toBe(3);
	});
});

describe("drop-oldest policy", () => {
	test("evicts the oldest item and reports it", async () => {
		const onDrop = vi.fn();
		const queue = new BoundedQueue<number>({
			capacity: 2,
			overflow: "drop-oldest",
			onDrop,
		});
		for (const n of [1, 2, 3, 4]) {
			await queue.put(n);
		}
		expect(onDrop.mock.calls).toEqual([[1], [2]]);
		queue.close();
		expect(await drain(queue)).toEqual([3, 4]);
	});

	test("put never waits", async () => {
		const queue = new BoundedQueue<number>({
			capacity: 1,
			overflow: "drop-oldest",
		});
		await queue.put(1);
		const put = track(queue.put(2));
		await flush();
		expect(put.settled).toBe(true);
	});

	test("does not drop when a taker is waiting", async () => {
		const onDrop = vi.fn();
		const queue = new BoundedQueue<number>({
			capacity: 1,
			overflow: "drop-oldest",
			onDrop,
		});
		const take = queue.take();
		await queue.put(1);
		expect(await take).toEqual({ done: false, value: 1 });
		expect(onDrop).not.toHaveBeenCalled();
	});

	test("rejects the put when onDrop throws, but keeps the new item", async () => {
		const failure = new Error("sink failed");
		const queue = new BoundedQueue<number>({
			capacity: 1,
			overflow: "drop-oldest",
			onDrop: () => {
				throw failure;
			},
		});
		await queue.put(1);
		await expect(queue.put(2)).rejects.toBe(failure);
		queue.close();
		expect(await drain(queue)).toEqual([2]);
	});
});

describe("close", () => {
	test("ends iteration after remaining items are drained", async () => {
		const queue = new BoundedQueue<number>({ capacity: 5 });
		await queue.put(1);
		await queue.put(2);
		queue.close();
		expect(queue.closed).toBe(true);
		expect(await drain(queue)).toEqual([1, 2]);
		expect(await queue.take()).toEqual({ done: true, value: undefined });
	});

	test("releases every waiting taker", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		const takes = [queue.take(), queue.take()];
		queue.close();
		expect(await Promise.all(takes)).toEqual([
			{ done: true, value: undefined },
			{ done: true, value: undefined },
		]);
	});

	test("rejects puts after close", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		queue.close();
		await expect(queue.put(1)).rejects.toBeInstanceOf(QueueClosedError);
	});

	test("still delivers puts that were waiting for space", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		await queue.put(1);
		const put = queue.put(2);
		queue.close();
		expect(await drain(queue)).toEqual([1, 2]);
		await expect(put).resolves.toBeUndefined();
	});

	test("is idempotent", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		await queue.put(1);
		queue.close();
		queue.close();
		expect(await drain(queue)).toEqual([1]);
	});
});

describe("concurrent producers and consumers", () => {
	test("does not end while empty but not yet closed", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		const consumed = drain(queue);
		const state = track(consumed);

		// The queue is empty here, repeatedly, but the producer has not finished.
		for (const n of [1, 2, 3]) {
			await flush();
			expect(state.settled).toBe(false);
			await queue.put(n);
		}
		await flush();
		expect(state.settled).toBe(false);

		queue.close();
		expect(await consumed).toEqual([1, 2, 3]);
	});

	test("interleaves producing and consuming", async () => {
		const queue = new BoundedQueue<number>({ capacity: 1 });
		const log: string[] = [];
		const producer = (async () => {
			for (const n of [1, 2, 3]) {
				await queue.put(n);
				log.push(`put ${n}`);
			}
			queue.close();
		})();
		const consumer = (async () => {
			for await (const n of queue) {
				log.push(`take ${n}`);
			}
		})();
		await Promise.all([producer, consumer]);

		// With capacity 1, the producer cannot get two items ahead of the consumer.
		expect(log.indexOf("take 1")).toBeLessThan(log.indexOf("put 3"));
		expect(log.filter((entry) => entry.startsWith("take"))).toEqual([
			"take 1",
			"take 2",
			"take 3",
		]);
	});

	test("delivers each item to exactly one of several consumers", async () => {
		const queue = new BoundedQueue<number>({ capacity: 4 });
		const items = Array.from({ length: 200 }, (_, i) => i);
		const consumers = [drain(queue), drain(queue), drain(queue)];
		const producers = [0, 1].map(async (offset) => {
			for (let i = offset; i < items.length; i += 2) {
				await queue.put(i);
			}
		});
		await Promise.all(producers);
		queue.close();

		const received = (await Promise.all(consumers)).flat();
		expect(received.sort((a, b) => a - b)).toEqual(items);
	});
});
