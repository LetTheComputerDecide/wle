import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FetchError } from "../src/errors.ts";
import { StaticFetcher } from "../src/fetcher/static.ts";
import type { FetchedPage, Fetcher } from "../src/fetcher/types.ts";
import { type PipelineOptions, runPipeline } from "../src/pipeline.ts";
import type { ErrorRecord, PageRecord } from "../src/records.ts";
import { startServer, type TestServer } from "./helpers/server.ts";

const options: PipelineOptions = {
	concurrency: 4,
	perHostConcurrency: 4,
	consumers: 2,
	queueCapacity: 10,
	overflow: "block",
	retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 10 },
};

const page = (url: URL, html = `<a href="/link">x</a>`): FetchedPage => ({
	finalUrl: url.href,
	httpStatus: 200,
	html,
});

/** A fetcher whose behaviour is scripted per URL, recording concurrency as it goes. */
class FakeFetcher implements Fetcher {
	active = 0;
	maxActive = 0;
	readonly activeByHost = new Map<string, number>();
	maxActiveByHost = 0;
	readonly calls: string[] = [];
	readonly #behaviour: (url: URL, signal: AbortSignal) => Promise<FetchedPage>;

	constructor(
		behaviour: (url: URL, signal: AbortSignal) => Promise<FetchedPage> = async (
			url,
		) => page(url),
	) {
		this.#behaviour = behaviour;
	}

	async fetch(url: URL, signal: AbortSignal): Promise<FetchedPage> {
		this.calls.push(url.href);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		const host = (this.activeByHost.get(url.host) ?? 0) + 1;
		this.activeByHost.set(url.host, host);
		this.maxActiveByHost = Math.max(this.maxActiveByHost, host);
		try {
			return await this.#behaviour(url, signal);
		} finally {
			this.active--;
			this.activeByHost.set(
				url.host,
				(this.activeByHost.get(url.host) ?? 1) - 1,
			);
		}
	}
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when `signal` aborts, rejecting the way a real fetch would. */
const untilAborted = (signal: AbortSignal) =>
	new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () =>
			reject(new FetchError("aborted", "Fetch was aborted")),
		);
	});

async function run(
	inputs: Iterable<string> | AsyncIterable<string>,
	fetcher: Fetcher,
	overrides: Partial<PipelineOptions> = {},
	extra: Partial<Parameters<typeof runPipeline>[2]> = {},
) {
	const records: PageRecord[] = [];
	const summary = await runPipeline(
		inputs,
		{ ...options, ...overrides },
		{ fetcher, sink: (record) => records.push(record), ...extra },
	);
	const byIndex = records.toSorted((a, b) => a.index - b.index);
	return { records, byIndex, summary };
}

const urls = (n: number, host = "example.com") =>
	Array.from({ length: n }, (_, i) => `https://${host}/${i}`);

