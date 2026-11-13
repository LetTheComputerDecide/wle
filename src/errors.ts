/**
 * Why a URL has no links. Every error record carries exactly one kind.
 *
 * - `invalid_url`: not an absolute `http:` or `https:` URL; never fetched.
 * - `timeout`: an attempt exceeded the timeout, including reading the body.
 * - `network`: DNS, connection or TLS failure.
 * - `http_status`: the final response was not 2xx.
 * - `not_html`: the `Content-Type` is not HTML.
 * - `too_large`: the body exceeded the size limit.
 * - `parse`: link extraction threw.
 * - `dropped`: evicted from the full queue under the `drop-oldest` policy.
 * - `aborted`: the run was interrupted before the URL finished.
 */
export type ErrorKind =
	| "invalid_url"
	| "timeout"
	| "network"
	| "http_status"
	| "not_html"
	| "too_large"
	| "parse"
	| "dropped"
	| "aborted";

/** Optional context for a {@link FetchError}. */
export interface FetchErrorDetails {
	/** Status of the response that caused the error, if one was received. */
	httpStatus?: number;
	/** Server-requested delay before retrying, from a `Retry-After` header. */
	retryAfterMs?: number;
	/** The underlying error, kept as the standard `Error.cause`. */
	cause?: unknown;
}

/**
 * A failure to fetch one page, classified by {@link ErrorKind}. {@link Fetcher}
 * implementations reject with this so retries and records can act on the kind.
 */
export class FetchError extends Error {
	readonly kind: ErrorKind;
	/** Status of the response that caused the error, if one was received. */
	readonly httpStatus: number | undefined;
	/** Server-requested delay before retrying, from a `Retry-After` header. */
	readonly retryAfterMs: number | undefined;

	constructor(
		kind: ErrorKind,
		message: string,
		details: FetchErrorDetails = {},
	) {
		super(message, { cause: details.cause });
		this.name = "FetchError";
		this.kind = kind;
		this.httpStatus = details.httpStatus;
		this.retryAfterMs = details.retryAfterMs;
	}

	/** Transient failures: network errors, timeouts, 5xx and 429. */
	get retryable(): boolean {
		if (this.kind === "network" || this.kind === "timeout") {
			return true;
		}
		const status = this.httpStatus;
		return (
			this.kind === "http_status" &&
			status !== undefined &&
			(status === 429 || status >= 500)
		);
	}
}

/**
 * Coerces anything thrown into a `FetchError`, so callers deal with one shape.
 *
 * @param fallback - Kind given to errors that are not already a `FetchError`.
 */
export function toFetchError(error: unknown, fallback: ErrorKind): FetchError {
	if (error instanceof FetchError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new FetchError(fallback, message, { cause: error });
}
