import { spawn } from "node:child_process";
import { once } from "node:events";
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
	const exited = once(child, "exit").then(([code]) => code as number);
	return { child, exited, output: () => ({ stdout, stderr }) };
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
	const { child, exited, output } = spawnCli(["-"]);
	// Waiting on stdin that never ends. Hold the run open with a fetch that hangs.
	child.stdin.write(`${server.url("/hang")}\n`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	child.kill("SIGINT");
	await waitFor(() => output().stderr, "Received SIGINT");
	child.kill("SIGINT");
	expect(await exited).toBe(130);
});
