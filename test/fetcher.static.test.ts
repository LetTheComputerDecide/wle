import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { FetchError } from "../src/errors.ts";
import {
	parseContentType,
	parseRetryAfter,
	StaticFetcher,
} from "../src/fetcher/static.ts";
import { startServer, type TestServer } from "./helpers/server.ts";

let server: TestServer;
beforeAll(async () => {
	server = await startServer({
		"/echo-headers": (request, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(JSON.stringify(request.headers));
		},
	});
});
afterAll(() => server.close());

const fetcher = new StaticFetcher({
	timeoutMs: 500,
	maxBodyBytes: 64 * 1024,
	userAgent: "wle-test/1.0",
});

const get = (path: string, signal = new AbortController().signal) =>
	fetcher.fetch(new URL(server.url(path)), signal);

async function failure(
	path: string,
	signal?: AbortSignal,
): Promise<FetchError> {
	const error = await get(path, signal).then(
		() => {
			throw new Error(`expected ${path} to fail`);
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(FetchError);
	return error as FetchError;
}

describe("StaticFetcher", () => {
	// A timer left running would keep each fetch's signals in memory for the full timeout;
	// at high throughput that grew to hundreds of megabytes. AbortSignal.timeout() has that
	// problem but its timer is internal and not listed as an active resource, so it is
	// checked for separately.
	test("cancels its timeout timer once the fetch is done", async () => {
		const timers = () =>
			process.getActiveResourcesInfo().filter((type) => type === "Timeout")
				.length;
		const signalTimeout = vi.spyOn(AbortSignal, "timeout");
		try {
			const before = timers();
			await get("/html");
			await failure("/status?code=404");
			expect(timers()).toBe(before);
			expect(signalTimeout).not.toHaveBeenCalled();
		} finally {
			signalTimeout.mockRestore();
		}
	});

	test("returns the markup, status and final URL", async () => {
		const page = await get("/html");
		expect(page.httpStatus).toBe(200);
		expect(page.finalUrl).toBe(server.url("/html"));
		expect(page.html).toContain(`<a href="/a">`);
	});

	test("follows redirects and reports the final URL", async () => {
		const page = await get("/redirect");
		expect(page.finalUrl).toBe(server.url("/sub/target"));
	});

	test("sends the configured User-Agent", async () => {
		const page = await get("/echo-headers");
		expect(JSON.parse(page.html)["user-agent"]).toBe("wle-test/1.0");
	});

	test("accepts application/xhtml+xml", async () => {
		expect((await get("/xhtml")).html).toContain("<a");
	});

	test("treats a missing Content-Type as HTML", async () => {
		expect((await get("/no-content-type")).html).toContain("<a");
	});

	test("decodes using the declared charset", async () => {
		expect((await get("/latin1")).html).toContain("café");
	});

	test("falls back to UTF-8 for an unknown charset", async () => {
		expect((await get("/bogus-charset")).html).toContain(`href="/ok"`);
	});

	test.each([
		["/json", "application/json"],
		["/image", "image/png"],
	])("rejects %s as not_html", async (path, type) => {
		const error = await failure(path);
		expect(error.kind).toBe("not_html");
		expect(error.message).toContain(type);
		expect(error.retryable).toBe(false);
	});

	test.each([404, 410])(
		"reports HTTP %i as a non-retryable http_status",
		async (code) => {
			const error = await failure(`/status?code=${code}`);
			expect(error).toMatchObject({ kind: "http_status", httpStatus: code });
			expect(error.retryable).toBe(false);
		},
	);

	test.each([429, 500, 503])(
		"reports HTTP %i as a retryable http_status",
		async (code) => {
			const error = await failure(`/status?code=${code}`);
			expect(error).toMatchObject({ kind: "http_status", httpStatus: code });
			expect(error.retryable).toBe(true);
		},
	);

	test("carries Retry-After from the response", async () => {
		const error = await failure("/status?code=503&retry-after=2");
		expect(error.retryAfterMs).toBe(2000);
	});

	test("times out waiting for headers", async () => {
		const error = await failure("/hang");
		expect(error.kind).toBe("timeout");
		expect(error.retryable).toBe(true);
	});

	test("times out while reading a body that never finishes", async () => {
		expect((await failure("/hang-body")).kind).toBe("timeout");
	});

	test("rejects a body whose declared length is too large", async () => {
		expect((await failure("/huge-declared")).kind).toBe("too_large");
	});

	test("stops reading a streamed body once it exceeds the cap", async () => {
		const error = await failure("/huge-stream");
		expect(error.kind).toBe("too_large");
		expect(error.retryable).toBe(false);
	});

	test("reports a redirect loop as a network error", async () => {
		expect((await failure("/redirect-loop")).kind).toBe("network");
	});

	test("reports a refused connection as a network error", async () => {
		const closed = await startServer();
		const url = closed.url("/html");
		await closed.close();
		const error = await fetcher
			.fetch(new URL(url), new AbortController().signal)
			.catch((e: unknown) => e as FetchError);
		expect(error).toMatchObject({ kind: "network" });
		expect((error as FetchError).message).toContain("ECONNREFUSED");
		expect((error as FetchError).retryable).toBe(true);
	});

	test("reports cancellation by the caller as aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const error = await failure("/hang", controller.signal);
		expect(error.kind).toBe("aborted");
		expect(error.retryable).toBe(false);
	});
});

describe("parseContentType", () => {
	test.each([
		[null, undefined],
		["", undefined],
		["text/html", { mediaType: "text/html" }],
		["Text/HTML; Charset=UTF-8", { mediaType: "text/html", charset: "UTF-8" }],
		[
			`text/html; foo=bar; charset="iso-8859-1"`,
			{ mediaType: "text/html", charset: "iso-8859-1" },
		],
		["text/html; charset=", { mediaType: "text/html" }],
	])("%j", (header, expected) => {
		expect(parseContentType(header)).toEqual(expected);
	});
});

describe("parseRetryAfter", () => {
	const now = Date.parse("2026-01-01T00:00:00Z");

	test.each([
		[null, undefined],
		["0", 0],
		["120", 120_000],
		[" 3 ", 3000],
		["Thu, 01 Jan 2026 00:00:30 GMT", 30_000],
		["Wed, 31 Dec 2025 23:59:00 GMT", 0],
		["soon", undefined],
		["-5", undefined],
	])("%j", (header, expected) => {
		expect(parseRetryAfter(header, now)).toBe(expected);
	});
});
