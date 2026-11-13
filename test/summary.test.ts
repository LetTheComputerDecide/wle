import { describe, expect, test } from "vitest";
import type { PageRecord } from "../src/records.ts";
import { percentile, SummaryCollector } from "../src/summary.ts";

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

describe("SummaryCollector", () => {
	const okRecord = (hostWaitMs: number): PageRecord => ({
		inputIndex: 0,
		url: "https://x/",
		status: "ok",
		finalUrl: "https://x/",
		httpStatus: 200,
		links: [],
		attempts: 1,
		durationMs: 100,
		hostWaitMs,
	});

	test("counts URLs that waited for their host, and the longest wait", () => {
		const collector = new SummaryCollector();
		for (const wait of [0, 30, 0, 80]) {
			collector.add(okRecord(wait));
		}
		expect(collector.finish(0)).toMatchObject({
			hostWaited: 2,
			maxHostWaitMs: 80,
		});
	});

	test("reports zero when no URL waited", () => {
		const collector = new SummaryCollector();
		collector.add(okRecord(0));
		expect(collector.finish(0)).toMatchObject({
			hostWaited: 0,
			maxHostWaitMs: 0,
		});
	});
});
