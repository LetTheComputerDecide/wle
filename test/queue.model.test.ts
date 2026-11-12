import fc from "fast-check";
import { expect, test } from "vitest";
import { BoundedQueue, type OverflowPolicy } from "../src/queue.ts";

/*
 * Model-based test: random sequences of put/take/close run against the real queue and
 * against a deliberately naive array model. After every step, both must have produced
 * the same events and agree on the buffered size.
 */

type Op = { kind: "put"; value: number } | { kind: "take" } | { kind: "close" };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class Model {
	readonly events: string[] = [];
	#buffer: number[] = [];
	#putters: { id: number; value: number }[] = [];
	#takers: number[] = [];
	#closed = false;

	readonly capacity: number;
	readonly overflow: OverflowPolicy;

	constructor(capacity: number, overflow: OverflowPolicy) {
		this.capacity = capacity;
		this.overflow = overflow;
	}

	get size() {
		return this.#buffer.length;
	}

	put(id: number, value: number) {
		if (this.#closed) {
			this.events.push(`put#${id} rejected`);
			return;
		}
		const taker = this.#takers.shift();
		if (taker !== undefined) {
			this.events.push(`take#${taker} ${value}`, `put#${id} ok`);
		} else if (this.#buffer.length < this.capacity) {
			this.#buffer.push(value);
			this.events.push(`put#${id} ok`);
		} else if (this.overflow === "drop-oldest") {
			this.events.push(`drop ${this.#buffer.shift()}`);
			this.#buffer.push(value);
			this.events.push(`put#${id} ok`);
		} else {
			this.#putters.push({ id, value });
		}
	}

	take(id: number) {
		const value = this.#buffer.shift();
		if (value !== undefined) {
			this.events.push(`take#${id} ${value}`);
			const putter = this.#putters.shift();
			if (putter) {
				this.#buffer.push(putter.value);
				this.events.push(`put#${putter.id} ok`);
			}
		} else if (this.#closed) {
			this.events.push(`take#${id} done`);
		} else {
			this.#takers.push(id);
		}
	}

	close() {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		for (const taker of this.#takers.splice(0)) {
			this.events.push(`take#${taker} done`);
		}
	}
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
	{
		weight: 5,
		arbitrary: fc.integer().map((value) => ({ kind: "put", value }) as const),
	},
	{ weight: 5, arbitrary: fc.constant({ kind: "take" } as const) },
	{ weight: 1, arbitrary: fc.constant({ kind: "close" } as const) },
);

test("matches the reference model", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.integer({ min: 1, max: 4 }),
			fc.constantFrom<OverflowPolicy>("block", "drop-oldest"),
			fc.array(opArb, { maxLength: 60 }),
			async (capacity, overflow, ops) => {
				const model = new Model(capacity, overflow);
				const events: string[] = [];
				const queue = new BoundedQueue<number>({
					capacity,
					overflow,
					onDrop: (item) => events.push(`drop ${item}`),
				});

				for (const [id, op] of ops.entries()) {
					const before = model.events.length;
					if (op.kind === "put") {
						model.put(id, op.value);
						queue.put(op.value).then(
							() => events.push(`put#${id} ok`),
							() => events.push(`put#${id} rejected`),
						);
					} else if (op.kind === "take") {
						model.take(id);
						void queue.take().then((result) => {
							events.push(`take#${id} ${result.done ? "done" : result.value}`);
						});
					} else {
						model.close();
						queue.close();
					}
					await flush();

					// Promise callbacks within one step may run in any order; only the set matters.
					const expected = model.events.slice(before).sort();
					const actual = events.splice(0).sort();
					expect(actual).toEqual(expected);
					expect(queue.size).toBe(model.size);
					expect(queue.peakSize).toBeLessThanOrEqual(capacity);
				}
			},
		),
		{ numRuns: 500 },
	);
});
