import { readFileSync } from "node:fs";

/** Read at runtime so it works from both `src/` and `dist/`, which sit beside package.json. */
const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/** This package's version, from package.json. */
export const VERSION = packageJson.version;
