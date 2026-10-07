# Full E2E on GitHub Actions

[Paired run 37682825582](https://github.com/SaulMoro/teamai-cli/actions/runs/37682825582): one `ubuntu-latest` runner (4 CPUs), Node v20.20.2, npm 10.8.2. Before and after run sequentially on the same runner, from separate checkouts with separate `npm ci --ignore-scripts` installs and the same lockfile. `--retry=0 --cache=false`, no remote credentials. Timing includes compilation and the complete E2E suite; it excludes dependency installation and is not total workflow latency.

| Variant | Build + full E2E | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Before (`f287dcb1`, 1 worker) | 971.717 s | 628 | 1 | 27 |
| After (`47905de7`, 2 workers) | 512.032 s | 628 | 1 | 27 |

**47.31% less time (1.90x faster).** Both cover 96 files / 656 cases with identical per-case inventories and verdicts (`comparison.json`, duplicate names counted). The single failure is the same in both: `hooks-project-isolation-issue373.test.ts`, linked-worktree hook content. It is pre-existing and unrelated to worker count.

[Candidate repeat 37682825678](https://github.com/SaulMoro/teamai-cli/actions/runs/37682825678), `47905de7` on another runner: **649.288 s**, 628 passed / 1 failed / 27 skipped, same failure. It shows runner variability; it is not a second pair.

Both workflows exit red on purpose: they keep the suite's exit code instead of treating timings as a green validation. Reports and metadata (commands, versions, timestamps, load averages, exit codes) are here with checkout paths normalized to `/workspace/<variant>` and output paths to `/results`. `source-report-sha256.json` hashes the original artifacts (`e2e-before-after-linux-node20`, `e2e-candidate-repeat-linux-node20`, 30-day retention). Harness: `.github/scripts/e2e-measure.py`; workflows: `.github/workflows/e2e-{before-after,after-repeat}.yml`.
