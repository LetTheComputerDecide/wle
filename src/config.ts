import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PipelineOptions } from "./pipeline.ts";
import { VERSION } from "./version.ts";

/**
 * Every setting, with its default and limits. The single source of truth for config
 * files, CLI flags and `config.schema.json`. Unknown keys are rejected.
 */
export const configSchema = z
	.strictObject({
		concurrency: z
			.int()
			.min(1)
			.max(1000)
			.default(16)
			.describe("Maximum fetches in flight across all hosts"),
		perHostConcurrency: z
			.int()
			.min(1)
			.max(1000)
			.default(4)
			.describe("Maximum fetches in flight to one host"),
		consumers: z
			.int()
			.min(1)
			.max(64)
			.default(2)
			.describe("Number of concurrent consumers parsing pages"),
		queueCapacity: z
			.int()
			.min(1)
			.max(100_000)
			.default(100)
			.describe("Pages buffered between producer and consumers"),
		overflow: z
			.enum(["block", "drop-oldest"])
			.default("block")
			.describe("What happens when the queue is full"),
		timeoutMs: z
			.int()
			.min(1)
			.default(10_000)
			.describe("Per-attempt timeout, including reading the body"),
		maxBodyBytes: z
			.int()
			.min(1)
			.default(5 * 1024 * 1024)
			.describe("Largest response body accepted"),
		retries: z
			.int()
			.min(0)
			.max(10)
			.default(2)
			.describe("Retries after the first attempt, for transient failures"),
		retryBaseDelayMs: z
			.int()
			.min(0)
			.default(250)
			.describe("Backoff ceiling for the first retry"),
		retryMaxDelayMs: z
			.int()
			.min(0)
			.default(5000)
			.describe("Largest backoff, and the longest Retry-After honoured"),
		userAgent: z
			.string()
			.min(1)
			.default(`wle/${VERSION}`)
			.describe("User-Agent header sent with every request"),
		format: z
			.enum(["jsonl", "text"])
			.default("jsonl")
			.describe("Output format"),
		out: z
			.string()
			.min(1)
			.optional()
			.describe("Output file; stdout when omitted"),
		logLevel: z
			.enum(["debug", "info", "warn", "error"])
			.default("info")
			.describe("Minimum level logged to stderr"),
	})
	.refine((config) => config.retryBaseDelayMs <= config.retryMaxDelayMs, {
		message: "retryBaseDelayMs must not exceed retryMaxDelayMs",
		path: ["retryBaseDelayMs"],
	});

/** A validated configuration, with defaults filled in. */
export type Config = z.output<typeof configSchema>;
/** What a config file may contain: any subset of the settings. */
export type ConfigInput = z.input<typeof configSchema>;

/** Invalid or unreadable configuration; the message is meant for the user. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Merges defaults, then the config file (if any), then CLI flags, and validates the
 * result once. Flags may be strings; numeric settings are converted before validation.
 *
 * @param configPath - A JSON file of settings; its `$schema` key is ignored.
 * @param flags - Settings by config key; `undefined` values are ignored.
 * @throws {ConfigError} (as a rejection) If the file cannot be read or parsed, or a
 * setting is invalid. The message lists every problem.
 */
export async function loadConfig(
	configPath: string | undefined,
	flags: Record<string, unknown>,
): Promise<Config> {
	const fromFile = configPath ? await readConfigFile(configPath) : {};
	const result = configSchema.safeParse({ ...fromFile, ...coerceFlags(flags) });
	if (!result.success) {
		throw new ConfigError(
			`Invalid configuration:\n${z.prettifyError(result.error)}`,
		);
	}
	return result.data;
}

async function readConfigFile(path: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new ConfigError(
			`Cannot read config file ${path}: ${(error as Error).message}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ConfigError(
			`Config file ${path} is not valid JSON: ${(error as Error).message}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError(`Config file ${path} must contain a JSON object`);
	}
	// "$schema" only points editors at config.schema.json; it is not a setting.
	const { $schema: _, ...settings } = parsed as Record<string, unknown>;
	return settings;
}

const NUMERIC_KEYS = new Set([
	"concurrency",
	"perHostConcurrency",
	"consumers",
	"queueCapacity",
	"timeoutMs",
	"maxBodyBytes",
	"retries",
	"retryBaseDelayMs",
	"retryMaxDelayMs",
]);

function coerceFlags(flags: Record<string, unknown>): Record<string, unknown> {
	const coerced: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(flags)) {
		if (value === undefined) {
			continue;
		}
		// An empty or non-numeric string becomes NaN, which the schema reports clearly.
		coerced[key] =
			NUMERIC_KEYS.has(key) && typeof value === "string"
				? value.trim() === ""
					? Number.NaN
					: Number(value)
				: value;
	}
	return coerced;
}

/** Picks the settings `runPipeline` uses from a full configuration. */
export function toPipelineOptions(config: Config): PipelineOptions {
	return {
		concurrency: config.concurrency,
		perHostConcurrency: config.perHostConcurrency,
		consumers: config.consumers,
		queueCapacity: config.queueCapacity,
		overflow: config.overflow,
		retry: {
			retries: config.retries,
			baseDelayMs: config.retryBaseDelayMs,
			maxDelayMs: config.retryMaxDelayMs,
		},
	};
}

/** JSON Schema for config files, so editors can validate and autocomplete them. */
export function configJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(configSchema, { io: "input" }) as Record<
		string,
		unknown
	>;
}
