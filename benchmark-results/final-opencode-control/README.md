# OpenCode concurrency control on the final candidate
+
+[Actions run 37672715031](https://github.com/SaulMoro/teamai-cli/actions/runs/37672715031) succeeds on `dec401fc5efab9a9871f35126213dee6fc2c52ec`. Same Linux runner, Node 20, same compiled CLI and dependencies. The worker config keeps normal isolation; both control runs override retry=0 and cache=false. No remote credentials.
+
+The hooks and recall files use one shared native OpenCode executable. Their in-test installers previously unlinked/recreated it independently. The candidate invokes the installer once through Vitest globalSetup before workers and removes both per-file installers, preserving all test assertions.
+
+| Mode | Passed | Failed | Skipped |
+| --- | ---: | ---: | ---: |
+| 1 worker, fileParallelism=false | 2 | 0 | 1 |
+| 2 workers, fileParallelism=true | 2 | 0 | 1 |
+
+Complete verdicts are identical. The skipped case is optional OpenCode V2. The exact commands are in `.github/workflows/e2e-opencode-control.yml` at benchmark commit `d24600615b1b3fb4beb7a050e7ede978c1e79b99`; logs/reports are retained in its `opencode-concurrency-control` artifact for 30 days. The JSON reports here normalize checkout paths to `/workspace/after`. This focused control supplements, rather than replaces, the full-suite A/B.
+