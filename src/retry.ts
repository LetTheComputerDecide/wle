import { setTimeout as delay } from "node:timers/promises";
import { FetchError, toFetchError } from "./errors.ts";

export interface RetryPolicy {
	/** Extra attempts after the first. */
	retries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface RetryDeps {
	/** Resolves after `ms`, or rejects once `signal` aborts. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Returns a number in [0, 1), for jitter. */
	random?: () => number;
}

export type RetryResult<T> =
	| { ok: true; value: T; attempts: number }
	| { ok: false; error: FetchError; attempts: number };

const defaultSleep = (ms: number, signal: AbortSignal) =>
	delay(ms, undefined, { signal });

/**
 * Runs `attempt` until it succeeds, fails with a non-retryable error, or runs out of
 * retries. Never rejects: the outcome, including the final error, is in the result.
 *
 * Backoff is "full jitter": a random delay up to `baseDelayMs * 2^n`, capped at
 * `maxDelayMs`. A server-provided `Retry-After` is honoured exactly; if it asks for
 * longer than `maxDelayMs`, the request gives up instead of stalling.
 */
export async function withRetry<T>(
	attempt: () => Promise<T>,
	policy: RetryPolicy,
	signal: AbortSignal,
	deps: RetryDeps = {},
): Promise<RetryResult<T>> {
	const sleep = deps.sleep ?? defaultSleep;
	const random = deps.random ?? Math.random;

	for (let attempts = 1; ; attempts++) {
		let error: FetchError;
		try {
			return { ok: true, value: await attempt(), attempts };
		} catch (thrown) {
			error = toFetchError(thrown, "network");
		}

		if (signal.aborted) {
			return { ok: false, error: abortedError(error), attempts };
		}
		if (!error.retryable || attempts > policy.retries) {
			return { ok: false, error, attempts };
		}

		const backoff = Math.min(
			policy.maxDelayMs,
			policy.baseDelayMs * 2 ** (attempts - 1),
		);
		const wait = error.retryAfterMs ?? random() * backoff;
		if (wait > policy.maxDelayMs) {
			return { ok: false, error, attempts };
		}
		try {
			await sleep(wait, signal);
		} catch {
			return { ok: false, error: abortedError(error), attempts };
		}
	}
}

function abortedError(cause: FetchError): FetchError {
	return cause.kind === "aborted"
		? cause
		: new FetchError("aborted", "Aborted while retrying", { cause });
}
