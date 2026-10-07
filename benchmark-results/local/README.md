# Local full-suite before / after

Measured on 2026-10-07, sequentially on one macOS 27 arm64 developer host (12 CPUs, 48 GiB), Node 24.21.0, npm 11.19.0. Each checkout has its own `npm ci --ignore-scripts` installation. The lockfile is identical.

| Variant | Build + full E2E | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Before (`f287dcb1`) | 961.052 s | 627 | 2 | 27 |
| After (`b7f0bef8`) | 293.514 s | 627 | 2 | 27 |

Observed reduction: **69.46% (3.27x faster)**. Both runs cover 96 files / 656 cases. The complete per-case inventories and verdicts, including duplicate test names, are identical. Both exit with code 1 due to the same two baseline failures: `hooks-project-isolation-issue373.test.ts` (hook content) and `self-mode-worktrees-808.test.ts` (untracked `last-fetch.json`). This is performance evidence, not a claim that the local suite is green.

Before: `npm run build`, then `npm run test:e2e -- --retry=0 --cache=false --reporter=default --reporter=json --outputFile.json=/results/before.json`.

After: `npm run test:e2e -- --retry=0 --cache=false --reporter=default --reporter=json --outputFile.json=/results/after.json` (includes the new pretest build).

The harness is `.github/scripts/e2e-measure.py` on this benchmark branch. No case selection or exclusion override. Remote credentials absent; runner HOME isolated; fixture-specific HOME retained. Retries are disabled in both measurements, while the candidate's normal default remains one retry. Vitest cache is disabled in both. Timing excludes dependency installation and includes compilation.

An additional full candidate run took **328.597 s (5:28.597)** with the same 656 per-case verdicts and exit code 1. This shows runtime variability; it is not a second paired baseline.

One complete pair, baseline first: these are observed timings, not statistical medians. The reports and metadata below retain all case results, commands, versions, timestamps, load averages and elapsed time. Checkout/output paths are normalized to `/workspace/<variant>` and `/results`; the source report hashes record the originals retained outside the PR checkout. No implementation or assertion changes are included in this benchmark branch's evidence files.

Additional focused checks used the committed `retry=1`: `npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/hooks-project-isolation-issue373.test.ts --cache=false` passes both cases in both variants; the linked-worktree case passes on its retry in both. `npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/self-mode-worktrees-808.test.ts --cache=false -t "lets a checkout pull and contribute"` fails the same last-fetch assertion in both variants. These focused checks are validation, not timed A/B measurements.

Concurrency control on the same final candidate: run both affected files with `-t "issue #373|lets a checkout pull and contribute" --retry=0 --cache=false`, once with `--maxWorkers=1 --fileParallelism=false`, then with `--maxWorkers=4`. Both return exit 1: one pass, the same two failures, 28 filtered-out cases. Complete verdicts are identical. `candidate-workers-{1,4}.json` and `concurrency-control.json` record this focused reproduction separately from the full-suite timing data. These two failures reproduce without file parallelism.
