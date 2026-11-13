# Examples

Each folder demonstrates one behaviour, with a URL file and a config file holding that demo's settings. The URLs point at a local demo server, so the results are repeatable and need no internet access.

Start the demo server in one terminal and leave it running:

```sh
pnpm demo-server
```

It listens on ports 8787 and 8788. Because the per-host limit treats each `host:port` as a separate host, the two ports act as two different sites. [`server.ts`](server.ts) lists its routes.

Run the demos from the repository root, in a second terminal. The outputs below are from real runs; timings and some counts vary a little between runs.

## 1. The queue absorbs a burst

```sh
pnpm start -c examples/1-queue-burst/wle.json -f examples/1-queue-burst/urls.txt
```

Twenty pages of about 1.2 MB each are fetched 16 at a time from a local server, so they arrive almost together. One consumer parses them, at tens of milliseconds per page, so some wait on the queue.

```
msg=Finished total=20 ok=20 failed=0 peakQueue=13 …
```

`peakQueue` is above 0 because pages had to wait, but far below `queueCapacity` (100), so nothing was held up. Across runs it was 12–15. In normal use against real sites it stays at 0, because pages arrive more slowly than they are parsed.

## 2. The queue fills up

```sh
pnpm start -c examples/2-queue-full/block.json       -f examples/2-queue-full/urls.txt
pnpm start -c examples/2-queue-full/drop-oldest.json -f examples/2-queue-full/urls.txt
```

Sixty large pages are fetched 32 at a time into a queue that holds only 5, with one consumer. The queue never holds more than `queueCapacity`; what happens when it is full depends on `overflow`:

```
block:        msg=Finished total=60 ok=60 failed=0 peakQueue=5 …
drop-oldest:  msg=Finished total=60 ok=19 failed=41 errors=dropped:41 peakQueue=5 …
```

- **`block`** (the default): when the queue is full, fetching pauses until a consumer makes room. That is backpressure. Every page is processed, and the run takes as long as the consumers need.
- **`drop-oldest`**: the page that has waited longest is evicted to make room, so fetching never pauses. Each evicted URL still gets a record, with `error.kind` `dropped`, so nothing disappears silently. Across runs, 41–45 pages were dropped.

## 3. Host limiting

```sh
pnpm start -c examples/3-host-limit/wle.json -f examples/3-host-limit/urls.txt -v
```

Twelve pages that each take 300 ms: eight on port 8787 and four on 8788. `perHostConcurrency` is 2, so each host serves two at a time and the others wait, even though the global limit (16) has room. `-v` shows each URL's `hostWaitMs`:

```
url=http://127.0.0.1:8787/slow/1?ms=300 ms=322 attempts=1
url=http://127.0.0.1:8787/slow/2?ms=300 ms=310 attempts=1
url=http://127.0.0.1:8788/slow/1?ms=300 ms=310 attempts=1
url=http://127.0.0.1:8788/slow/2?ms=300 ms=311 attempts=1
url=http://127.0.0.1:8787/slow/3?ms=300 ms=612 hostWaitMs=308 attempts=1
url=http://127.0.0.1:8787/slow/4?ms=300 ms=612 hostWaitMs=310 attempts=1
url=http://127.0.0.1:8788/slow/3?ms=300 ms=612 hostWaitMs=309 attempts=1
url=http://127.0.0.1:8788/slow/4?ms=300 ms=612 hostWaitMs=310 attempts=1
url=http://127.0.0.1:8787/slow/5?ms=300 ms=915 hostWaitMs=612 attempts=1
url=http://127.0.0.1:8787/slow/6?ms=300 ms=916 hostWaitMs=612 attempts=1
url=http://127.0.0.1:8787/slow/7?ms=300 ms=1217 hostWaitMs=915 attempts=1
url=http://127.0.0.1:8787/slow/8?ms=300 ms=1218 hostWaitMs=916 attempts=1
msg=Finished total=12 ok=12 failed=0 peakQueue=1 hostWaited=8 maxHostWaitMs=916 …
```

The pages on 8787 go through in pairs, each pair waiting 300 ms longer than the one before. The four pages on 8788 finish early, because their host is not held up by the busy one. The fetch itself always takes about 300 ms; the rest of `ms` is `hostWaitMs`.

## 4. Error isolation

```sh
pnpm start -c examples/4-error-isolation/wle.json -f examples/4-error-isolation/urls.txt
```

Working pages mixed with one URL for each kind of failure: a 404, a 500, a plain-text response, a page over the size limit, a page that never responds, a redirect loop, a refused connection and two invalid URLs. There is also a flaky page that fails once with 503 and then succeeds.