describe("runPipeline", () => {
	test("emits one ok record per URL with its links", async () => {
		const { byIndex, summary } = await run(urls(3), new FakeFetcher());
		expect(byIndex).toEqual(
			[0, 1, 2].map((i) => ({
				index: i,
				url: `https://example.com/${i}`,
				status: "ok",
				finalUrl: `https://example.com/${i}`,
				httpStatus: 200,
				links: ["https://example.com/link"],
				attempts: 1,
				durationMs: expect.any(Number),
			})),
		);
		expect(summary).toMatchObject({ total: 3, ok: 3, failed: 0, errors: {} });
	});

	test("handles an empty input", async () => {
		const { records, summary } = await run([], new FakeFetcher());
		expect(records).toEqual([]);
		expect(summary).toMatchObject({ total: 0, fetchMs: undefined });
	});

	describe("isolation", () => {
		test("a failed fetch does not affect the other URLs", async () => {
			const fetcher = new FakeFetcher(async (url) => {
				if (url.pathname === "/1") {
					throw new FetchError("http_status", "HTTP 500", { httpStatus: 500 });
				}
				if (url.pathname === "/2") {
					throw new TypeError("not even a FetchError");
				}
				return page(url);
			});
			const { byIndex, summary } = await run(urls(4), fetcher);
			expect(byIndex.map((r) => r.status)).toEqual([
				"ok",
				"error",
				"error",
				"ok",
			]);
			expect(byIndex[1]).toMatchObject({
				httpStatus: 500,
				error: { kind: "http_status", message: "HTTP 500" },
			});
			expect(byIndex[2]).toMatchObject({ error: { kind: "network" } });
			expect(summary).toMatchObject({
				ok: 2,
				failed: 2,
				errors: { http_status: 1, network: 1 },
			});
		});

		test("a failed parse does not affect the other pages", async () => {
			const { byIndex } = await run(
				urls(3),
				new FakeFetcher(),
				{},
				{
					extract: (_, pageUrl) => {
						if (pageUrl.endsWith("/1")) {
							throw new Error("parser exploded");
						}
						return ["https://ok.example/"];
					},
				},
			);
			expect(byIndex.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
			expect(byIndex[1]).toMatchObject({
				finalUrl: "https://example.com/1",
				error: { kind: "parse", message: "parser exploded" },
			});
		});

		test.each([
			["not a url", "Not a valid absolute URL"],
			["/relative/path", "Not a valid absolute URL"],
			["ftp://example.com/file", "Unsupported protocol ftp:"],
			["javascript:alert(1)", "Unsupported protocol javascript:"],
		])("rejects the input %j without fetching", async (input, message) => {
			const fetcher = new FakeFetcher();
			const { byIndex } = await run([input, "https://example.com/"], fetcher);
			expect(byIndex[0]).toEqual({
				index: 0,
				url: input,
				status: "error",
				attempts: 0,
				durationMs: 0,
				error: { kind: "invalid_url", message },
			});
			expect(byIndex[1]?.status).toBe("ok");
			expect(fetcher.calls).toEqual(["https://example.com/"]);
		});
	});

	describe("concurrency", () => {
		test("producer and consumer run concurrently", async () => {
			// Page 1 cannot be fetched until page 0 has been parsed and emitted.
			// If consuming waited for producing to finish, this would never complete.
			let emittedFirst!: () => void;
			const firstEmitted = new Promise<void>((resolve) => {
				emittedFirst = resolve;
			});
			const fetcher = new FakeFetcher(async (url) => {
				if (url.pathname === "/1") {
					await firstEmitted;
				}
				return page(url);
			});
			const records: PageRecord[] = [];
			await runPipeline(urls(2), options, {
				fetcher,
				sink: (record) => {
					records.push(record);
					if (record.index === 0) {
						emittedFirst();
					}
				},
			});
			expect(records.map((r) => r.index)).toEqual([0, 1]);
		});

		test("fetches URLs concurrently, up to the global limit", async () => {
			const fetcher = new FakeFetcher(async (url) => {
				await tick();
				return page(url);
			});
			const inputs = [
				...urls(6, "a.example"),
				...urls(6, "b.example"),
				...urls(6, "c.example"),
			];
			await run(inputs, fetcher, { concurrency: 5, perHostConcurrency: 5 });
			expect(fetcher.maxActive).toBe(5);
		});

		test("respects the per-host limit", async () => {
			const fetcher = new FakeFetcher(async (url) => {
				await tick();
				return page(url);
			});
			await run(urls(10), fetcher, { concurrency: 8, perHostConcurrency: 2 });
			expect(fetcher.maxActiveByHost).toBe(2);
		});

		test("reads inputs lazily, no further ahead than the concurrency limit", async () => {
			let read = 0;
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			async function* inputs() {
				for (const url of urls(100)) {
					read++;
					yield url;
				}
			}
			const fetcher = new FakeFetcher(async (url) => {
				await released;
				return page(url);
			});
			const running = run(inputs(), fetcher, { concurrency: 3 });
			await tick(20);
			expect(read).toBe(3);
			release();
			const { records } = await running;
			expect(records).toHaveLength(100);
		});

		test("completes many URLs with every record accounted for", async () => {
			const fetcher = new FakeFetcher(async (url) => {
				await tick(Math.random() * 3);
				if (Number(url.pathname.slice(1)) % 7 === 0) {
					throw new FetchError("timeout", "slow");
				}
				return page(url);
			});
			const { records, summary } = await run(urls(300), fetcher, {
				concurrency: 16,
				consumers: 3,
				queueCapacity: 5,
			});
			expect(records).toHaveLength(300);
			expect(new Set(records.map((r) => r.index)).size).toBe(300);
			expect(summary).toMatchObject({
				total: 300,
				failed: 43,
				errors: { timeout: 43 },
			});
			expect(summary.peakQueueSize).toBeLessThanOrEqual(5);
		});
	});

	describe("overflow", () => {
		test("block never drops pages", async () => {
			const { records, summary } = await run(urls(50), new FakeFetcher(), {
				consumers: 1,
				queueCapacity: 2,
				overflow: "block",
			});
			expect(records.every((r) => r.status === "ok")).toBe(true);
			expect(summary.peakQueueSize).toBe(2);
		});

		test("drop-oldest evicts pages and reports each as dropped", async () => {
			const { records, summary } = await run(urls(50), new FakeFetcher(), {
				concurrency: 50,
				consumers: 1,
				queueCapacity: 2,
				overflow: "drop-oldest",
			});
			const dropped = records.filter(
				(r): r is ErrorRecord =>
					r.status === "error" && r.error.kind === "dropped",
			);
			expect(dropped.length).toBeGreaterThan(0);
			expect(records).toHaveLength(50);
			expect(summary.ok + (summary.errors.dropped ?? 0)).toBe(50);
			expect(summary.peakQueueSize).toBe(2);
			expect(dropped[0]).toMatchObject({
				finalUrl: expect.any(String),
				httpStatus: 200,
				attempts: 1,
			});
			expect(dropped[0]).not.toHaveProperty("html");
		});
	});

	describe("retries", () => {
		test("retries transient failures and reports the attempt count", async () => {
			let calls = 0;
			const fetcher = new FakeFetcher(async (url) => {
				if (++calls < 3) {
					throw new FetchError("http_status", "HTTP 503", { httpStatus: 503 });
				}
				return page(url);
			});
			const { records } = await run(["https://example.com/"], fetcher, {
				retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 10 },
			});
			expect(records[0]).toMatchObject({ status: "ok", attempts: 3 });
		});
	});

	describe("cancellation", () => {
		test("aborting cancels in-flight fetches and stops reading inputs", async () => {
			const controller = new AbortController();
			let read = 0;
			async function* inputs() {
				for (const url of urls(100)) {
					read++;
					yield url;
				}
			}
			const fetcher = new FakeFetcher(async (url, signal) => {
				if (url.pathname === "/0") {
					return page(url);
				}
				return untilAborted(signal);
			});
			const running = run(
				inputs(),
				fetcher,
				{ concurrency: 4 },
				{
					signal: controller.signal,
				},
			);
			await tick(20);
			controller.abort();
			const { byIndex, summary } = await running;

			expect(read).toBeLessThan(100);
			expect(byIndex).toHaveLength(read);
			expect(byIndex[0]?.status).toBe("ok");
			expect(
				byIndex
					.slice(1)
					.every((r) => r.status === "error" && r.error.kind === "aborted"),
			).toBe(true);
			expect(summary.errors.aborted).toBe(read - 1);
		});

		test("a sink failure is fatal and does not hang, even with a full queue", async () => {
			const failure = new Error("disk full");
			const fetcher = new FakeFetcher(async (url, signal) => {
				if (url.pathname === "/9") {
					return untilAborted(signal);
				}
				return page(url);
			});
			let emitted = 0;
			const running = runPipeline(
				urls(10),
				{ ...options, queueCapacity: 1, consumers: 1 },
				{
					fetcher,
					sink: () => {
						if (++emitted === 2) {
							throw failure;
						}
					},
				},
			);
			await expect(running).rejects.toBe(failure);
			expect(fetcher.active).toBe(0);
		});
	});
});

