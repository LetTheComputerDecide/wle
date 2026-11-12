import type { Writable } from "node:stream";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Writes logfmt lines (`level=warn msg="..." url=...`): structured enough to grep and
 * parse, readable enough for a terminal.
 */
export function createLogger(stream: Writable, minLevel: LogLevel): Logger {
	const log =
		(level: LogLevel) =>
		(message: string, fields: LogFields = {}) => {
			if (RANK[level] < RANK[minLevel]) {
				return;
			}
			const pairs = [`level=${level}`, `msg=${quote(message)}`];
			for (const [key, value] of Object.entries(fields)) {
				if (value !== undefined) {
					pairs.push(`${key}=${quote(String(value))}`);
				}
			}
			stream.write(`${pairs.join(" ")}\n`);
		};
	return {
		debug: log("debug"),
		info: log("info"),
		warn: log("warn"),
		error: log("error"),
	};
}

function quote(value: string): string {
	return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
}
