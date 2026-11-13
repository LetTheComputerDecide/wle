# Plan: `wle`, a concurrent link extractor

Producer fetches markup for a list of URLs onto a queue; consumers parse it and emit the hyperlinks found on each page. This file records the agreed design; the README explains it to readers.

## Stack

- Node 26 (native TypeScript type stripping), `tsc --strict` for type checking
- pnpm, vitest (v8 coverage), Biome (lint and format)
- Native `fetch` (undici), htmlparser2 (event mode), `p-limit`, zod, fast-check

## Architecture

The core is a library; the CLI is a thin wrapper around it.

| Module                  | Responsibility                                                                    |
| ----------------------- | --------------------------------------------------------------------------------- |
| `src/extract.ts`        | Pure `extractLinks(html, pageUrl): string[]`                                      |
| `src/queue.ts`          | Hand-written `BoundedQueue<T>`                                                    |
| `src/fetcher/static.ts` | `Fetcher` implementation over native `fetch`                                      |
| `src/producer.ts`       | Reads inputs, fetches concurrently, puts pages on the queue                       |
| `src/consumer.ts`       | Drains the queue, extracts links, emits records                                   |
| `src/pipeline.ts`       | Wires producer, queue and consumers; fetcher, sink, clock and logger are injected |
| `src/output.ts`         | JSONL and text formatters                                                         |
| `src/config.ts`         | zod schema, defaults, config-file loading, merging                                |
| `src/cli.ts`            | Argument parsing and wiring only                                                  |

### Link extraction

- Only `<a href>` counts as a hyperlink.
- Resolve against `<base href>` (itself resolved against the page URL), then against the final page URL.
- Strip fragments; de-duplicate preserving first-seen order.
- Keep `mailto:` and `tel:`; drop script-like links (`javascript:`, `data:`, `vbscript:`) and empty, fragment-only or unparseable hrefs.

### Queue

- `BoundedQueue<T>({ capacity, overflow: "block" | "drop-oldest", onDrop })`
- `put(item): Promise<void>` waits when full (`block`) or evicts the oldest item (`drop-oldest`), which calls `onDrop` so it becomes a `dropped` record.
- `close()` marks end of input; `[Symbol.asyncIterator]` ends once the queue is closed and drained.
- FIFO-fair waiters; multiple producers and consumers.
- `p-limit` bounds global fetch concurrency; a map of `p-limit` instances bounds per-host concurrency.

### Fetching

- Per-request timeout (`AbortSignal.timeout`), max body size (stream cut off at the cap).
- Content-type gate: non-`text/html` is recorded as `not_html`.
- Follow redirects; the final URL is the base for link resolution.
- Charset from `Content-Type`, falling back to UTF-8.
- Retry network errors, 5xx and 429 with full-jitter backoff, honouring `Retry-After`; never retry other 4xx.
- Custom User-Agent.
- Deliberately out of scope (documented): Playwright/SPA rendering (the `Fetcher` interface is the extension point), robots.txt, worker threads for parsing.

### Configuration

- Sources, lowest to highest precedence: defaults, `--config file.json`, CLI flags. No auto-discovery.
- One zod schema validates the merged result; invalid config exits with code 1 and a clear message.
- A JSON Schema (`config.schema.json`) is generated from the zod schema.
- URLs never come from the config file. Inputs: positional args, `--file`, or stdin via `-`, read lazily.

| Setting                  | Default                               |
| ------------------------ | ------------------------------------- |
| Global fetch concurrency | 16                                    |
| Per-host concurrency     | 4                                     |
| Consumers                | 2                                     |
| Queue capacity           | 100                                   |
| Overflow                 | `block`                               |
| Timeout                  | 10 s                                  |
| Max body                 | 5 MB                                  |
| Retries                  | 2 (base 250 ms, max 5 s, full jitter) |
| User-Agent               | `wle/<version> (+repo url)`           |

### Output

- Exactly one record per input URL, in completion order, with an `index` back to the input position.
- JSONL by default (`--format=text` for humans), to stdout or `--out`. Logs go to stderr.
- 4xx/5xx pages are not parsed for links.

```json
{"index":3,"url":"…","finalUrl":"…","status":"ok","httpStatus":200,
 "links":["…"],"durationMs":412,"attempts":1}
{"index":4,"url":"…","status":"error","attempts":3,"durationMs":10012,
 "error":{"kind":"timeout","message":"…"}}
```

`error.kind`: `invalid_url | timeout | network | http_status | not_html | too_large | parse | dropped | aborted`.

### Lifecycle and observability

- Ctrl-C: stop reading input, abort in-flight fetches, emit records for queued and in-flight items (`aborted`), flush output.
- Exit codes: `0` all ok, `2` completed with failures or drops, `1` fatal (bad config or arguments).
- Structured logs on stderr (`--verbose`, `--quiet`); end-of-run summary with counts, peak queue depth, p50/p95 fetch time.

## Tests

No coverage gate; the coverage figure is quoted in the README.

- Unit: tricky HTML cases for the extractor, normalisation, queue overflow policies.
- fast-check: model-based tests of the queue against an array model; normalisation properties (absolute, no fragment, no duplicates, idempotent).
- Integration: local `node:http` server with slow, 500, redirect, binary, huge and hanging routes. No real network.
- Concurrency: producer and consumer overlap; no empty-but-not-done race; one failure does not affect others; record count equals input count.

## Deliverables

- GitHub repo with small conventional commits.
- CI: lint, type check, tests, Docker build.
- Multi-stage Docker image on `node:26-slim`, non-root, `ENTRYPOINT ["node", "dist/cli.js"]`.
- README: usage, architecture diagram, assumptions, trade-offs, what I'd do next.
- `AI_NOTES.md`.

## Build order

1. Scaffold, tooling, CI
2. `BoundedQueue` with unit and model-based tests
3. `extractLinks` with tricky-case and property tests
4. Static fetcher against a local test server
5. Producer, consumer, pipeline, concurrency and isolation tests
6. Config, CLI, output, shutdown
7. Docker
8. README, diagram, `AI_NOTES.md`
