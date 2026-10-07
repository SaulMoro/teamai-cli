# Full E2E on GitHub Actions
+
+[Paired run 37667247152](https://github.com/SaulMoro/teamai-cli/actions/runs/37667247152): one Ubuntu runner, Node v20.20.2, npm 10.8.2, 4 CPUs. Sequential before/after, separate checkouts and `npm ci --ignore-scripts` installs, same lockfile, retry=0, cache=false, no remote credentials. Includes build and the complete E2E suite; excludes dependency installation. It does not measure full workflow latency.
+
+| Variant | Seconds | Passed | Failed | Skipped |
+| --- | ---: | ---: | ---: | ---: |
+| Before (`f287dcb1`) | 1239.076 | 627 | 2 | 27 |
+| After (`809edbd1`) | 666.264 | 627 | 2 | 27 |
+
+**46.23% less time (1.86x faster)**. Both cover 96 files / 656 cases, with identical complete inventories and verdicts (including duplicate names). Both exit 1: the same linked-worktree hook assertion and OpenCode V1 timeout at 60 seconds also fail in the serial baseline. The workflow intentionally preserves the failure status rather than treating timings as a passing validation.
+
+[Repeated candidate run 37668828557](https://github.com/SaulMoro/teamai-cli/actions/runs/37668828557), final SHA `b7f0bef8`, another runner: **484.218 s (8:04)**, 628 passed / 1 failed / 27 skipped. The OpenCode V1 case passes there; the hook assertion still fails. This demonstrates variability, not a second controlled pair. Source, E2E config, package/lockfile and build inputs are identical between `809edbd1` and `b7f0bef8`; the latter commit changes CI scheduling/docs only.
+
+All JSON reports/metadata are retained here; runner checkout paths are normalized to `/workspace/<variant>`. Original full logs/reports are in the linked Actions artifacts (`e2e-before-after-linux-node20` and `e2e-candidate-repeat-linux-node20`, 30-day retention). Exact commands, versions, timestamps, load and exit codes are in the metadata. The harness and comparator are `.github/scripts/e2e-{measure,compare}.py` on this benchmark-only branch. No benchmark workflow or result file is part of the proposed PR branch.
+