import { expect, test } from "vitest";
import { VERSION } from "../src/index.ts";

test("package exposes a version", () => {
	expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
