import { consume, type LinkExtractor } from "./consumer.ts";
import { extractLinks } from "./extract.ts";
import type { Fetcher } from "./fetcher/types.ts";
import { produce } from "./producer.ts";
import { BoundedQueue, type OverflowPolicy } from "./queue.ts";
import { errorRecord, type FetchedItem, type PageRecord } from "./records.ts";
import type { RetryDeps, RetryPolicy } from "./retry.ts";
import { type Summary, SummaryCollector } from "./summary.ts";

export interface PipelineOptions {
	concurrency: number;
	perHostConcurrency: number;
	consumers: number;
	queueCapacity: number;
	overflow: OverflowPolicy;
	retry: RetryPolicy;
}

export interface PipelineDeps {
	fetcher: Fetcher;
	/** Receives every record. Throwing from it is treated as fatal and aborts the run. */
	sink: (record: PageRecord) => void;
	/** Aborting stops reading inputs and cancels fetches in flight; queued pages are still parsed. */
	signal?: AbortSignal;
	now?: () => number;
	extract?: LinkExtractor;
	retryDeps?: RetryDeps;
}

/**
 * Runs the producer and `consumers` consumers concurrently over a shared bounded queue,
 * resolving with a summary once every input has a record.
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

	let fatal: { error: unknown } | undefined;
	const fail = (error: unknown) => {
		if (fatal) {
			return;
		}
		fatal = { error };
		controller.abort(error);
		// Keep the queue moving so a producer blocked on a full queue can finish.
		void (async () => {
			for await (const _ of queue) {
				// Discard.
			}
		})();
	};

	const emit = (record: PageRecord) => {
		if (fatal) {
			return;
		}
		summary.add(record);
		try {
			deps.sink(record);
		} catch (error) {
			fail(error);
			throw error;
		}
	};

	const queue = new BoundedQueue<FetchedItem>({
		capacity: options.queueCapacity,
		overflow: options.overflow,
		onDrop: ({ html: _, ...item }) =>
			emit(
				errorRecord(
					item,
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
		.finally(() => queue.close());

	const extract = deps.extract ?? extractLinks;
	const consumers = Array.from({ length: options.consumers }, () =>
		consume(queue, extract, emit).catch(fail),
	);

	await Promise.all([producer, ...consumers]);
	if (fatal) {
		throw fatal.error;
	}
	return summary.finish(queue.peakSize);
}