```
✓ http://127.0.0.1:8787/page/1 (3 links, 22 ms)
✗ http://127.0.0.1:8787/status/404 (HTTP 404)
    http_status: HTTP 404
✗ http://127.0.0.1:8787/text (HTTP 200)
    not_html: Content-Type is text/plain
✗ http://127.0.0.1:8787/big/1 (HTTP 200)
    too_large: Body exceeds 1000000 bytes
✗ http://127.0.0.1:8787/hang
    timeout: Timed out after 1000 ms
✗ http://127.0.0.1:8799/
    network: fetch failed: ECONNREFUSED
✓ http://127.0.0.1:8787/flaky/1 (3 links, 52 ms)
…
msg=Finished total=14 ok=5 failed=9 errors=invalid_url:2,http_status:2,not_html:1,too_large:1,network:2,timeout:1 …
```

(Shortened: each ✓ line is followed by its links, and the omitted lines follow the same pattern.)

Every failure becomes its own error record, and all five working pages are still fetched and parsed. The flaky page shows retries at work: in JSONL output its record is `ok` with `"attempts":2`. The run exits with code 2, meaning it completed but some URLs failed.

## 5. Concurrent fetching

```sh
time pnpm start -c examples/5-concurrency/sequential.json -f examples/5-concurrency/urls.txt
time pnpm start -c examples/5-concurrency/concurrent.json -f examples/5-concurrency/urls.txt
```

The same twenty pages, each taking 300 ms to respond, fetched one at a time and then sixteen at a time:

| Config | Fetches at once | Time |
|---|---|---|
| `sequential.json` | 1 | 6.2 s |
| `concurrent.json` | 16 | 0.7 s |

With one at a time, the run is the sum of the waits: 20 × 300 ms. With sixteen, it is two rounds of waiting, plus Node's startup. The fetches overlap because each one spends almost all its time waiting on the network, and Node can wait on many at once.

## 6. Graceful Ctrl-C

```sh
pnpm start -c examples/6-graceful-shutdown/wle.json -f examples/6-graceful-shutdown/urls.txt
```

Thirty pages that each take 2 s, fetched four at a time, so the run would take about 15 s. Press Ctrl-C after about 5 s:

```
✓ http://127.0.0.1:8787/slow/1?ms=2000 (3 links, 2019 ms)
…
✓ http://127.0.0.1:8787/slow/8?ms=2000 (3 links, 2004 ms)
✗ http://127.0.0.1:8787/slow/9?ms=2000
    aborted: Fetch was aborted
…
✗ http://127.0.0.1:8787/slow/12?ms=2000
    aborted: Fetch was aborted
✗ http://127.0.0.1:8787/slow/13?ms=2000
    aborted: Aborted before fetching

Received SIGINT; finishing up. Press Ctrl-C again to quit immediately.
msg=Finished total=13 ok=8 failed=5 errors=aborted:5 …
```

(Each ✓ line is also followed by its links.) The first eight pages had been fetched, so they are output as normal. The four in progress are cancelled straight away and get `aborted` records. Page 13 had just been read from the file when the interrupt arrived, so it gets a record too, without being fetched. Pages 14–30 were never read, so they have no records, and the summary counts the 13 inputs that were read. The exit code is 130.

A second Ctrl-C quits immediately, without the summary. It is there for when the first one cannot finish, for example if the output is a named pipe that nothing reads. With normal output the graceful stop takes milliseconds, so there is rarely time to press it.

## 7. Large input in constant memory

```sh
node examples/7-large-input/generate.ts 100000      # writes examples/7-large-input/urls.txt
pnpm start -c examples/7-large-input/wle.json -f examples/7-large-input/urls.txt > /dev/null
```

The URL file is generated rather than committed, because it is about 3 MB. Reading is lazy: the producer reads the next line only when one of its 64 slots frees up, so memory does not grow with the size of the file. Measured with `/usr/bin/time -f "%e s %M KB"` on Linux (on macOS, use `/usr/bin/time -l`):

| URLs | Time | Peak memory |
|---|---|---|
| 10,000 | 0.8 s | 273 MB |
| 100,000 | 5.2 s | 289 MB |

Ten times the input, almost the same peak memory. Most of that peak is the JavaScript engine choosing to grow its heap during a fast run, not data being kept: the 100,000-URL run also completes with the heap capped at 32 MB (`node --max-old-space-size=32 src/cli.ts …`), just more slowly, because it collects garbage more often.

Output also starts immediately rather than after the file has been read. Piping into `head` shows the first records after about 0.16 s; when `head` closes the pipe, the run stops quietly with exit code 0, having read only about a hundred lines:

```sh
pnpm start -c examples/7-large-input/wle.json -f examples/7-large-input/urls.txt | head -3
```

This demo found a real bug. Each fetch used `AbortSignal.timeout()` for its time limit, and that timer cannot be cancelled, so every finished fetch stayed in memory until its 10-second timeout expired. At thousands of URLs a second, peak memory grew with the input (544 MB for 100,000 URLs) and the 32 MB run crashed. The fetcher now uses its own timer and cancels it when the fetch finishes, and a test guards against both forms of the mistake.

## Live sites

[`urls.txt`](urls.txt) in this folder uses real websites instead of the demo server: working pages, a redirect, and one URL for each kind of failure that is easy to reproduce on the public web. Link counts change as the sites change.

```sh
pnpm start -f examples/urls.txt --format text
```
