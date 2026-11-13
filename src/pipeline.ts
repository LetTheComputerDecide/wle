import { consume, type LinkExtractor } from "./consumer.ts";
import { extractLinks } from "./extract.ts";
import type { Fetcher } from "./fetcher/types.ts";
import { produce } from "./producer.ts";
import { BoundedQueue, type OverflowPolicy } from "./queue.ts";
import { errorRecord, type FetchedItem, type PageRecord } from "./records.ts";
import type { RetryDeps, RetryPolicy } from "./retry.ts";
import { type Summary, SummaryCollector } from "./summary.ts";

/** Tuning for {@link runPipeline}. `toPipelineOptions` builds this from a `Config`. */
export interface PipelineOptions {
	/** Maximum fetches in flight, across all hosts. Also bounds how far ahead inputs are read. */
	concurrency: number;
	/** Maximum fetches in flight to any one host. */
	perHostConcurrency: number;
	/** Number of concurrent consumers parsing pages from the queue. */
	consumers: number;
	/** Fetched pages buffered between the producer and the consumers. */
	queueCapacity: number;
	/** What happens when the queue is full. Evicted pages get a `dropped` record. */
	overflow: OverflowPolicy;
	retry: RetryPolicy;
}

/** Collaborators for {@link runPipeline}. Only `fetcher` and `sink` are required. */
export interface PipelineDeps {
	/** Fetches each page; usually a `StaticFetcher`. */
	fetcher: Fetcher;
	/** Receives every record. Throwing from it is treated as fatal and aborts the run. */
	sink: (record: PageRecord) => void;
	/** Aborting stops reading inputs and cancels fetches in flight; queued pages are still parsed. */
	signal?: AbortSignal;
	/** Monotonic clock in milliseconds, for `durationMs`. Defaults to `performance.now`. */
	now?: () => number;
	/** Defaults to `extractLinks`. */
	extract?: LinkExtractor;
	/** Overrides retry timing; for tests. */
	retryDeps?: RetryDeps;
}

/**
 * Runs the producer and `consumers` consumers concurrently over a shared bounded queue,
 * resolving with a summary once every input has a record.
 *
 * Inputs are read lazily, so an endless or very large source is fine. Per-URL failures
 * never reject; they become error records. Records reach `sink` in completion order.
 *
 * @param inputs - URLs as strings; anything that is not an absolute http(s) URL gets an
 * `invalid_url` record.
 * @returns Counts and timings for the run, also when it was aborted through `signal`.
 * @throws The first fatal error (as a rejection): the `sink`, the input iterable or a
 * consumer throwing. The run is cancelled and work in flight settles before rejecting.
 *
 * @example
 * ```ts
 * const summary = await runPipeline(
 *   ["https://example.com/"],
 *   toPipelineOptions(configSchema.parse({})),
 *   {
 *     fetcher: new StaticFetcher({ timeoutMs: 10_000, maxBodyBytes: 5e6, userAgent: "me" }),
 *     sink: (record) => console.log(record),
 *   },
 * );
 * ```
 */
export async function runPipeline(
	inputs: Iterable<string> | AsyncIterable<string>,
	options: PipelineOptions,
	deps: PipelineDeps,
): Promise<Summary> {
	const summary = new SummaryCollector();
	const controller = new AbortController();
	const signal = deps.signal
		? AbortSignal.any([deps.signal, controller.signal])
		: controller.signal;

	// Wrapped so that even a thrown `undefined` counts as a failure.
	let fatalFailure: { error: unknown } | undefined;
	// `queue` is declared below; this only runs after it is initialised.
	const fail = (error: unknown) => {
		if (fatalFailure) {
			return;
		}
		fatalFailure = { error };
		controller.abort(error);
		// Keep the queue moving so a producer blocked on a full queue can finish.
		void (async () => {
			for await (const _discardedPage of queue) {
				// Discard.
			}
		})();
	};

	const emit = (record: PageRecord) => {
		// After a fatal error the sink may be broken, and the run is failing anyway.
		if (fatalFailure) {
			return;
		}
		summary.add(record);
		try {
			deps.sink(record);
		} catch (error) {
			fail(error);
			// Also unwind the caller, so a producer task or consumer stops right away.
			throw error;
		}
	};

	const queue = new BoundedQueue<FetchedItem>({
		capacity: options.queueCapacity,
		overflow: options.overflow,
		// The evicted page's HTML is discarded; its record carries only the metadata.
		onDrop: ({ html: _, ...evictedPage }) =>
			emit(
				errorRecord(
					evictedPage,
					"dropped",
					"Evicted from the full queue (drop-oldest)",
				),
			),
	});

	const producer = produce(inputs, options, {
		fetcher: deps.fetcher,
		queue,
		emit,
		signal,
		now: deps.now ?? performance.now.bind(performance),
		...(deps.retryDeps ? { retryDeps: deps.retryDeps } : {}),
	})
		.catch(fail)
		// Closed whether the producer succeeded or not, so consumers always drain and end.
		.finally(() => queue.close());

	const extract = deps.extract ?? extractLinks;
	const consumers = Array.from({ length: options.consumers }, () =>
		consume(queue, extract, emit).catch(fail),
	);

	await Promise.all([producer, ...consumers]);
	if (fatalFailure) {
		throw fatalFailure.error;
	}
	return summary.finish(queue.peakSize);
}
