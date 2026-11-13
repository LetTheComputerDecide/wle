/** A successfully fetched HTML page. */
export interface FetchedPage {
	/** URL after following redirects; links on the page resolve against it. */
	finalUrl: string;
	/** Status of the final response; always 2xx. */
	httpStatus: number;
	/** The decoded markup. */
	html: string;
}

/**
 * Fetches the markup of one page in a single attempt. Implementations reject with a
 * `FetchError`; retries and concurrency limits are applied by the caller.
 *
 * This is the extension point for other strategies, such as rendering SPAs in a
 * headless browser.
 */
export interface Fetcher {
	/**
	 * @param url - An absolute `http:` or `https:` URL.
	 * @param signal - Aborted when the run is interrupted; implementations should stop
	 * promptly and reject with kind `aborted`.
	 * @throws {FetchError} (as a rejection) On any failure. Other errors are treated as
	 * `network` failures.
	 */
	fetch(url: URL, signal: AbortSignal): Promise<FetchedPage>;
}
