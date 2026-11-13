import pLimit, { type LimitFunction } from "p-limit";
import type { Fetcher } from "./fetcher/types.ts";
import type { BoundedQueue } from "./queue.ts";
import { errorRecord, type FetchedItem, type PageRecord } from "./records.ts";
import { type RetryDeps, type RetryPolicy, withRetry } from "./retry.ts";

export interface ProducerOptions {
	/** Maximum fetches in flight, across all hosts. */
	concurrency: number;
	/** Maximum fetches in flight to any one host. */
	perHostConcurrency: number;
	retry: RetryPolicy;
}

export interface ProducerDeps {
	fetcher: Fetcher;
	queue: BoundedQueue<FetchedItem>;
	/** Receives records for URLs that never reach the queue. */
	emit: (record: PageRecord) => void;
	signal: AbortSignal;
	now: () => number;
	retryDeps?: RetryDeps;
}

/**
 * Fetches every input URL and puts the markup on the queue. Inputs are read lazily, no
 * further ahead than the concurrency limit, so large inputs are never held in memory.
 * Failures become error records and never stop the other URLs. Stops reading new
 * inputs once `signal` aborts. Only an unexpected error, such as the sink throwing, rejects;
 * in-flight URLs are allowed to settle first. Does not close the queue.
 */
export async function produce(
	inputs: Iterable<string> | AsyncIterable<string>,
	options: ProducerOptions,
	deps: ProducerDeps,
): Promise<void> {
	const inFlight = new Set<Promise<void>>();
	const hostLimiters = new HostLimiters(options.perHostConcurrency);
	let failure: { error: unknown } | undefined;
	let nextInputIndex = 0;

	for await (const input of inputs) {
		// A fatal error elsewhere: stop reading. Breaking also closes the input iterator.
		if (failure) {
			break;
		}
		if (deps.signal.aborted) {
			// Already read from the input, so it still gets a record.
			deps.emit(
				errorRecord(
					{
						inputIndex: nextInputIndex,
						url: input,
						attempts: 0,
						durationMs: 0,
					},
					"aborted",
					"Aborted before fetching",
				),
			);
			break;
		}
		// Tasks never reject: the first error is kept and rethrown once all have settled.
		// Otherwise a rejection would end the race below while siblings were still running,
		// and their later rejections would go unhandled.
		const task = produceOne(
			nextInputIndex++,
			input,
			options,
			deps,
			hostLimiters,
		)
			.catch((error: unknown) => {
				failure ??= { error };
			})
			// Runs asynchronously, so `task` is assigned by the time this callback reads it.
			.finally(() => inFlight.delete(task));
		inFlight.add(task);
		// The window: once `concurrency` URLs are in flight, wait for any one to finish
		// before reading the next input. This is both the global fetch limit and the bound
		// on read-ahead. A URL waiting on a busy host still holds a slot, so one slow host
		// can hold up the others (head-of-line blocking, see README).
		if (inFlight.size >= options.concurrency) {
			await Promise.race(inFlight);
		}
	}
	await Promise.all(inFlight);
	if (failure) {
		throw failure.error;
	}
}

async function produceOne(
	inputIndex: number,
	input: string,
	options: ProducerOptions,
	deps: ProducerDeps,
	hostLimiters: HostLimiters,
): Promise<void> {
	const url = parseHttpUrl(input);
	if (typeof url === "string") {
		deps.emit(
			errorRecord(
				{ inputIndex, url: input, attempts: 0, durationMs: 0 },
				"invalid_url",
				url,
			),
		);
		return;
	}

	const started = deps.now();
	// The host slot is taken per attempt, so it is free while a retry backs off.
	const result = await withRetry(
		() =>
			hostLimiters.run(url.host, () => deps.fetcher.fetch(url, deps.signal)),
		options.retry,
		deps.signal,
		deps.retryDeps,
	);
	const recordFields = {
		inputIndex,
		url: input,
		attempts: result.attempts,
		durationMs: Math.round(deps.now() - started),
	};

	if (!result.ok) {
		const { error } = result;
		deps.emit(
			errorRecord(
				error.httpStatus === undefined
					? recordFields
					: { ...recordFields, httpStatus: error.httpStatus },
				error.kind,
				error.message,
			),
		);
		return;
	}
	// Under the `block` policy this waits while the queue is full. The task keeps its slot
	// in the window meanwhile, so slow consumers throttle fetching (backpressure).
	await deps.queue.put({ ...recordFields, ...result.value });
}

/** Returns the parsed URL, or a message explaining why the input was rejected. */
function parseHttpUrl(input: string): URL | string {
	const url = URL.parse(input);
	if (url === null) {
		return "Not a valid absolute URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `Unsupported protocol ${url.protocol}`;
	}
	return url;
}

/** One limiter per host, discarded once idle so the map does not grow without bound. */
class HostLimiters {
	readonly #concurrency: number;
	readonly #limiters = new Map<string, LimitFunction>();

	constructor(concurrency: number) {
		this.#concurrency = concurrency;
	}

	async run<T>(host: string, operation: () => Promise<T>): Promise<T> {
		let limiter = this.#limiters.get(host);
		if (!limiter) {
			limiter = pLimit(this.#concurrency);
			this.#limiters.set(host, limiter);
		}
		try {
			return await limiter(operation);
		} finally {
			// p-limit lowers `activeCount` before the caller resumes, so this sees the call
			// above as finished. Calls still queued for the host keep the limiter alive.
			if (limiter.activeCount === 0 && limiter.pendingCount === 0) {
				this.#limiters.delete(host);
			}
		}
	}
}
