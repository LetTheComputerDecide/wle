import { open } from "node:fs/promises";
import type { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
	type Config,
	ConfigError,
	configJsonSchema,
	loadConfig,
	toPipelineOptions,
} from "./config.ts";
import { StaticFetcher } from "./fetcher/static.ts";
import { checkInputFile, readUrlsFromFile } from "./inputs.ts";
import { createLogger, type Logger } from "./logger.ts";
import { formatRecord } from "./output.ts";
import { runPipeline } from "./pipeline.ts";
import type { PageRecord } from "./records.ts";
import type { Summary } from "./summary.ts";
import { VERSION } from "./version.ts";

export interface MainIO {
	stdout: Writable;
	stderr: Writable;
	/** Aborted on SIGINT/SIGTERM: finish gracefully. */
	signal: AbortSignal;
}

/** Process exit codes. Part of the CLI contract, so scripts can rely on them. */
export const EXIT = { ok: 0, fatal: 1, failures: 2, interrupted: 130 } as const;

/** CLI flag name to config key, for every setting that can be set from the command line. */
const SETTING_FLAGS = {
	concurrency: "concurrency",
	"per-host-concurrency": "perHostConcurrency",
	consumers: "consumers",
	"queue-capacity": "queueCapacity",
	overflow: "overflow",
	"timeout-ms": "timeoutMs",
	"max-body-bytes": "maxBodyBytes",
	retries: "retries",
	"retry-base-delay-ms": "retryBaseDelayMs",
	"retry-max-delay-ms": "retryMaxDelayMs",
	"user-agent": "userAgent",
	format: "format",
	out: "out",
	"log-level": "logLevel",
} as const;

const USAGE = `Usage: wle [options] --file <path>

Fetches each URL concurrently and prints the hyperlinks found on each page.
URLs are read from a file, one per line; blank lines and # comments are skipped.

Input:
  -f, --file <path>              File of URLs (required)
  -c, --config <path>            JSON config file; flags override it

Output:
  -o, --out <path>               Write records to a file instead of stdout
      --format <jsonl|text>      Output format (default: jsonl)

Fetching:
      --concurrency <n>          Fetches in flight across all hosts (default: 16)
      --per-host-concurrency <n> Fetches in flight per host (default: 4)
      --timeout-ms <n>           Per-attempt timeout (default: 10000)
      --max-body-bytes <n>       Largest body accepted (default: 5242880)
      --retries <n>              Retries for transient failures (default: 2)
      --retry-base-delay-ms <n>  First backoff ceiling (default: 250)
      --retry-max-delay-ms <n>   Largest backoff and Retry-After (default: 5000)
      --user-agent <string>      User-Agent header (default: wle/${VERSION})

Queue:
      --consumers <n>            Concurrent parsers (default: 2)
      --queue-capacity <n>       Pages buffered for parsing (default: 100)
      --overflow <policy>        block | drop-oldest (default: block)

Logging (stderr):
      --log-level <level>        debug | info | warn | error (default: info)
  -v, --verbose                  Same as --log-level debug
  -q, --quiet                    Same as --log-level error

Other:
      --print-config-schema      Print the config file's JSON Schema
  -h, --help                     Show this help
      --version                  Show the version

Exit codes: 0 all succeeded, 1 fatal error, 2 some URLs failed, 130 interrupted.
`;

/**
 * Runs the CLI with injected streams, so it can be tested without a child process.
 *
 * @returns The exit code, one of {@link EXIT}. Never rejects.
 */
export async function main(
	argv: readonly string[],
	io: MainIO,
): Promise<number> {
	let setup: Setup | "done";
	try {
		setup = await prepare(argv, io);
	} catch (error) {
		if (error instanceof ConfigError || isParseArgsError(error)) {
			io.stderr.write(`wle: ${error.message}\nRun "wle --help" for usage.\n`);
			return EXIT.fatal;
		}
		throw error;
	}
	if (setup === "done") {
		return EXIT.ok;
	}

	const { config, inputFile, output } = setup;
	const logger = createLogger(io.stderr, config.logLevel);
	const controller = new AbortController();
	const signal = AbortSignal.any([io.signal, controller.signal]);

	// A closed pipe (`wle ... | head`) just means the reader has seen enough.
	let pipeClosed = false;
	let writeError: Error | undefined;
	output.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") {
			pipeClosed = true;
		} else {
			writeError = error;
		}
		// Results can no longer be delivered, so stop fetching either way.
		controller.abort(error);
	});

	const sink = (record: PageRecord) => {
		// A real write failure is fatal: throwing from the sink fails the pipeline.
		if (writeError) {
			throw writeError;
		}
		// A closed pipe is not: the remaining records are discarded quietly.
		if (pipeClosed) {
			return;
		}
		output.write(formatRecord(record, config.format));
		logRecord(logger, record);
	};

	let summary: Summary;
	try {
		logger.debug("Starting", { version: VERSION, ...config });
		summary = await runPipeline(
			readUrlsFromFile(inputFile, signal),
			toPipelineOptions(config),
			{
				fetcher: new StaticFetcher({
					timeoutMs: config.timeoutMs,
					maxBodyBytes: config.maxBodyBytes,
					userAgent: config.userAgent,
				}),
				sink,
				signal,
			},
		);
	} catch (error) {
		logger.error("Fatal error", { error: (error as Error).message });
		return EXIT.fatal;
	} finally {
		// Ending a file stream flushes it. stdout belongs to the caller and stays open.
		if (output !== io.stdout) {
			await new Promise<void>((resolve) => output.end(resolve));
		}
	}

	if (writeError) {
		logger.error("Could not write output", { error: writeError.message });
		return EXIT.fatal;
	}
	logSummary(logger, summary);
	// The order matters. A closed pipe aborts the run itself, so it must win over the
	// failure count; and the reader chose to stop, which is success.
	if (pipeClosed) {
		return EXIT.ok;
	}
	if (io.signal.aborted) {
		return EXIT.interrupted;
	}
	return summary.failed > 0 ? EXIT.failures : EXIT.ok;
}

