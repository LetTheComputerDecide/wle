// Library entry point: the CLI is one consumer of these.
export {
	type Config,
	configSchema,
	loadConfig,
	toPipelineOptions,
} from "./config.ts";
export { type ErrorKind, FetchError } from "./errors.ts";
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
	type OverflowPolicy,
	QueueClosedError,
} from "./queue.ts";
export type { ErrorRecord, OkRecord, PageRecord } from "./records.ts";
export type { Summary } from "./summary.ts";
export { VERSION } from "./version.ts";
