import type { PageRecord } from "./records.ts";

export type OutputFormat = "jsonl" | "text";

export function formatRecord(record: PageRecord, format: OutputFormat): string {
	return format === "jsonl"
		? `${JSON.stringify(record)}\n`
		: formatText(record);
}

function formatText(record: PageRecord): string {
	if (record.status === "error") {
		const status =
			record.httpStatus === undefined ? "" : ` (HTTP ${record.httpStatus})`;
		return `✗ ${record.url}${status}\n    ${record.error.kind}: ${record.error.message}\n`;
	}
	const count =
		record.links.length === 1 ? "1 link" : `${record.links.length} links`;
	const redirected =
		record.finalUrl === record.url ? "" : ` → ${record.finalUrl}`;
	const lines = [
		`✓ ${record.url}${redirected} (${count}, ${record.durationMs} ms)`,
	];
	for (const link of record.links) {
		lines.push(`    ${link}`);
	}
	return `${lines.join("\n")}\n`;
}
