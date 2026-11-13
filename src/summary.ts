import type { ErrorKind } from "./errors.ts";
import type { PageRecord } from "./records.ts";

/** Totals for one pipeline run. */
export interface Summary {
	/** Records emitted; one per input read. */
	total: number;
	ok: number;
	failed: number;
	/** Failures by kind, including `dropped`. */
	errors: Partial<Record<ErrorKind, number>>;
	/** Most pages buffered on the queue at once; near capacity suggests slow consumers. */
	peakQueueSize: number;
	/** URLs that waited for a free slot on their host; many suggests `perHostConcurrency` is the limit. */
	hostWaited: number;
	/** Longest host wait for one URL, summed over its attempts; 0 when none waited. */
	maxHostWaitMs: number;
	/** Fetch duration percentiles over URLs that were actually fetched. */
	fetchMs: { p50: number; p95: number } | undefined;
}

/** Accumulates records into a {@link Summary}. */
export class SummaryCollector {
	#ok = 0;
	#failed = 0;
	readonly #errors: Partial<Record<ErrorKind, number>> = {};
	readonly #durations: number[] = [];
	#hostWaited = 0;
	#maxHostWaitMs = 0;

	add(record: PageRecord): void {
		if (record.status === "ok") {
			this.#ok++;
		} else {
			this.#failed++;
			const { kind } = record.error;
			this.#errors[kind] = (this.#errors[kind] ?? 0) + 1;
		}
		if (record.attempts > 0) {
			this.#durations.push(record.durationMs);
		}
		if (record.hostWaitMs > 0) {
			this.#hostWaited++;
			this.#maxHostWaitMs = Math.max(this.#maxHostWaitMs, record.hostWaitMs);
		}
	}

	finish(peakQueueSize: number): Summary {
		const sorted = this.#durations.toSorted((a, b) => a - b);
		return {
			total: this.#ok + this.#failed,
			ok: this.#ok,
			failed: this.#failed,
			errors: { ...this.#errors },
			peakQueueSize,
			hostWaited: this.#hostWaited,
			maxHostWaitMs: this.#maxHostWaitMs,
			fetchMs:
				sorted.length === 0
					? undefined
					: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) },
		};
	}
}

/** Nearest-rank percentile of an ascending, non-empty array; `fraction` is e.g. 0.95 for p95. */
export function percentile(
	sorted: readonly number[],
	fraction: number,
): number {
	const rank = Math.max(1, Math.ceil(fraction * sorted.length));
	return sorted[rank - 1] as number;
}
