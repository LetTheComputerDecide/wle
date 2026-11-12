import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { extractLinks } from "../src/extract.ts";

const PAGE = "https://example.com/dir/page.html";

describe("extractLinks", () => {
	test.each([
		[
			"absolute link",
			`<a href="https://other.org/x">x</a>`,
			["https://other.org/x"],
		],
		[
			"relative path",
			`<a href="next.html">`,
			["https://example.com/dir/next.html"],
		],
		["parent path", `<a href="../up.html">`, ["https://example.com/up.html"]],
		["root-relative path", `<a href="/root">`, ["https://example.com/root"]],
		[
			"protocol-relative URL",
			`<a href="//cdn.example.net/a">`,
			["https://cdn.example.net/a"],
		],
		[
			"query-only link",
			`<a href="?q=1">`,
			["https://example.com/dir/page.html?q=1"],
		],
		["strips the fragment", `<a href="/a#section">`, ["https://example.com/a"]],
		[
			"keeps mailto",
			`<a href="mailto:someone@example.com">`,
			["mailto:someone@example.com"],
		],
		["keeps tel", `<a href="tel:+15550100">`, ["tel:+15550100"]],
		[
			"decodes entities",
			`<a href="/s?a=1&amp;b=2">`,
			["https://example.com/s?a=1&b=2"],
		],
		[
			"trims whitespace",
			`<a href="  /spaced \n">`,
			["https://example.com/spaced"],
		],
		[
			"uppercase tags and attributes",
			`<A HREF="/upper">`,
			["https://example.com/upper"],
		],
		["unquoted attribute", `<a href=/bare>`, ["https://example.com/bare"]],
		[
			"single-quoted attribute",
			`<a href='/single'>`,
			["https://example.com/single"],
		],
		[
			"normalises the host",
			`<a href="HTTPS://EXAMPLE.com/Path">`,
			["https://example.com/Path"],
		],
		[
			"IDN host",
			`<a href="https://bücher.example/">`,
			["https://xn--bcher-kva.example/"],
		],
		[
			"unclosed tags",
			`<div><a href="/one">one<a href="/two">two`,
			["https://example.com/one", "https://example.com/two"],
		],
	])("%s", (_, html, expected) => {
		expect(extractLinks(html, PAGE)).toEqual(expected);
	});

	test.each([
		["fragment-only", `<a href="#top">`],
		["empty href", `<a href="">`],
		["whitespace-only href", `<a href="   ">`],
		["anchor without href", `<a name="x">`],
		["javascript:", `<a href="javascript:alert(1)">`],
		[
			"javascript: with odd casing and spacing",
			`<a href=" JavaScript:void(0)">`,
		],
		["data:", `<a href="data:text/html,hi">`],
		["vbscript:", `<a href="vbscript:msgbox">`],
		["unparseable URL", `<a href="http://[invalid">`],
		[
			"non-anchor elements",
			`<link href="/style.css"><img src="/i.png"><area href="/map">`,
		],
		["link inside a comment", `<!-- <a href="/hidden"> -->`],
		[
			"link inside a script",
			`<script>document.write('<a href="/js">')</script>`,
		],
		["link inside a style", `<style>/* <a href="/css"> */</style>`],
	])("skips %s", (_, html) => {
		expect(extractLinks(html, PAGE)).toEqual([]);
	});

	test("de-duplicates, keeping first-seen order", () => {
		const html = `<a href="/b"><a href="/a"><a href="/b#x"><a href="https://example.com/a">`;
		expect(extractLinks(html, PAGE)).toEqual([
			"https://example.com/b",
			"https://example.com/a",
		]);
	});

	describe("<base href>", () => {
		test("resolves links against the base", () => {
			const html = `<base href="https://base.example/sub/"><a href="x">`;
			expect(extractLinks(html, PAGE)).toEqual(["https://base.example/sub/x"]);
		});

		test("applies to links that appear before it", () => {
			const html = `<a href="x"><base href="/other/">`;
			expect(extractLinks(html, PAGE)).toEqual(["https://example.com/other/x"]);
		});

		test("resolves a relative base against the page URL", () => {
			const html = `<base href="../assets/"><a href="x">`;
			expect(extractLinks(html, PAGE)).toEqual([
				"https://example.com/assets/x",
			]);
		});

		test("uses only the first base with an href", () => {
			const html = `<base target="_blank"><base href="/first/"><base href="/second/"><a href="x">`;
			expect(extractLinks(html, PAGE)).toEqual(["https://example.com/first/x"]);
		});

		test("falls back to the page URL when the base is unparseable", () => {
			const html = `<base href="http://[invalid"><a href="x">`;
			expect(extractLinks(html, PAGE)).toEqual(["https://example.com/dir/x"]);
		});
	});

	test("accepts a URL object as the page URL", () => {
		expect(extractLinks(`<a href="x">`, new URL(PAGE))).toEqual([
			"https://example.com/dir/x",
		]);
	});

	test("returns nothing for empty or non-HTML input", () => {
		expect(extractLinks("", PAGE)).toEqual([]);
		expect(extractLinks("just some text < > &", PAGE)).toEqual([]);
	});
});

describe("extractLinks properties", () => {
	const escapeAttribute = (value: string) =>
		value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

	const segment = fc.stringMatching(/^[a-zA-Z0-9._~-]{0,8}$/);
	const hrefArb = fc.oneof(
		fc.webUrl({ withFragments: true, withQueryParameters: true }),
		fc
			.tuple(
				fc.constantFrom(
					"",
					"/",
					"./",
					"../",
					"../../",
					"//host.example/",
					"?",
					"#",
				),
				fc.array(segment, { maxLength: 4 }),
				fc.option(
					segment.map((s) => `#${s}`),
					{ nil: "" },
				),
			)
			.map(([prefix, parts, fragment]) => prefix + parts.join("/") + fragment),
		fc.string(),
	);
	const documentArb = fc
		.array(hrefArb, { maxLength: 20 })
		.map((hrefs) =>
			hrefs.map((h) => `<a href="${escapeAttribute(h)}">`).join("\n"),
		);

	const pageArb = fc.webUrl({ withFragments: true, withQueryParameters: true });

	test("every link is absolute, fragment-free and unique", () => {
		fc.assert(
			fc.property(documentArb, pageArb, (html, page) => {
				const links = extractLinks(html, page);
				expect(new Set(links).size).toBe(links.length);
				for (const link of links) {
					const url = new URL(link);
					expect(url.href).toBe(link);
					expect(url.hash).toBe("");
					expect(link).not.toContain("#");
				}
			}),
			{ numRuns: 300 },
		);
	});

	test("is idempotent: re-extracting the output gives the same links", () => {
		fc.assert(
			fc.property(documentArb, pageArb, (html, page) => {
				const links = extractLinks(html, page);
				const rebuilt = links
					.map((l) => `<a href="${escapeAttribute(l)}">`)
					.join("");
				expect(extractLinks(rebuilt, page)).toEqual(links);
			}),
			{ numRuns: 300 },
		);
	});

	test("never throws on arbitrary input", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), pageArb, (html, page) => {
				expect(Array.isArray(extractLinks(html, page))).toBe(true);
			}),
			{ numRuns: 300 },
		);
	});
});
