import { describe, expect, test, vi } from "vitest";
import { FetchError } from "../src/errors.ts";
import { withRetry } from "../src/retry.ts";

const noSleep = () => vi.fn(async (_ms: number, _signal: AbortSignal) => {});

const policy = { retries: 2, baseDelayMs: 100, maxDelayMs: 1000 };
const signal = () => new AbortController().signal;

/** An attempt that fails with the given errors in turn, then succeeds. */
function failingThen(...errors: FetchError[]) {
	let calls = 0;
	return vi.fn(async () => {
		const error = errors[calls++];
		if (error) {
			throw error;
		}
		return "page";
	});
}

const network = () => new FetchError("network", "ECONNRESET");
const status = (httpStatus: number, retryAfterMs?: number) =>
	new FetchError("http_status", `HTTP ${httpStatus}`, {
		httpStatus,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	});

describe("withRetry", () => {
	test("returns the first success without sleeping", async () => {
		const sleep = noSleep();
		const result = await withRetry(failingThen(), policy, signal(), { sleep });
		expect(result).toEqual({ ok: true, value: "page", attempts: 1 });
		expect(sleep).not.toHaveBeenCalled();
	});

	test.each([
		["network", network()],
		["timeout", new FetchError("timeout", "slow")],
		["429", status(429)],
		["503", status(503)],
	])("retries a %s failure", async (_, error) => {
		const sleep = noSleep();
		const result = await withRetry(failingThen(error), policy, signal(), {
			sleep,
		});
		expect(result).toEqual({ ok: true, value: "page", attempts: 2 });
	});

	test.each([
		["404", status(404)],
		["not_html", new FetchError("not_html", "image/png")],
		["too_large", new FetchError("too_large", "big")],
	])("does not retry a %s failure", async (_, error) => {
		const attempt = failingThen(error);
		const result = await withRetry(attempt, policy, signal(), {
			sleep: async () => {},
		});
		expect(result).toEqual({ ok: false, error, attempts: 1 });
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	test("gives up after the configured number of retries", async () => {
		const last = network();
		const attempt = failingThen(network(), network(), last, network());
		const result = await withRetry(attempt, policy, signal(), {
			sleep: async () => {},
		});
		expect(result).toEqual({ ok: false, error: last, attempts: 3 });
	});

	test("retries zero times when configured to", async () => {
		const result = await withRetry(
			failingThen(network()),
			{ ...policy, retries: 0 },
			signal(),
			{ sleep: async () => {} },
		);
		expect(result).toMatchObject({ ok: false, attempts: 1 });
	});

	test("backs off exponentially with full jitter, capped at maxDelayMs", async () => {
		const sleep = noSleep();
		await withRetry(
			failingThen(network(), network(), network(), network(), network()),
			{ retries: 5, baseDelayMs: 100, maxDelayMs: 1000 },
			signal(),
			{ sleep, random: () => 0.5 },
		);
		const delays = sleep.mock.calls.map(([ms]) => ms);
		// Ceilings are 100, 200, 400, 800, then capped at 1000; jitter takes half of each.
		expect(delays).toEqual([50, 100, 200, 400, 500]);
	});

	test("honours Retry-After instead of the backoff", async () => {
		const sleep = noSleep();
		await withRetry(failingThen(status(503, 750)), policy, signal(), {
			sleep,
			random: () => 0,
		});
		expect(sleep).toHaveBeenCalledWith(750, expect.any(AbortSignal));
	});

	test("gives up when Retry-After exceeds maxDelayMs", async () => {
		const sleep = noSleep();
		const error = status(429, 60_000);
		const result = await withRetry(failingThen(error), policy, signal(), {
			sleep,
		});
		expect(result).toEqual({ ok: false, error, attempts: 1 });
		expect(sleep).not.toHaveBeenCalled();
	});

	test("wraps non-FetchError throws as network errors", async () => {
		const result = await withRetry(
			async () => {
				throw new TypeError("boom");
			},
			{ ...policy, retries: 0 },
			signal(),
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatchObject({
			kind: "network",
			message: "boom",
		});
	});

	test("stops retrying once aborted during an attempt", async () => {
		const controller = new AbortController();
		const attempt = vi.fn(async () => {
			controller.abort();
			throw network();
		});
		const result = await withRetry(attempt, policy, controller.signal, {
			sleep: async () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			attempts: 1,
			error: { kind: "aborted" },
		});
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	test("stops retrying once aborted during backoff, using the real sleep", async () => {
		const controller = new AbortController();
		const attempt = failingThen(network(), network());
		setTimeout(() => controller.abort(), 20);
		const result = await withRetry(
			attempt,
			{ retries: 2, baseDelayMs: 10_000, maxDelayMs: 10_000 },
			controller.signal,
			{ random: () => 0.99 },
		);
		expect(result).toMatchObject({
			ok: false,
			attempts: 1,
			error: { kind: "aborted" },
		});
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	test("keeps an aborted error from the attempt as is", async () => {
		const controller = new AbortController();
		const aborted = new FetchError("aborted", "cancelled");
		const result = await withRetry(
			async () => {
				controller.abort();
				throw aborted;
			},
			policy,
			controller.signal,
		);
		expect(result).toEqual({ ok: false, error: aborted, attempts: 1 });
	});
});
