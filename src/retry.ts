import { setTimeout as delay } from "node:timers/promises";
import { FetchError, toFetchError } from "./errors.ts";

/** How transient fetch failures are retried. See {@link withRetry}. */
export interface RetryPolicy {
	/** Extra attempts after the first. */
	retries: number;
	/** Backoff ceiling for the first retry; it doubles with each further retry. */
	baseDelayMs: number;
	/** Largest backoff, and the longest `Retry-After` honoured. */
	maxDelayMs: number;
}

/** Replaceable timing primitives, so tests can run retries without real waits. */
export interface RetryDeps {
	/** Resolves after `ms`, or rejects once `signal` aborts. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Returns a number in [0, 1), for jitter. */
	random?: () => number;
}

/** Outcome of {@link withRetry}, with the number of attempts made either way. */
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
 *
 * @param attempt - One try. Errors that are not a `FetchError` count as `network`.
 * @param signal - Aborting stops further attempts; the result then has kind `aborted`.
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

		// Checked before `retryable`: a fetch cut off by the abort can look like a network
		// error, which would otherwise be retried.
		if (signal.aborted) {
			return { ok: false, error: abortedError(error), attempts };
		}
		// `attempts` counts tries so far, so `retries: 2` allows three in total.
		if (!error.retryable || attempts > policy.retries) {
			return { ok: false, error, attempts };
		}

		const backoff = Math.min(
			policy.maxDelayMs,
			policy.baseDelayMs * 2 ** (attempts - 1),
		);
		// A server's Retry-After replaces the jittered backoff.
		const wait = error.retryAfterMs ?? random() * backoff;
		if (wait > policy.maxDelayMs) {
			return { ok: false, error, attempts };
		}
		try {
			await sleep(wait, signal);
		} catch {
			// `sleep` only rejects when the signal aborts.
			return { ok: false, error: abortedError(error), attempts };
		}
	}
}

function abortedError(cause: FetchError): FetchError {
	return cause.kind === "aborted"
		? cause
		: new FetchError("aborted", "Aborted while retrying", { cause });
}
