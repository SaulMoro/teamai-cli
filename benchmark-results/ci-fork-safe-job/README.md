# Fork-safe E2E job, before / after, committed settings

[Actions run 37691810030](https://github.com/SaulMoro/teamai-cli/actions/runs/37691810030) reproduces the `E2E (fork-safe, no credentials)` job as each version commits it, on one `ubuntu-latest` runner with Node 20: same git identity step, no remote credentials, committed `retry: 1`, no cache/HOME/retry overrides. Both checkouts are installed and built first; timing covers the test command only, because that job downloads a prepared `dist`.

| Variant | Command | Tests | Exit | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Before (`f287dcb1`) | `npm run test:e2e` (serial) | 1057.090 s | 0 | 629 | 0 | 27 |
| After (`47905de7`) | `npx vitest run --config vitest.e2e.config.ts` (2 workers) | 562.808 s | 0 | 629 | 0 | 27 |

**46.76% less time (1.88x faster)**, 96 files / 656 cases, identical per-case verdicts. In both variants exactly one case needs its retry: `issue #373 … shares one ungated Claude/Codex team-hook file in the main checkout with a linked worktree` (`retry x1`). Workflow: `.github/workflows/e2e-fork-safe-ab.yml`; full logs in the `e2e-fork-safe-ab` artifact (30 days).