interface Setup {
	config: Config;
	inputFile: string;
	output: Writable;
}

/** Parses arguments and validates everything that can fail before any work starts. */
async function prepare(
	argv: readonly string[],
	io: MainIO,
): Promise<Setup | "done"> {
	// Settings are parsed as strings and converted by the config schema, so a bad number
	// gets the same error message whether it comes from a flag or the config file.
	const settingOptions = Object.fromEntries(
		Object.keys(SETTING_FLAGS).map((flag) => [
			flag,
			{ type: "string" as const },
		]),
	);
	const { values } = parseArgs({
		args: [...argv],
		allowPositionals: false,
		options: {
			...settingOptions,
			out: { type: "string", short: "o" },
			file: { type: "string", short: "f", multiple: true },
			config: { type: "string", short: "c" },
			verbose: { type: "boolean", short: "v" },
			quiet: { type: "boolean", short: "q" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
			"print-config-schema": { type: "boolean" },
		},
	});

	if (values.help) {
		io.stdout.write(USAGE);
		return "done";
	}
	if (values.version) {
		io.stdout.write(`${VERSION}\n`);
		return "done";
	}
	if (values["print-config-schema"]) {
		io.stdout.write(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
		return "done";
	}

	const flags: Record<string, unknown> = {};
	for (const [flag, key] of Object.entries(SETTING_FLAGS)) {
		flags[key] = values[flag as keyof typeof values];
	}
	if (values.verbose && values.quiet) {
		throw new ConfigError("--verbose and --quiet cannot be combined");
	}
	if (values.verbose) {
		flags.logLevel = "debug";
	} else if (values.quiet) {
		flags.logLevel = "error";
	}
	const config = await loadConfig(values.config, flags);

	// Parsed as a list so a repeated --file is reported, not silently replaced by the last.
	const [inputFile, ...extraFiles] = values.file ?? [];
	if (inputFile === undefined) {
		throw new ConfigError("No input file given. Pass one with --file");
	}
	if (extraFiles.length > 0) {
		throw new ConfigError("Only one --file can be given");
	}
	try {
		await checkInputFile(inputFile);
	} catch (error) {
		throw new ConfigError(
			`Cannot read input file: ${(error as Error).message}`,
		);
	}

	let output: Writable = io.stdout;
	if (config.out) {
		try {
			output = (await open(config.out, "w")).createWriteStream();
		} catch (error) {
			throw new ConfigError(
				`Cannot open output file: ${(error as Error).message}`,
			);
		}
	}
	return { config, inputFile, output };
}

/** Failures log at `warn` so they show by default; successes only with `--verbose`. */
function logRecord(logger: Logger, record: PageRecord): void {
	if (record.status === "ok") {
		logger.debug("Fetched", {
			url: record.url,
			links: record.links.length,
			ms: record.durationMs,
			hostWaitMs: record.hostWaitMs || undefined,
			attempts: record.attempts,
		});
	} else {
		logger.warn("Failed", {
			url: record.url,
			kind: record.error.kind,
			error: record.error.message,
			attempts: record.attempts,
			hostWaitMs: record.hostWaitMs || undefined,
		});
	}
}

function logSummary(logger: Logger, summary: Summary): void {
	const errors = Object.entries(summary.errors)
		.map(([kind, count]) => `${kind}:${count}`)
		.join(",");
	logger.info("Finished", {
		total: summary.total,
		ok: summary.ok,
		failed: summary.failed,
		errors: errors || undefined,
		peakQueue: summary.peakQueueSize,
		hostWaited: summary.hostWaited,
		maxHostWaitMs: summary.maxHostWaitMs,
		p50Ms: summary.fetchMs?.p50,
		p95Ms: summary.fetchMs?.p95,
	});
}

/** `util.parseArgs` signals usage errors only through `code`; it has no error class. */
function isParseArgsError(error: unknown): error is Error {
	const errorCode = (error as { code?: unknown } | null)?.code;
	return (
		typeof errorCode === "string" && errorCode.startsWith("ERR_PARSE_ARGS_")
	);
}
