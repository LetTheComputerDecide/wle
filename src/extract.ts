import { Parser } from "htmlparser2";

/** Schemes that run or inline content rather than point at a resource. */
const IGNORED_PROTOCOLS = new Set(["javascript:", "data:", "vbscript:"]);

/**
 * Returns the hyperlinks (`<a href>`) in `html` as absolute URLs, in first-seen order
 * and without duplicates.
 *
 * Links resolve against the document's first `<base href>`, itself resolved against
 * `pageUrl`. Fragments are stripped, and fragment-only, empty, unparseable and
 * script-like (`javascript:`, `data:`, `vbscript:`) links are skipped.
 *
 * Malformed markup is tolerated, as browsers do; this does not throw on bad HTML.
 *
 * @param html - The page's markup.
 * @param pageUrl - The URL the markup was served from, after redirects.
 * @returns Absolute URLs, e.g. `["https://example.com/about"]` for `<a href="/about">`.
 * @throws {TypeError} If `pageUrl` is not an absolute URL.
 */
export function extractLinks(html: string, pageUrl: string | URL): string[] {
	const hrefs: string[] = [];
	let baseHref: string | undefined;

	const parser = new Parser({
		onopentag(name, attributes) {
			const href = attributes.href;
			if (href === undefined) {
				return;
			}
			if (name === "a") {
				hrefs.push(href);
			} else if (name === "base" && baseHref === undefined) {
				// Browsers use only the first <base href>.
				baseHref = href;
			}
		},
	});
	parser.end(html);

	const baseUrl = resolveBase(baseHref, pageUrl);
	const links = new Set<string>();
	for (const href of hrefs) {
		const link = normalise(href, baseUrl);
		if (link !== undefined) {
			links.add(link);
		}
	}
	return [...links];
}

function resolveBase(baseHref: string | undefined, pageUrl: string | URL): URL {
	const parsedPageUrl = new URL(pageUrl);
	if (baseHref === undefined) {
		return parsedPageUrl;
	}
	// An unparseable <base> is ignored, as a browser would, rather than dropping every link.
	return URL.parse(baseHref, parsedPageUrl) ?? parsedPageUrl;
}

function normalise(href: string, baseUrl: URL): string | undefined {
	const trimmed = href.trim();
	// Browsers trim whitespace from href. Fragment-only links point back at this page.
	if (trimmed === "" || trimmed.startsWith("#")) {
		return undefined;
	}
	const url = URL.parse(trimmed, baseUrl);
	if (url === null || IGNORED_PROTOCOLS.has(url.protocol)) {
		return undefined;
	}
	// `/a#x` and `/a#y` are the same resource, so they de-duplicate to one link.
	url.hash = "";
	return url.href;
}
