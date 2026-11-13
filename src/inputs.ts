import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface InputSources {
	/** URLs from the command line; `-` stands for stdin. */
	args: readonly string[];
	/** Files with one URL per line. */
	files: readonly string[];
	stdin: Readable;
	/** Stops reading, even while waiting on stdin. */
	signal: AbortSignal;
}

/** Fails fast on unreadable input files, before any fetching starts. */
export async function checkInputFiles(files: readonly string[]): Promise<void> {
	// Best effort: a file can still disappear before it is read, which is then fatal.
	for (const file of files) {
		await access(file);
	}
}

/**
 * Yields input URLs lazily: command-line arguments (reading stdin where `-` appears),
 * then each file in turn. Blank lines and lines starting with `#` are skipped.
 */
export async function* readInputs(
	sources: InputSources,
): AsyncGenerator<string> {
	for (const arg of sources.args) {
		if (arg === "-") {
			yield* readLines(sources.stdin, sources.signal);
		} else {
			yield arg;
		}
	}
	for (const file of sources.files) {
		yield* readLines(createReadStream(file), sources.signal);
	}
}

async function* readLines(
	input: Readable,
	signal: AbortSignal,
): AsyncGenerator<string> {
	// Needed: readline ignores a signal that has already aborted and reads the whole input.
	if (signal.aborted) {
		return;
	}
	const lines = createInterface({
		input,
		// Treat "\r\n" as one line break even when the two bytes arrive in separate chunks.
		crlfDelay: Number.POSITIVE_INFINITY,
		signal,
	});
	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (trimmed !== "" && !trimmed.startsWith("#")) {
				yield trimmed;
			}
		}
	} catch (error) {
		// On abort, readline rejects with an AbortError; that is a normal end of input.
		if (!signal.aborted) {
			throw error;
		}
	} finally {
		// Also runs when the caller stops iterating early.
		lines.close();
	}
}
