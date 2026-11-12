import { FetchError } from "../errors.ts";
import type { FetchedPage, Fetcher } from "./types.ts";

export interface StaticFetcherOptions {
	timeoutMs: number;
	maxBodyBytes: number;
	userAgent: string;
}

const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** Fetches raw markup over HTTP with the built-in `fetch`. Does not run JavaScript. */
export class StaticFetcher implements Fetcher {
	readonly #options: StaticFetcherOptions;

	constructor(options: StaticFetcherOptions) {
		this.#options = options;
	}

	async fetch(url: URL, signal: AbortSignal): Promise<FetchedPage> {
		const timeout = AbortSignal.timeout(this.#options.timeoutMs);
		const combined = AbortSignal.any([signal, timeout]);
		try {
			const response = await fetch(url, {
				signal: combined,
				redirect: "follow",
				headers: {
					"user-agent": this.#options.userAgent,
					accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
				},
			});
			return await this.#read(response);
		} catch (error) {
			if (timeout.aborted) {
				throw new FetchError(
					"timeout",
					`Timed out after ${this.#options.timeoutMs} ms`,
					{ cause: error },
				);
			}
			if (signal.aborted) {
				throw new FetchError("aborted", "Fetch was aborted", { cause: error });
			}
			if (error instanceof FetchError) {
				throw error;
			}
			throw new FetchError("network", describeNetworkError(error), {
				cause: error,
			});
		}
	}

	async #read(response: Response): Promise<FetchedPage> {
		const { status } = response;
		if (!response.ok) {
			await response.body?.cancel();
			const details: { httpStatus: number; retryAfterMs?: number } = {
				httpStatus: status,
			};
			const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
			if (retryAfterMs !== undefined) {
				details.retryAfterMs = retryAfterMs;
			}
			throw new FetchError("http_status", `HTTP ${status}`, details);
		}

		const contentType = parseContentType(response.headers.get("content-type"));
		// A missing Content-Type is treated as HTML rather than rejected; sniffing is out of scope.
		if (contentType && !HTML_MEDIA_TYPES.has(contentType.mediaType)) {
			await response.body?.cancel();
			throw new FetchError(
				"not_html",
				`Content-Type is ${contentType.mediaType}`,
				{ httpStatus: status },
			);
		}

		const bytes = await readCapped(response, this.#options.maxBodyBytes);
		return {
			finalUrl: response.url,
			httpStatus: status,
			html: decode(bytes, contentType?.charset),
		};
	}
}

async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const tooLarge = () =>
		new FetchError("too_large", `Body exceeds ${maxBytes} bytes`, {
			httpStatus: response.status,
		});

	const declared = Number(response.headers.get("content-length"));
	if (declared > maxBytes) {
		await response.body?.cancel();
		throw tooLarge();
	}
	if (!response.body) {
		return new Uint8Array();
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.byteLength;
		if (total > maxBytes) {
			// Leaving the loop early cancels the stream, so the rest is never downloaded.
			throw tooLarge();
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, total);
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset ?? "utf-8");
	} catch {
		decoder = new TextDecoder("utf-8");
	}
	return decoder.decode(bytes);
}

export function parseContentType(
	header: string | null,
): { mediaType: string; charset?: string } | undefined {
	if (!header) {
		return undefined;
	}
	const [type = "", ...params] = header.split(";");
	const mediaType = type.trim().toLowerCase();
	for (const param of params) {
		const [name, value] = param.split("=", 2);
		if (name?.trim().toLowerCase() === "charset" && value) {
			return { mediaType, charset: value.trim().replace(/^"|"$/g, "") };
		}
	}
	return { mediaType };
}

/** Parses `Retry-After` as delay-seconds or an HTTP date. */
export function parseRetryAfter(
	header: string | null,
	now: number = Date.now(),
): number | undefined {
	if (header === null) {
		return undefined;
	}
	const value = header.trim();
	if (/^\d+$/.test(value)) {
		return Number(value) * 1000;
	}
	// HTTP dates always end in "GMT"; this keeps Date.parse from accepting things like "-5".
	const date = value.endsWith("GMT") ? Date.parse(value) : Number.NaN;
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function describeNetworkError(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	// undici reports "fetch failed" and puts the useful detail (ECONNREFUSED, ENOTFOUND...) in `cause`.
	const cause = error.cause;
	if (cause instanceof Error) {
		const code = (cause as { code?: unknown }).code;
		return typeof code === "string"
			? `${error.message}: ${code}`
			: `${error.message}: ${cause.message}`;
	}
	return error.message;
}
