# Local full-suite before / after on the final candidate

macOS 27 arm64 developer host (12 CPUs, 48 GiB), Node 24.21.0, npm 11.19.0. Separate worktrees and `npm ci --ignore-scripts` installs, same lockfile, `--retry=0 --cache=false`, isolated runner HOME, no remote credentials. Timing includes compilation; it excludes dependency installation.

| Variant | Build + full E2E | Passed | Failed | Skipped | 1-min load start → end |
| --- | ---: | ---: | ---: | ---: | --- |
| Before (`f287dcb1`, serial) | 1003.783 s | 627 | 2 | 27 | 1.6 → 61.6 |
| After (`47905de7`, 4 workers) | 435.085 s | 627 | 2 | 27 | 61.6 → 38.7 |

**56.66% less time (2.31x faster)**, 96 files / 656 cases, identical per-case inventories and verdicts (`comparison.json`). Both fail the same two pre-existing cases: `hooks-project-isolation-issue373.test.ts` (linked-worktree hook content) and `self-mode-worktrees-808.test.ts` (untracked `last-fetch.json`).

The pair started after two quiet minutes (no Vitest worker, load below 5), but other agent sessions on the same host started test suites during the run. The timings are therefore contaminated, the after run most of all. The verdict comparison is unaffected. For timing without external load, see `../local-clean-b7f0bef8/`: the same baseline against `b7f0bef8`, which differs from `47905de7` only in the OpenCode E2E tests and their one-time binary preparation.
