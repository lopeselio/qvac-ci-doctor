# qvac-ci-doctor

**Find out why CI failed, without reading 86,000 lines of log.** ci-doctor reads a GitHub Actions run, finds the first real error, tells you whether it's a real failure or a flaky one worth a rerun, and points at the exact log lines. It can post that on the pull request as one comment that updates itself.

Rules make the diagnosis. Optionally, a small local model running on [Tether QVAC](https://docs.qvac.tether.io/) explains it in plain words, but its answer is only shown if it passes checks: it must cite log lines it was actually shown, and it can't name files that aren't in the log or contradict the verdict.

```console
$ ci-doctor run https://github.com/tetherto/qvac/actions/runs/42001014530
✖ Real failure: needs a fix

npm can't find @qvac/registry-client@^0.8.0
  job: SDK Pod Checks · step: Run SDK pod checks
  No published version of @qvac/registry-client matches ^0.8.0.

  Evidence (lines 303–306):
     303 │ npm error code ETARGET
     304 │ npm error notarget No matching version found for @qvac/registry-client@^0.8.0.
     …
  Fix: Check what's published with `npm view @qvac/registry-client versions`. If this change is
  the release of @qvac/registry-client, it was requested before it was published: publish first,
  or keep depending on the last published version until it is.

Context:
  • This change edited packages/inference/package.json, and the failure is a dependency error.

Also failed after this (37, may follow from it):
  • TypeScript: 8 errors in 7 files (line 3757)
  • Test failed: audioGen client collects progress, PCM, stats, and requestId (line 3796)
  … and 35 more
```

That run's log is 86,232 lines with 13 failed checks. The first error explains all of them: a release PR asked npm for a version before it was published.

## How it decides

1. **Read the log.** It reads `gh run view --log-failed` output, a raw job log, or any plain text. Every line keeps its original number, its job and its step.
2. **Detect.** Detectors recognise one kind of failure each, and record the lines they relied on. The coverage:
   - **Tests:** TAP (brittle, tape, node:test), Jest, Vitest, node:test, mocha, CTest, cargo test / nextest.
   - **Code and build:** TypeScript, ESLint, Lunte, standard, Prettier, Knip, C/C++ compilers, rustc, node-gyp, coverage thresholds.
   - **npm:** missing versions, lockfile drift, peer conflicts, auth, git dependencies.
   - **Dependabot.**
   - **The runner:** network errors, out-of-memory, disk, lost runners, timeouts.
3. **Pick the root.** In each failing job, the root is the earliest specific error. When a dependency fails to install, every later typecheck, build and test fails too, and only the first error is worth fixing. Everything after it is listed as "may follow from it".
4. **Merge the matrix.** The same cause in several matrix jobs is reported once.
5. **Real or flaky.**
   - **Likely flaky:** network errors and lost runners.
   - **Possibly flaky:** timeouts and running out of memory.
   - **Real:** everything else.
   - A "possibly flaky" failure that hits **three or more jobs the same way** counts as real, because random failures don't repeat that neatly.
6. **Context** (with `gh`):
   - which matrix jobs passed ("fails on Windows, passes on Linux");
   - whether the change touched the failing file or a `package.json`;
   - whether the default branch was already red.
7. **When logs have expired** (GitHub keeps them 90 days), it falls back to the failing job, step and annotations, and says so.

## The local model, and why it can't make things up

`--explain` loads a small model with QVAC (Qwen3 1.7B by default). Before downloading, it checks that the model fits in memory with `assessModelFit()`. The model gets the rule-based facts and a short excerpt of the log, with each line tagged `E1`, `E2`, …. It must reply in JSON and cite tags as evidence. Its answer is **discarded** if:

- it isn't the JSON asked for, or a field is missing or too long;
- it cites a tag it wasn't shown;
- it names a file, path or package that appears nowhere in the facts or the log;
- it suggests rerunning a failure the rules call real.

CI logs are untrusted: a test can print anything, including instructions aimed at a model. The log goes in clipped and stripped of control characters, and it's marked as data. Nothing the model says can change the verdict, and the rule-based fix is always shown.

**Measured** on a MacBook with Apple Silicon:

| Set | Explanations that passed the checks | Average time |
|---|---|---|
| 19 labelled fixtures | 19 / 19 | 0.6 s |
| 10 real Tether and Holepunch failures | 10 / 10 | 0.9 s |
| 10 held-out real failures | 8–9 / 10 across three runs (the model isn't fully deterministic) | 0.9 s |

An earlier version cited plain line numbers, and only half its answers passed. The model kept confusing log line 833 with the `:833` in `test/basic.js:833`. Tagging lines `E1`, `E2`, … fixed that.

Passing the checks means the answer is grounded in the log, not that its reasoning is right. I read all 9 accepted answers from the held-out batch:
- 5 were accurate and useful;
- 2 were vague (one restated mocha's generic hint, another proposed a null check that could hide the bug);
- 2 had a wrong detail.

That's why the model's text is labelled as such, and is shown under the rule-based diagnosis rather than replacing it.

## Accuracy

`ci-doctor eval <dir>` scores the tool on logs with known answers. Each log sits next to a `name.expect.json` file, for example `{ "verdict": "failure", "root": "test-failed", "file": "test/basic.js" }`. CI runs it on the fixtures in this repository and fails below 100%.

I also tested it on real failures from public repositories, mostly Tether and Holepunch projects plus Fastify, Undici, Vite, npm, ESLint, Mocha, Prisma and others. They came in four batches of logs the tool had never seen. Each batch was scored **before** changing anything, then every miss was fixed:

| Batch | Right first time (blind) | Misses that led to new detectors or fixes |
|---|---|---|
| 1 | 3 / 7 | coverage thresholds, CTest (with AddressSanitizer), Dependabot |
| 2 | 4 / 6 | Knip, node-gyp, Python stdout errors, node:test summaries, brittle stacks |
| 3 | 4 / 9 | Lunte, C/C++ compile errors, Rust tests, mocha summaries, a network false positive |
| 4 | 7 / 10 | npm's release-age setting, node:test GitHub reporter, mocha across jobs |
| 5 | 1 / 2 | bundler resolution errors (Metro, webpack, Vite, esbuild), naming the package that made the import |

All 34 now pass, along with the 19 fixtures and the 10 logs used during development, but only the blind column is a fair measure. Batch 5 was two real failures from the [Pocket Tune](https://github.com/lopeselio/qvac-pocket-tune) repository: a missing `@expo/config-plugins` was diagnosed correctly, but an Expo build that failed because `expo-asset`'s `"*"` peer dependency pulled in a newer major was "cause unclear" until the bundler detector was added. That log is now a fixture. Expect it to miss formats it hasn't met. When that happens it says "cause unclear" (exit 3) rather than guessing.

## Use it

```bash
git clone https://github.com/lopeselio/qvac-ci-doctor && cd qvac-ci-doctor
npm install
npm link        # optional: puts `ci-doctor` on your PATH
```

Node.js 22+. `run` and `latest` need the [GitHub CLI](https://cli.github.com/) (`gh auth login`); `log` and `eval` don't.

```
ci-doctor run <run-id | run URL>     diagnose a GitHub Actions run
ci-doctor latest [--branch b]        diagnose the latest failed run in this repository
ci-doctor log <file | ->             diagnose any log file, or stdin
ci-doctor eval <dir>                 score it against logs with known answers
```

| Option | |
|---|---|
| `-R, --repo owner/name` | Repository (default: the one you're in) |
| `--comment` | Post the diagnosis on the PR (one comment, updated on later failures), or on the commit |
| `--markdown`, `--json` | Output format (text by default) |
| `--explain` | Add the local model's explanation (`npm install @qvac/sdk`) |
| `--model <const>` | QVAC model for `--explain` (default `QWEN3_1_7B_INST_Q4`) |
| `--no-context` | Skip the PR, diff and default-branch lookups |
| `--min <0..1>` | With `eval`, exit 1 below this root-cause accuracy |
| `--exit-zero` | Always exit 0 |

**Exit codes:** `0` nothing failed · `1` worth a rerun (likely or possibly flaky) · `2` real failure · `3` failed, cause unclear. Scripts can use them, for example to rerun only flaky jobs.

## In GitHub Actions

Add [`examples/ci-doctor.yml`](examples/ci-doctor.yml) to `.github/workflows/`. It runs when your `CI` workflow fails and comments on the pull request:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  actions: read
  checks: read
  contents: read
  pull-requests: write
jobs:
  diagnose:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - uses: lopeselio/qvac-ci-doctor@main
```

- **What it writes:** the action also writes the diagnosis to the job summary, and sets a `verdict` output (`passed`, `flaky`, `failure` or `unknown`).
- **Safe for fork PRs:** `workflow_run` runs with the base repository's permissions. ci-doctor only reads logs and posts a comment, and never checks out or runs the pull request's code.
- **Comment safety:** log text is escaped, and `@mentions` are wrapped in code, so a log can't ping people or inject HTML.
- **The model in CI:** `explain: 'true'` downloads about 1 GB the first time. Cache `~/.qvac` between runs.

This repository runs ci-doctor on its own CI failures ([`.github/workflows/ci-doctor.yml`](.github/workflows/ci-doctor.yml)).

## Library

```js
import { diagnose, renderText, diagnoseRun, renderMarkdown } from 'qvac-ci-doctor'

const d = diagnose(logText)          // any log text; no network
d.verdict                            // 'failure' | 'flaky' | 'maybe-flaky' | 'unknown'
d.causes[0].finding                  // { id, title, detail, file, line, fix, lines: [evidence line numbers] }
console.log(renderText(d))

const { run, diagnosis, context } = await diagnoseRun({ ref: 'https://github.com/o/r/actions/runs/123' })
```

## Limitations

- **Formats it doesn't know.** It recognises the formats listed above. For anything else, it falls back to the step and exit code, and says the cause is unclear.
- **It reads, it doesn't run.** It can say a test timed out, not why. The flaky call is a judgement from the error type and how many jobs failed, not from rerunning anything.
- **"Earliest specific error" is usually, not always, the cause.** Later failures are listed so you can check.
- **The model's explanation is optional.** It can be vague or wrong in its reasoning even when it passes the checks.

## Development

```bash
npm test                                   # unit tests, plus every labelled fixture
node bin/ci-doctor.js eval test/fixtures   # accuracy table
```

## License

Apache-2.0
