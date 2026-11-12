import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { checkInputFiles, readInputs } from "../src/inputs.ts";

async function file(contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wle-inputs-"));
	const path = join(dir, "urls.txt");
	await writeFile(path, contents);
	return path;
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
	const items: string[] = [];
	for await (const item of iterable) {
		items.push(item);
	}
	return items;
}

const signal = () => new AbortController().signal;

describe("readInputs", () => {
	test("reads arguments, stdin in place of '-', then files", async () => {
		const path = await file("https://f/1\nhttps://f/2\n");
		const inputs = readInputs({
			args: ["https://a/1", "-", "https://a/2"],
			files: [path],
			stdin: Readable.from(["https://s/1\nhttps://s/2"]),
			signal: signal(),
		});
		expect(await collect(inputs)).toEqual([
			"https://a/1",
			"https://s/1",
			"https://s/2",
			"https://a/2",
			"https://f/1",
			"https://f/2",
		]);
	});

	test("skips blank lines and comments, trims whitespace, handles CRLF", async () => {
		const path = await file(
			"# list\r\n\r\n  https://x/1  \r\n\t# indented comment\nhttps://x/2",
		);
		const inputs = readInputs({
			args: [],
			files: [path],
			stdin: Readable.from([]),
			signal: signal(),
		});
		expect(await collect(inputs)).toEqual(["https://x/1", "https://x/2"]);
	});

	test("stops waiting on stdin when aborted", async () => {
		const controller = new AbortController();
		const stdin = new PassThrough();
		stdin.write("https://s/1\n");
		const inputs = readInputs({
			args: ["-"],
			files: [],
			stdin,
			signal: controller.signal,
		});
		const received: string[] = [];
		const done = (async () => {
			for await (const input of inputs) {
				received.push(input);
				controller.abort();
			}
		})();
		// stdin is never ended; only the abort can finish the loop.
		await done;
		expect(received).toEqual(["https://s/1"]);
	});

	test("reads nothing when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const inputs = readInputs({
			args: ["-"],
			files: [],
			stdin: Readable.from(["https://s/1\n"]),
			signal: controller.signal,
		});
		expect(await collect(inputs)).toEqual([]);
	});
});

describe("checkInputFiles", () => {
	test("accepts readable files", async () => {
		await expect(checkInputFiles([await file("")])).resolves.toBeUndefined();
	});

	test("rejects a missing file", async () => {
		await expect(checkInputFiles(["/no/such/file.txt"])).rejects.toThrow(
			/ENOENT/,
		);
	});
});
