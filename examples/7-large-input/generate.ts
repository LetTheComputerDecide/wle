import { createWriteStream } from "node:fs";

// Writes urls.txt next to this script: one URL per line, for the demo server.
//
//   node examples/7-large-input/generate.ts [count]     (default 100000)

const count = Number(process.argv[2] ?? 100_000);
const path = new URL("urls.txt", import.meta.url);
const file = createWriteStream(path);
for (let page = 1; page <= count; page++) {
	if (!file.write(`http://127.0.0.1:8787/page/${page}\n`)) {
		await new Promise((resolve) => file.once("drain", resolve));
	}
}
file.end(() => console.log(`Wrote ${count} URLs to ${path.pathname}`));
