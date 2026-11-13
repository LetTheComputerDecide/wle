import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { BoundedQueue } from "./queue.ts";
import { errorRecord, type FetchedItem, type PageRecord } from "./records.ts";

/**
 * Turns a page's markup into absolute links; `extractLinks` by default. Throwing marks
 * that one page as a `parse` error.
 */
export type LinkExtractor = (html: string, pageUrl: string) => string[];

/**
 * Parses pages from the queue until it is closed and drained, emitting one record per
 * page. A page that fails to parse becomes an error record; the next page is unaffected.
 */
export async function consume(
	queue: BoundedQueue<FetchedItem>,
	extract: LinkExtractor,
	emit: (record: PageRecord) => void,
): Promise<void> {
	for await (const { html, ...pageMetadata } of queue) {
		let record: PageRecord;
		try {
			const links = extract(html, pageMetadata.finalUrl);
			const { inputIndex, url, ...fetchDetails } = pageMetadata;
			record = { inputIndex, url, status: "ok", ...fetchDetails, links };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record = errorRecord(pageMetadata, "parse", message);
		}
		emit(record);
		// Parsing is synchronous; yielding lets fetches progress while a backlog drains.
		await yieldToEventLoop();
	}
}
