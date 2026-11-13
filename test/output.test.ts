import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLogger } from "../src/logger.ts";
import { formatRecord } from "../src/output.ts";
import type { ErrorRecord, OkRecord } from "../src/records.ts";

const ok: OkRecord = {
	inputIndex: 0,
	url: "https://example.com/",
	status: "ok",
	finalUrl: "https://example.com/",
	httpStatus: 200,
	links: ["https://example.com/a", "https://example.com/b"],
	attempts: 1,
	durationMs: 42,
};

const failed: ErrorRecord = {
	inputIndex: 1,
	url: "https://example.com/missing",
	status: "error",
	httpStatus: 404,
	attempts: 1,
	durationMs: 7,
	error: { kind: "http_status", message: "HTTP 404" },
};

describe("formatRecord", () => {
	test("jsonl writes one parseable line per record", () => {
		const line = formatRecord(ok, "jsonl");
		expect(line.endsWith("\n")).toBe(true);
		expect(line.trimEnd()).not.toContain("\n");
		expect(JSON.parse(line)).toEqual(ok);
	});

	test("text lists the links under the URL", () => {
		expect(formatRecord(ok, "text")).toBe(
			"✓ https://example.com/ (2 links, 42 ms)\n    https://example.com/a\n    https://example.com/b\n",
		);
	});

	test("text shows redirects and singular counts", () => {
		const redirected = {
			...ok,
			finalUrl: "https://example.com/home",
			links: ["https://x/"],
		};
		expect(formatRecord(redirected, "text")).toMatch(
			/^✓ https:\/\/example.com\/ → https:\/\/example.com\/home \(1 link, 42 ms\)\n/,
		);
	});

	test("text shows errors with their kind", () => {
		expect(formatRecord(failed, "text")).toBe(
			"✗ https://example.com/missing (HTTP 404)\n    http_status: HTTP 404\n",
		);
		const { httpStatus: _, ...noStatus } = failed;
		expect(formatRecord(noStatus, "text")).toMatch(
			/^✗ https:\/\/example.com\/missing\n/,
		);
	});
});

describe("createLogger", () => {
	function capture() {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
		return { lines, stream };
	}

	test("writes logfmt, quoting values only when needed", () => {
		const { lines, stream } = capture();
		createLogger(stream, "debug").warn("Fetch failed", {
			url: "https://x/",
			error: 'said "no"',
			attempts: 3,
			ok: false,
			skipped: undefined,
			empty: "",
		});
		expect(lines).toEqual([
			`level=warn msg="Fetch failed" url=https://x/ error="said \\"no\\"" attempts=3 ok=false empty=""\n`,
		]);
	});

	test("drops messages below the minimum level", () => {
		const { lines, stream } = capture();
		const logger = createLogger(stream, "warn");
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		expect(lines).toEqual(["level=warn msg=w\n", "level=error msg=e\n"]);
	});
});
