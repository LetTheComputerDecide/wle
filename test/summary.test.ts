import { describe, expect, test } from "vitest";
import { percentile } from "../src/summary.ts";

describe("percentile", () => {
	test.each([
		[[7], 0.5, 7],
		[[7], 0.95, 7],
		[[1, 2, 3, 4], 0.5, 2],
		[[1, 2, 3, 4], 0.95, 4],
		[Array.from({ length: 100 }, (_, i) => i + 1), 0.95, 95],
		[[1, 2, 3], 0, 1],
	])("nearest rank of %j at %d is %d", (values, p, expected) => {
		expect(percentile(values, p)).toBe(expected);
	});
});
