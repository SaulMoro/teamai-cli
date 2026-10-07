# OpenCode worker control

[Actions run 37682825709](https://github.com/SaulMoro/teamai-cli/actions/runs/37682825709) on `47905de7`: both OpenCode E2E files (hooks and recall), same runner, compiled CLI and dependencies, `--retry=0 --cache=false`.

| Mode | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| 1 worker, `fileParallelism=false` | 2 | 0 | 1 |
| 2 workers | 2 | 0 | 1 |

The skipped case is the optional OpenCode V2 binary. Commands: `.github/workflows/e2e-opencode-control.yml`. Reports normalize checkout paths to `/workspace/after`.
