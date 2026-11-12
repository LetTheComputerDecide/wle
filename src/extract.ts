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
				baseHref = href;
			}
		},
	});
	parser.end(html);

	const base = resolveBase(baseHref, pageUrl);
	const links = new Set<string>();
	for (const href of hrefs) {
		const link = normalise(href, base);
		if (link !== undefined) {
			links.add(link);
		}
	}
	return [...links];
}

function resolveBase(baseHref: string | undefined, pageUrl: string | URL): URL {
	const page = new URL(pageUrl);
	if (baseHref === undefined) {
		return page;
	}
	return URL.parse(baseHref, page) ?? page;
}

function normalise(href: string, base: URL): string | undefined {
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#")) {
		return undefined;
	}
	const url = URL.parse(trimmed, base);
	if (url === null || IGNORED_PROTOCOLS.has(url.protocol)) {
		return undefined;
	}
	url.hash = "";
	return url.href;
}
