# How AI was used

The brief encouraged agentic AI, so I used it heavily: Claude Code, working in this repository. This note covers what I delegated, what I decided myself, and how I checked the output.

## Process

1. **Design first, through a structured interview.** Before any code, I had the agent question me about the design, one round of decisions at a time. Each question came with a recommendation, and I accepted, changed or rejected each one. The result is [`PLAN.md`](PLAN.md), which was committed before any code.
2. **Build in risk order, with one commit per step**: queue, then extractor, then fetcher, then pipeline, then CLI, then Docker, then docs. The git history shows each step separately.
3. **Every step verified before committing**: lint, strict type-check, tests, then the tests rerun several times to catch flakiness.

## Decisions I made, including overriding recommendations

- **Language.** The team uses the JVM, but I have no JVM experience, so I chose TypeScript, which I know well. Python was also on the table.
- **A hand-written queue instead of Effect.** The agent recommended Effect, since `Queue.sliding` maps directly onto the brief. I chose plain TypeScript, so a reviewer can read the code without learning a framework. Trying libraries first was my idea.
- **No coverage gate.** The agent proposed failing CI below 90%. I dropped it; the coverage figure is reported instead.
- **Playwright left out, deliberately.** I raised SPAs as a concern. We agreed on a `Fetcher` interface as the extension point, with Playwright documented as a real-world next step rather than built.
- **Configuration from a file as well as flags**, chosen over flags alone, with a published JSON Schema.
- **Docker included.** The agent suggested skipping it; I wanted it.
- **Backpressure (`block`) as the default overflow policy**, with `drop-oldest` behind a flag, and every eviction reported as a record rather than lost silently.

## How I checked the AI's work

- **Mutation checks on the generated tests.** Tests that pass on the first run prove little. For the queue and the link extractor, the agent planted bugs on purpose and confirmed the tests failed. One planted bug (removing the whitespace trim) was *not* caught by the property tests, only by the example tests. The README explains why that is expected, and why both kinds of test are kept.
- **Repeated test runs** (3–5 in a row) after each step that added timing-dependent tests: fetcher, pipeline and CLI.
- **Manual runs of the real CLI** against a throwaway local server and real sites: exit codes, stdout/stderr separation, Ctrl-C, `| head`, and the Docker image running as non-root.
- **Checking claims in the docs against reality.** For example, the sample output in the README was first written by hand, then replaced with output from a real run.

## Bugs found during development

These are the ones the process above caught, which is the point of having it:

- `Retry-After: -5` was being parsed as a date in the year −5. Fixed by accepting only real HTTP dates.
- When an interrupt arrived while the producer was waiting for the next input, the URL just read from stdin was silently discarded. That broke the "one record per input" rule. A pipeline test caught it; the URL now gets an `aborted` record.
- The first version of the producer could leave promise rejections unhandled if one task failed while others were still running. The fix lets in-flight work settle and reports the first failure.
- A failing output sink combined with a full queue could deadlock the run. The fix aborts the run and drains the queue, and it's now tested explicitly.
- A test helper consumed a child process's stdout with `for await` and broke out of the loop early. That destroys the stream, and the child then failed with a broken pipe. The helper now watches the output already being collected.

## What I'd want a reviewer to know

The architecture, the trade-offs and the scope decisions are mine. The agent wrote most of the code and tests under that direction, and I reviewed the code.
