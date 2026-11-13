import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Fails fast on a missing input file, before any fetching starts. */
export async function checkInputFile(path: string): Promise<void> {
	// Best effort: the file can still disappear before it is read, which is then fatal.
	await access(path);
}

/**
 * Yields the URLs in a file lazily, one per line. Lines are trimmed; blank lines and
 * lines starting with `#` are skipped.
 *
 * @param signal - Stops reading, even while waiting on a file that blocks, such as a
 * named pipe.
 */
export async function* readUrlsFromFile(
	path: string,
	signal: AbortSignal,
): AsyncGenerator<string> {
	// Needed: readline ignores a signal that has already aborted and reads the whole input.
	if (signal.aborted) {
		return;
	}
	const file = createReadStream(path);
	const lines = createInterface({
		input: file,
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
		// Also runs when the caller stops iterating early. Closing readline leaves the file
		// open, so close that too.
		lines.close();
		file.destroy();
	}
}
