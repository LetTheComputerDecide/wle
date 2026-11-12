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

export interface FetchErrorDetails {
	httpStatus?: number;
	/** Server-requested delay before retrying, from a `Retry-After` header. */
	retryAfterMs?: number;
	cause?: unknown;
}

export class FetchError extends Error {
	readonly kind: ErrorKind;
	readonly httpStatus: number | undefined;
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

/** Coerces anything thrown into a `FetchError`, so callers deal with one shape. */
export function toFetchError(error: unknown, fallback: ErrorKind): FetchError {
	if (error instanceof FetchError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new FetchError(fallback, message, { cause: error });
}
