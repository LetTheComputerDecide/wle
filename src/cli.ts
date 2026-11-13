#!/usr/bin/env node
import { main } from "./main.ts";

const controller = new AbortController();

// First signal: stop reading input and cancel fetches, but still flush records and the
// summary. Second signal: give up immediately.
const onSignal = (signal: NodeJS.Signals) => {
	if (controller.signal.aborted) {
		// Not process.exit(): it waits for Node's worker threads, so it hangs if one is stuck
		// in a blocking call (such as opening a named pipe nobody reads). Re-raising the
		// signal with our handlers removed lets the OS end the process; shells report 130.
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		process.kill(process.pid, signal);
		return;
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
	stdout: process.stdout,
	stderr: process.stderr,
	signal: controller.signal,
});
