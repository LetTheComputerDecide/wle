import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	ConfigError,
	configJsonSchema,
	loadConfig,
	toPipelineOptions,
} from "../src/config.ts";
import { VERSION } from "../src/version.ts";

async function configFile(contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wle-config-"));
	const path = join(dir, "config.json");
	await writeFile(path, contents);
	return path;
}

describe("loadConfig", () => {
	test("applies the documented defaults", async () => {
		expect(await loadConfig(undefined, {})).toEqual({
			concurrency: 16,
			perHostConcurrency: 4,
			consumers: 2,
			queueCapacity: 100,
			overflow: "block",
			timeoutMs: 10_000,
			maxBodyBytes: 5 * 1024 * 1024,
			retries: 2,
			retryBaseDelayMs: 250,
			retryMaxDelayMs: 5000,
			userAgent: `wle/${VERSION}`,
			format: "jsonl",
			logLevel: "info",
		});
	});

	test("flags override the file, which overrides defaults", async () => {
		const path = await configFile(
			JSON.stringify({ concurrency: 3, consumers: 5, overflow: "drop-oldest" }),
		);
		const config = await loadConfig(path, { concurrency: "7", format: "text" });
		expect(config).toMatchObject({
			concurrency: 7,
			consumers: 5,
			overflow: "drop-oldest",
			format: "text",
			retries: 2,
		});
	});

	test("ignores flags that were not given", async () => {
		const path = await configFile(JSON.stringify({ concurrency: 3 }));
		expect(
			(await loadConfig(path, { concurrency: undefined })).concurrency,
		).toBe(3);
	});

	test.each([
		[{ concurrency: "abc" }, "concurrency"],
		[{ concurrency: "" }, "concurrency"],
		[{ concurrency: "0" }, "concurrency"],
		[{ concurrency: "1.5" }, "concurrency"],
		[{ overflow: "drop-newest" }, "overflow"],
		[{ logLevel: "trace" }, "logLevel"],
		[{ retryBaseDelayMs: "9000" }, "retryBaseDelayMs must not exceed"],
	])("rejects %j", async (flags, mention) => {
		const error = await loadConfig(undefined, flags).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as Error).message).toContain(mention);
	});

	test("accepts a $schema key for editor support", async () => {
		const path = await configFile(
			JSON.stringify({ $schema: "./config.schema.json", retries: 0 }),
		);
		expect((await loadConfig(path, {})).retries).toBe(0);
	});

	test("the example config is valid", async () => {
		const example = new URL("../wle.example.json", import.meta.url).pathname;
		expect((await loadConfig(example, {})).overflow).toBe("drop-oldest");
	});

	test("rejects unknown keys in the file", async () => {
		const path = await configFile(JSON.stringify({ concurency: 3 }));
		await expect(loadConfig(path, {})).rejects.toThrow(/concurency/);
	});

	test.each([
		["not JSON", "{ nope", "not valid JSON"],
		["an array", "[]", "must contain a JSON object"],
		["null", "null", "must contain a JSON object"],
	])("rejects a file that is %s", async (_, contents, message) => {
		const path = await configFile(contents);
		await expect(loadConfig(path, {})).rejects.toThrow(message);
	});

	test("rejects a missing file", async () => {
		await expect(loadConfig("/no/such/config.json", {})).rejects.toThrow(
			/Cannot read config file/,
		);
	});
});

test("toPipelineOptions groups the retry settings", async () => {
	const options = toPipelineOptions(await loadConfig(undefined, {}));
	expect(options.retry).toEqual({
		retries: 2,
		baseDelayMs: 250,
		maxDelayMs: 5000,
	});
});

test("the committed config.schema.json is up to date", () => {
	const committed = JSON.parse(
		readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"),
	);
	// Regenerate with: pnpm schema
	expect(committed).toEqual(configJsonSchema());
});
