import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkInputFile, readUrlsFromFile } from "../src/inputs.ts";

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

describe("readUrlsFromFile", () => {
	test("reads one URL per line, in order", async () => {
		const path = await file("https://a/1\nhttps://a/2\nhttps://a/3\n");
		expect(await collect(readUrlsFromFile(path, signal()))).toEqual([
			"https://a/1",
			"https://a/2",
			"https://a/3",
		]);
	});

	test("skips blank lines and comments, trims whitespace, handles CRLF", async () => {
		const path = await file(
			"# list\r\n\r\n  https://x/1  \r\n\t# indented comment\nhttps://x/2",
		);
		expect(await collect(readUrlsFromFile(path, signal()))).toEqual([
			"https://x/1",
			"https://x/2",
		]);
	});

	// Lines readline has already buffered are still yielded, but no new data is read. The
	// producer checks the signal for each input itself, so those extra lines are never fetched.
	test("stops reading new data when aborted", async () => {
		const total = 100_000; // about 2 MB: far more than one read chunk
		const path = await file(
			Array.from({ length: total }, (_, line) => `https://x/${line}`).join(
				"\n",
			),
		);
		const controller = new AbortController();
		let received = 0;
		for await (const _url of readUrlsFromFile(path, controller.signal)) {
			received++;
			controller.abort();
		}
		expect(received).toBeGreaterThan(0);
		expect(received).toBeLessThan(total);
	});

	test("reads nothing when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const path = await file("https://x/1\n");
		expect(await collect(readUrlsFromFile(path, controller.signal))).toEqual(
			[],
		);
	});
});

describe("checkInputFile", () => {
	test("accepts an existing file", async () => {
		await expect(checkInputFile(await file(""))).resolves.toBeUndefined();
	});

	test("rejects a missing file", async () => {
		await expect(checkInputFile("/no/such/file.txt")).rejects.toThrow(/ENOENT/);
	});
});
