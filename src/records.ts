import type { ErrorKind } from "./errors.ts";

interface RecordBase {
	/** Position of the URL in the input, from 0. */
	index: number;
	url: string;
	/** Fetch attempts made; 0 when the URL was rejected before fetching. */
	attempts: number;
	durationMs: number;
}

export interface OkRecord extends RecordBase {
	status: "ok";
	finalUrl: string;
	httpStatus: number;
	links: string[];
}

export interface ErrorRecord extends RecordBase {
	status: "error";
	finalUrl?: string;
	httpStatus?: number;
	error: { kind: ErrorKind; message: string };
}

/** The outcome for one input URL. Every input produces exactly one record. */
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

export function errorRecord(
	base: RecordBase & { finalUrl?: string; httpStatus?: number },
	kind: ErrorKind,
	message: string,
): ErrorRecord {
	return { ...base, status: "error", error: { kind, message } };
}
