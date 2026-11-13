import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT, main } from "../src/main.ts";
import type { PageRecord } from "../src/records.ts";
import { VERSION } from "../src/version.ts";
import { startServer, type TestServer } from "./helpers/server.ts";

let server: TestServer;
beforeAll(async () => {
	server = await startServer();
});
afterAll(() => server.close());

class Capture extends Writable {
	text = "";
	override _write(chunk: unknown, _: BufferEncoding, callback: () => void) {
		this.text += String(chunk);
		callback();
	}
}

async function run(
	argv: string[],
	{ stdin = Readable.from([]), signal = new AbortController().signal } = {},
) {
	const stdout = new Capture();
	const stderr = new Capture();
	const code = await main(argv, { stdin, stdout, stderr, signal });
	return { code, stdout: stdout.text, stderr: stderr.text };
}

const parseRecords = (jsonl: string): PageRecord[] =>
	jsonl
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.sort((a, b) => a.inputIndex - b.inputIndex);

const fast = ["--retries", "0", "--timeout-ms", "300"];

async function tempDir() {
	return mkdtemp(join(tmpdir(), "wle-main-"));
}

describe("main", () => {
	test("prints JSONL records to stdout and logs to stderr", async () => {
		const { code, stdout, stderr } = await run([
			server.url("/html"),
			server.url("/a"),
		]);
		expect(code).toBe(EXIT.ok);
		const records = parseRecords(stdout);
		expect(records.map((r) => r.status)).toEqual(["ok", "ok"]);
		expect(records[0]).toMatchObject({
			links: [server.url("/a"), server.url("/b")],
		});
		expect(stderr).toMatch(/^level=info msg=Finished total=2 ok=2 failed=0 /m);
		expect(stdout).not.toContain("level=");
	});

	test("exits 2 when some URLs fail, still reporting the rest", async () => {
		const { code, stdout, stderr } = await run([
			...fast,
			server.url("/html"),
			server.url("/status?code=500"),
			"not-a-url",
		]);
		expect(code).toBe(EXIT.failures);
		expect(parseRecords(stdout).map((r) => r.status)).toEqual([
			"ok",
			"error",
			"error",
		]);
		expect(stderr).toContain("kind=http_status");
		expect(stderr).toContain("kind=invalid_url");
	});

	test("writes text output to a file", async () => {
		const out = join(await tempDir(), "links.txt");
		const { code, stdout } = await run([
			"--format",
			"text",
			"-o",
			out,
			"-q",
			server.url("/html"),
		]);
		expect(code).toBe(EXIT.ok);
		expect(stdout).toBe("");
		expect(await readFile(out, "utf8")).toContain(
			`✓ ${server.url("/html")} (2 links,`,
		);
	});

	test("reads URLs from stdin and from files", async () => {
		const dir = await tempDir();
		const list = join(dir, "urls.txt");
		await writeFile(list, `# pages\n${server.url("/a")}\n`);
		const { code, stdout } = await run(["-", "--file", list], {
			stdin: Readable.from([`${server.url("/html")}\n`]),
		});
		expect(code).toBe(EXIT.ok);
		expect(parseRecords(stdout).map((r) => r.url)).toEqual([
			server.url("/html"),
			server.url("/a"),
		]);
	});

	test("applies a config file, with flags taking precedence", async () => {
		const dir = await tempDir();
		const config = join(dir, "wle.json");
		await writeFile(
			config,
			JSON.stringify({ format: "text", logLevel: "debug" }),
		);
		const { stdout, stderr } = await run([
			"-c",
			config,
			"--log-level",
			"warn",
			server.url("/html"),
		]);
		expect(stdout).toMatch(/^✓ /);
		expect(stderr).toBe("");
	});

	test("--verbose logs every fetch", async () => {
		const { stderr } = await run(["-v", server.url("/html")]);
		expect(stderr).toContain("level=debug msg=Starting");
		expect(stderr).toMatch(/level=debug msg=Fetched url=\S+ links=2/);
	});

	test("exits 130 after an interrupt, with a record for every input read", async () => {
		const controller = new AbortController();
		const stdin = new PassThrough();
		stdin.write(`${server.url("/hang")}\n`);
		// stdin stays open, as if the user were still typing.
		const running = run(["--timeout-ms", "60000", server.url("/html"), "-"], {
			stdin,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		const { code, stdout } = await running;
		expect(code).toBe(EXIT.interrupted);
		const records = parseRecords(stdout);
		expect(records.map((r) => r.status === "ok" || r.error.kind)).toEqual([
			true,
			"aborted",
		]);
	});

	test("stops quietly and exits 0 when stdout is closed early", async () => {
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				const error = Object.assign(new Error("write EPIPE"), {
					code: "EPIPE",
				});
				callback(error);
			},
		});
		stdout.on("error", () => {});
		const stderr = new Capture();
		const code = await main([server.url("/html"), server.url("/a")], {
			stdin: Readable.from([]),
			stdout,
			stderr,
			signal: new AbortController().signal,
		});
		expect(code).toBe(EXIT.ok);
		expect(stderr.text).not.toContain("level=error");
	});

	test("exits 1 when the output cannot be written", async () => {
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback(Object.assign(new Error("no space left"), { code: "ENOSPC" }));
			},
		});
		const stderr = new Capture();
		const code = await main(
			[...fast, server.url("/html"), server.url("/a"), server.url("/b")],
			{
				stdin: Readable.from([]),
				stdout,
				stderr,
				signal: new AbortController().signal,
			},
		);
		expect(code).toBe(EXIT.fatal);
		expect(stderr.text).toContain("no space left");
	});

	describe("usage errors exit 1 before fetching anything", () => {
		test.each([
			[[], "No URLs given"],
			[["--bogus", "https://x/"], "Unknown option '--bogus'"],
			[["--concurrency", "abc", "https://x/"], "concurrency"],
			[["-v", "-q", "https://x/"], "cannot be combined"],
			[["--file", "/no/such/list.txt"], "Cannot read input file"],
			[
				["--config", "/no/such/wle.json", "https://x/"],
				"Cannot read config file",
			],
			[
				["--out", "/no/such/dir/out.jsonl", "https://x/"],
				"Cannot open output file",
			],
		])("%j", async (argv, message) => {
			const { code, stdout, stderr } = await run(argv);
			expect(code).toBe(EXIT.fatal);
			expect(stdout).toBe("");
			expect(stderr).toContain(message);
			expect(stderr).toContain("wle --help");
		});
	});

	test.each([
		[["--help"], /^Usage: wle/],
		[["-h"], /^Usage: wle/],
		[["--version"], new RegExp(`^${VERSION.replaceAll(".", "\\.")}\\n$`)],
		[["--print-config-schema"], /"\$schema"/],
	])("%j prints to stdout and exits 0", async (argv, pattern) => {
		const { code, stdout } = await run(argv);
		expect(code).toBe(EXIT.ok);
		expect(stdout).toMatch(pattern);
	});
});
