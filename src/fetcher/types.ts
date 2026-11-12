export interface FetchedPage {
	/** URL after following redirects; links on the page resolve against it. */
	finalUrl: string;
	httpStatus: number;
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
	fetch(url: URL, signal: AbortSignal): Promise<FetchedPage>;
}
