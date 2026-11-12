#!/usr/bin/env node
import { EXIT, main } from "./main.ts";

const controller = new AbortController();

// First signal: stop reading input and cancel fetches, but still flush records and the
// summary. Second signal: give up immediately.
const onSignal = (signal: NodeJS.Signals) => {
	if (controller.signal.aborted) {
		process.exit(EXIT.interrupted);
	}
	process.stderr.write(
		`\nReceived ${signal}; finishing up. Press Ctrl-C again to quit immediately.\n`,
	);
	controller.abort();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// Set exitCode rather than calling process.exit(), so buffered stdout is fully flushed.
process.exitCode = await main(process.argv.slice(2), {
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
	signal: controller.signal,
});
