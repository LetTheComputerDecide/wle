import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startServer, type TestServer } from "./helpers/server.ts";

// End-to-end through a real process: signals, exit codes and stdout flushing.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let server: TestServer;
beforeAll(async () => {
	server = await startServer();
});
afterAll(() => server.close());

async function tempDir() {
	return mkdtemp(join(tmpdir(), "wle-cli-"));
}

function spawnCli(args: string[]) {
	const child = spawn(process.execPath, [CLI, ...args], { stdio: "pipe" });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exit = once(child, "exit");
	const exited = exit.then(([code]) => code as number);
	const signalled = exit.then(([, signal]) => signal as NodeJS.Signals | null);
	return { child, exited, signalled, output: () => ({ stdout, stderr }) };
}

/** Polls captured output; iterating the stream itself would destroy it on exit. */
async function waitFor(read: () => string, text: string) {
	while (!read().includes(text)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("exits 0 and prints every record", async () => {
	const { exited, output } = spawnCli([server.url("/html"), server.url("/a")]);
	expect(await exited).toBe(0);
	expect(output().stdout.trim().split("\n")).toHaveLength(2);
});

test("SIGINT finishes gracefully: records flushed, summary logged, exit 130", async () => {
	const { child, exited, output } = spawnCli([
		"--timeout-ms",
		"60000",
		server.url("/html"),
		server.url("/hang"),
	]);
	await waitFor(() => output().stdout, `"status":"ok"`);
	child.kill("SIGINT");
	expect(await exited).toBe(130);

	const { stdout, stderr } = output();
	expect(stdout).toContain(`"kind":"aborted"`);
	expect(stderr).toContain("Received SIGINT");
	expect(stderr).toContain("msg=Finished total=2");
});

test("a second SIGINT quits immediately", async () => {
	// Opening a named pipe for writing blocks until something reads it, and the abort
	// signal cannot interrupt that, so only the second SIGINT can end this run.
	const fifo = join(await tempDir(), "out.fifo");
	execFileSync("mkfifo", [fifo]);
	const { child, signalled, output } = spawnCli([
		"--out",
		fifo,
		server.url("/html"),
	]);
	await new Promise((resolve) => setTimeout(resolve, 300));
	child.kill("SIGINT");
	await waitFor(() => output().stderr, "Received SIGINT");
	child.kill("SIGINT");
	// Ended by the signal itself, which shells report as exit status 130.
	expect(await signalled).toBe("SIGINT");
});