describe("runPipeline over HTTP", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await startServer();
	});
	afterAll(() => server.close());

	test("produces the expected record for each kind of page", async () => {
		const paths = [
			"/html",
			"/redirect",
			"/json",
			"/status?code=404",
			"/hang",
			"/huge-stream",
		];
		const records: PageRecord[] = [];
		const summary = await runPipeline(
			paths.map((path) => server.url(path)),
			options,
			{
				fetcher: new StaticFetcher({
					timeoutMs: 300,
					maxBodyBytes: 32 * 1024,
					userAgent: "wle-test",
				}),
				sink: (record) => records.push(record),
			},
		);

		const byIndex = records.toSorted((a, b) => a.index - b.index);
		expect(byIndex[0]).toMatchObject({
			status: "ok",
			links: [server.url("/a"), server.url("/b")],
		});
		expect(byIndex[1]).toMatchObject({
			status: "ok",
			finalUrl: server.url("/sub/target"),
			links: [server.url("/sub/sibling")],
		});
		expect(
			byIndex.slice(2).map((r) => r.status === "error" && r.error.kind),
		).toEqual(["not_html", "http_status", "timeout", "too_large"]);
		expect(summary).toMatchObject({ total: 6, ok: 2, failed: 4 });
		expect(summary.fetchMs?.p95).toBeGreaterThanOrEqual(300);
	});
});
