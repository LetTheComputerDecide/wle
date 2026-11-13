// Library entry point: the CLI is one consumer of these.
export {
	type Config,
	ConfigError,
	type ConfigInput,
	configSchema,
	loadConfig,
	toPipelineOptions,
} from "./config.ts";
export type { LinkExtractor } from "./consumer.ts";
export {
	type ErrorKind,
	FetchError,
	type FetchErrorDetails,
} from "./errors.ts";
export { extractLinks } from "./extract.ts";
export { StaticFetcher, type StaticFetcherOptions } from "./fetcher/static.ts";
export type { FetchedPage, Fetcher } from "./fetcher/types.ts";
export {
	type PipelineDeps,
	type PipelineOptions,
	runPipeline,
} from "./pipeline.ts";
export {
	BoundedQueue,
	type BoundedQueueOptions,
	type OverflowPolicy,
	QueueClosedError,
} from "./queue.ts";
export type { ErrorRecord, OkRecord, PageRecord } from "./records.ts";
export type { RetryDeps, RetryPolicy } from "./retry.ts";
export type { Summary } from "./summary.ts";
export { VERSION } from "./version.ts";
