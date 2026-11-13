import type { ErrorKind } from "./errors.ts";

interface RecordBase {
	/** Position of the URL in the input, from 0. */
	index: number;
	/** The URL exactly as given in the input. */
	url: string;
	/** Fetch attempts made; 0 when the URL was rejected before fetching. */
	attempts: number;
	/** Time spent fetching, including waits for a host slot, retries and backoff; excludes time on the queue. */
	durationMs: number;
}

/** A page that was fetched and parsed. */
export interface OkRecord extends RecordBase {
	status: "ok";
	/** URL after following redirects. */
	finalUrl: string;
	httpStatus: number;
	/** Absolute, de-duplicated links in document order; see `extractLinks`. */
	links: string[];
}

/** A URL that produced no links, and why. */
export interface ErrorRecord extends RecordBase {
	status: "error";
	/** URL after following redirects, when the page was fetched. */
	finalUrl?: string;
	/** Status of the last response, when one was received. */
	httpStatus?: number;
	error: {
		kind: ErrorKind;
		/** Human-readable detail; its wording is not part of the API. */
		message: string;
	};
}

/**
 * The outcome for one input URL. Every input produces exactly one record, including
 * duplicates and invalid URLs. Records are emitted in completion order, not input
 * order; sort by `index` to restore it. Narrow on `status`.
 */
export type PageRecord = OkRecord | ErrorRecord;

/** Markup fetched by the producer, waiting on the queue to be parsed. */
export interface FetchedItem {
	index: number;
	url: string;
	finalUrl: string;
	httpStatus: number;
	html: string;
	attempts: number;
	durationMs: number;
}

/** Builds an error record, keeping the key order used by the other records. */
export function errorRecord(
	{
		index,
		url,
		...rest
	}: RecordBase & { finalUrl?: string; httpStatus?: number },
	kind: ErrorKind,
	message: string,
): ErrorRecord {
	// Key order is cosmetic but makes JSONL output easier to scan.
	return { index, url, status: "error", ...rest, error: { kind, message } };
}
