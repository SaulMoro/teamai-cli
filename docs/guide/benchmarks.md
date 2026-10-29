# Benchmarks

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

```text
teamai workflow start fix-auth --benchmark --driver local --sandbox
```

A benchmark suite compares tools or models on your team's own tasks. One run gives every task to every arm, a few times each, checks each result, and prints a table. Trials run only on a machine declared a sandbox, such as a CI runner or a container.

## Write a suite

A suite is a directory in the team repo: `benchmarks/<suite>/suite.yaml`, and one file per task in `tasks/`.

```yaml
# benchmarks/fix-auth/suite.yaml
schemaVersion: v1alpha1
name: fix-auth
description: Fix bugs in the auth service.
repo: https://github.com/acme/auth-service.git
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
  - name: strong
    model: strong
repetitions: 3
timeout: 45m
setup:
  command: npm ci
```

| Key | Value |
| --- | --- |
| `repo` | The project the tasks start from: an https, ssh or git URL without credentials. |
| `defaults` | The arm the others are compared with: `tool`, and optionally `model` and `team`. Not a workflow's `defaults`. |
| `arms` | 1 to 6. Each changes at most one `defaults` key, and at most one changes none. |
| `matrix` | Instead of `arms`: lists of values that teamai crosses into arms. See [Cross tools with team assets](#cross-tools-with-team-assets). |
| `team` | The team assets an arm runs with. See [Arms on other team assets](#arms-on-other-team-assets). |
| `model` | A model alias from `models/aliases.yaml`, resolved for each arm's tool when the run starts, or a model name. |
| `repetitions` | 1 to 10, 3 by default. |
| `timeout` | Required: the whole run's. |
| `trial` | Optional limits of every trial's prompt. See [Trial limits](#trial-limits). |
| `setup` | Optional, a [workflow's `setup`](workflow-advanced.md#requirements-and-limits). Runs in every fresh clone before the tool or the check. |
| `scorers` | Optional [scorers](scorers.md) that judge every trial. A name with no valid `scorers/<name>.md` fails `teamai review --branch`, `teamai pull` warns, and start refuses the suite. |

### Arms on other team assets

An arm runs with the team revision this checkout pulled unless it sets `team`. Measure what the team's assets add, a branch before you merge it, or one skill:

```yaml
defaults:
  tool: claude
arms:
  - name: pulled              # the revision you pulled
  - name: bare
    team: none                # no team assets at all
  - name: next
    team: next                # the team repo's branch next
  - name: no-auth-tokens
    team:
      without: [auth-tokens]  # the pulled revision, without this skill
```

| `team` | The arm runs with |
| --- | --- |
| `pulled`, or no `team` | The team revision this checkout pulled. |
| `none` | No team assets. Start refuses it on a machine whose user-scope teamai install delivers to the arm's tool, since its trials would read those assets in your home. |
| A branch, tag or commit | That revision of the team repo, resolved when the run starts. Name a branch as the team repo names it, `next`, not `origin/next`. |
| `without: [<skill>, ...]` | The pulled revision, without these skills. Each must be a skill of that revision. |

### Cross tools with team assets

`matrix` makes one arm for each combination of its values, so every two arms that differ in one value compare that value alone. Here, how much the team's assets help each tool, and which tool does better with them:

```yaml
defaults:
  tool: claude
matrix:
  tool: [claude, codex]
  team: [pulled, none]
```

| Arm | Tool | Team |
| --- | --- | --- |
| `claude-pulled` | claude | pulled |
| `claude-none` | claude | none |
| `codex-pulled` | codex | pulled |
| `codex-none` | codex | none |

A matrix varies `tool`, `model` or `team`, at least one of them with two values or more, and makes 2 to 12 arms. A key it leaves out comes from `defaults`. Each arm's name joins its values for the keys that vary: a ref is used as it is, with a character other than a letter, digit, `-` or `_` written `-`, and `without: [auth-tokens]` is `without-auth-tokens`. A suite has `arms` or `matrix`, not both.

A task starts from a full commit of `repo` and is decided by exactly one of `check` and `successCriteria`:

```yaml
# benchmarks/fix-auth/tasks/expired-token.yaml
schemaVersion: v1alpha1
title: Reject expired refresh tokens
prompt: |
  Refresh tokens past their expiry are still accepted. Fix it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add: [test/auth/refresh.test.ts]
source: { platform: claude-code, sessionId: 7c1e2b9a, fix: 9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e }
```

```yaml
# benchmarks/fix-auth/tasks/login-copy.yaml
schemaVersion: v1alpha1
title: Clearer login error
prompt: Make the login error say which field is wrong.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
successCriteria: The error names the wrong field and still reveals nothing about which accounts exist.
```

| Key | Value |
| --- | --- |
| `startingCommit` | The full commit of `repo` the task starts from. |
| `check` | `run`, a command that exits 0 once the task is done, and `protect`, the paths the agent must not supply. |
| `check.add` | Optional: files written before the check that the agent never has: a file as `source.fix` has it, such as the fix's test, or `{ from, to }`, a file or directory of the suite directory. A directory adds every file under it except its dot entries, such as `.DS_Store`; name a dotfile in `from` to add it. See [Tests the fix brought](#tests-the-fix-brought) and [Tests in the suite directory](#tests-in-the-suite-directory). |
| `successCriteria` | Instead of `check`: a judge decides from these. |
| `source` | Optional: the session the task came from, `platform` and `sessionId`, and `fix`, the full commit that fixed it there, which [`--try`](#try-a-task) checks. |

`teamai pull` and `teamai review --branch` check every file and report each problem with its file and line. A suite in `benchmarks/<namespace>/<suite>/` goes only to members of that role or project, as [Roles and projects](distribution.md#roles-and-projects) describes.

### What `protect` covers

A trial passes when the check exits 0 after the agent's work. Before the check, teamai puts every `protect` path back as the starting commit has it:

```text
the agent left                       the check sees
src/auth/refresh.ts       edited     edited
test/auth/session.test.ts edited     as 3f2c9a7 has it
test/helpers/skip.js      added      deleted
vitest.config.ts          edited     as 3f2c9a7 has it
```

So `protect` lists everything the check reads that the agent must not supply: the tests, the test config, the scripts and helpers they load, and the package manifest and lockfile.

| Do not protect | Why |
| --- | --- |
| A path `setup` writes into, such as a build directory | The restore deletes what setup wrote there. |
| Files git converts on checkout: Git LFS files, files with an `eol=crlf` attribute | Each protected file must hold exactly the bytes the starting commit stores, so the trial ends in `error`. |
| A path in or under a submodule | teamai cannot put a submodule's files back, so the trial ends in `error`. |

A task whose check reads things you cannot list belongs in `successCriteria`.

### Tests the fix brought

When the fix brought the test that proves it, list that test file in `check.add`, also when the fix only added a case to a file the starting commit has. The check reads it as `source.fix` has it; the agent never does:

```text
step                          test/auth/refresh.test.ts
the agent's clone             absent
trial check                   protect restored, then written from 9a1d4e7
baseline at 3f2c9a7           written from 9a1d4e7: the check must fail
--try at 3f2c9a7              written from 9a1d4e7: the check must fail
--try at 9a1d4e7              protect restored, then written from 9a1d4e7: the check must pass
```

| `teamai pull` and `teamai review --branch` refuse | Because |
| --- | --- |
| `check.add` without `source.fix` | The files come from `source.fix`. |
| A `check.add` path no `protect` entry matches | The agent could supply it. |
| A glob in `check.add` | Each entry names one file. |

### Tests in the suite directory

A test the task's commits do not have, such as one you wrote for the task, can live in the suite directory. A `{ from, to }` entry of `check.add` writes it where the check reads it, at the same steps as a fix's test; the agent never has it:

```text
benchmarks/fix-auth/
  suite.yaml
  tasks/expired-token.yaml
  check-files/expired-token/refresh.test.ts
```

```yaml
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add:
    - from: check-files/expired-token/refresh.test.ts
      to: test/auth/refresh.test.ts
```

`from` is a file or a directory of the suite directory; a directory writes every file under it below `to`. Each file is written as bytes, with its executable bit. `teamai pull` keeps the files with the suite, and a run writes them as they were when it started, so a pull during the run changes no check. Editing one changes the task's `sourceHash`. The entry needs no `source.fix`.

| `teamai pull` and `teamai review --branch` refuse | Because |
| --- | --- |
| A `from` that names nothing in the suite directory, leaves it, or is a symlink | Only the suite directory's own files are read. |
| A `to` with `..` or a glob | It names one path in the clone. |
| A `to`, or a file under it, that no `protect` entry matches | The agent could supply it. |
| Two entries that write one path | Each path is written once. |

### Baselines

Before a task's first trial, teamai runs setup and the check once on a fresh clone of the starting commit:

| The check at the starting commit | The task |
| --- | --- |
| fails | Valid: its trials run. |
| passes | `invalid: check passes without changes`, no trials. |
| cannot run | `check could not run`, no trials. |

| A check cannot run when | It is read as |
| --- | --- |
| it exits 127 | `not_found` |
| it exits 126 | `not_executable` |
| it exits 129 to 192, outside Windows | `signal`: a shell reports a killed command as 128 plus the signal. Do not use these as your check's own failure code. |
| it runs past the timeout | `timeout` |

After a prompt, a check that cannot run gives the trial `error`, not `failed`.

### Trial limits

`trial` limits every trial's prompt. Reaching a limit ends the agent's turn, and teamai runs the trial's check, or its judges, on what the agent left, so a tool that runs out of time fails the task rather than the harness:

```yaml
timeout: 45m
trial:
  timeout: 8m
  budget: { tokens: 300000 }
  max_turns: 60
```

| Key | Limits | On the local driver |
| --- | --- | --- |
| `timeout` | The time from the tool's launch. Shorter than the suite's `timeout`, which still ends the whole run. | Stops the tool and every process it started. |
| `budget.tokens` | Input plus output tokens, as a [workflow budget](workflow-advanced.md#requirements-and-limits) counts them. | Counts them from the tool's output as it runs, and stops the tool once they pass the budget, so a trial can go over by its last model call. Codex states its tokens only as it ends, and CodeBuddy's are not counted as it runs: both run to the end, and list `budget` in `unenforced`. A tool that reports no tokens ends its trial `error`, unless another limit stopped it first: then its trial lists `budget` in `unenforced`. |
| `max_turns` | Agent turns, as the tool counts them. | Passes it to Claude. Other tools list `max_turns` in `unenforced`. |

A trial a limit stopped carries `limit` in the record, and counts under "Stopped by a limit". A trial that lists a suite limit in `unenforced` counts as a deviation, so a capped arm is never compared with an uncapped one silently. A run keeps the limits it started with.

## Try a task

Try a new task file before it joins the suite, in a checkout of the suite's `repo`, with the team repo checked out beside it:

```console
$ teamai workflow start fix-auth --benchmark --try ../team/benchmarks/fix-auth/tasks/expired-token.yaml --driver local --sandbox
ℹ Task expired-token: trying the check at 3f2c9a7
ℹ Task expired-token: trying the check at the fix 9a1d4e7, with the protected paths as 3f2c9a7 has them
{"data":{"try":{"task":"expired-token","message":"Task \"expired-token\": the check fails at 3f2c9a7 and passes at the fix 9a1d4e7, with the protected paths as 3f2c9a7 has them."}}}
```

```text
task           at startingCommit      at source.fix (protect restored)   exit
pod-startup    check fails            check passes                       0
old-bug        check passes           not tried                          1: "check passes without changes at 3f2c9a7"
bad-fix        check fails            check fails                        1: "check fails at the fix 9a1d4e7"
test-in-fix    check fails            check fails (fix's test restored)  1: "The fix changes test/startup.test.ts, which protect puts back as 3f2c9a7 has them: list a test the fix brought in check.add"
changed-test   check fails            check passes (check.add written)   0
add-missing    not tried              not tried                          1: "test/missing.test.ts is not a file at the fix 9a1d4e7"
no-fix         check fails            not tried                          0: "the check was not tried on a fix"
criteria-only  no check               no check                           0: "there is no check to try"
missing-tool   could not run          not tried                          1: names the command and 3f2c9a7
setup-error    setup failed           not tried                          1: names setup and 3f2c9a7
```

`--try` reads the task file and the `suite.yaml` two directories up from it as they are written, validates both as `teamai pull` does, with the files its `check.add` entries name from that suite directory, and checks that `<suite>` is that suite's `name`. It needs no `teamai init`. A commit the checkout lacks is fetched by SHA from the suite's `repo`, as a run does. Each commit gets a fresh clone, the suite's `setup`, the environment a trial gets (see [Run a suite](#run-a-suite)), and the suite's `timeout`. It creates no run and no record, and needs `--sandbox`, since the check runs the project's code.

## Run a suite

```console
$ teamai workflow start fix-auth --benchmark --driver local --sandbox
ℹ Run r38302f8e6a18c377 started. If it stops before it ends, continue it with: teamai workflow resume r38302f8e6a18c377 --sandbox
ℹ Baseline expired-token: check fails on the starting commit, as the task expects
ℹ Trial 1/9 expired-token claude: preparing
ℹ Trial 1/9 expired-token claude: running claude
```

| Flag or setting | Effect |
| --- | --- |
| `--sandbox` | Declares this machine a sandbox for this process. Only on a machine you can throw away. |
| `workflows.sandbox: true` in config | Declares it for every process, as [Requirements and limits](workflow-advanced.md#requirements-and-limits) describes. |
| neither | Every trial is `not_run`, and the run says why. |
| `--member-aliases` | Your own `~/.teamai/models/aliases.yaml` wins over the team's `models/aliases.yaml`, and the table shows `member` as the source of each model your file decided. |

| A trial gets | |
| --- | --- |
| A fresh clone of the starting commit | With no remotes. Your checkout is never changed. |
| The team assets and the suite | Of the team revision this checkout last pulled, which must be pushed, or of the arm's `team`. Frozen at start: a pull during the run changes nothing it runs. |
| An environment | Without `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `CI_JOB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS` and `SSH_ASKPASS`. |
| Your home directory | As it is: teamai cannot remove its logins, MCP servers and plugins. |
| The team repo on this machine | As it is: your team checkout, and the copy of the team revision beside each trial's clone that its team assets are installed from, hold `benchmarks/`, check files included. An agent that searches the machine can find them. |

The local driver runs one trial at a time: fresh clone, team assets, setup, the arm's tool on the prompt, then the check.

| | |
| --- | --- |
| Tools | It runs `claude`, `codex` and `opencode`. Install and log in every tool the arms use. An arm whose tool it cannot find gets its trials `not_run`, and the other arms still run. |
| Timeout | The suite's `timeout` is the whole run's. Setup, the tool and the check all stop at it: the trial they ran for counts as `error`, and the trials still open settle `not_run`. Keep it below your CI job's limit, or the job is killed before it prints the table. |
| A hung trial | Without [`trial.timeout`](#trial-limits), a tool that never returns runs until the suite's timeout, and every trial after it settles `not_run`. |
| Judges | A task with `successCriteria`, and the suite's scorers, are judged before the run ends, on the install that ran the trials. Start refuses a suite that needs a judge on a machine that cannot judge. |
| Control commands | A trial's steps exist only once every task's baseline settled. Until then, `teamai workflow cancel <run> <step>` on a trial step answers `step_not_found`. `workflow retry`, `publish` and `--claim` refuse a benchmark run. |
| Stopped | `teamai workflow resume <run> --sandbox` continues it. |

A start that cannot run refuses with a message that says what to do, and makes no run.

## Results

When the run ends, the local driver prints the results on stderr. The JSON envelope on stdout carries the same text in `data.done.benchmark.text`, and the numbers in `data.done.benchmark.table`. For this suite with a third task, `old-bug`, whose check already passes:

```text
| Arm | Tool | Model (source) | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | claude | tool default (team) | 9 | 4 | 2 | 0 | 0 | 3 | 0 | 0 | 0 | 44% (4/9) |
| codex | codex | tool default (team) | 9 | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 33% (3/9) |
| strong | claude | claude-opus-5-5 high (team) | 9 | 6 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 67% (6/9) |

| Arm | Median tokens (input + output) | Median duration | Cost |
| --- | --- | --- | --- |
| claude | 41200 (6) | 84.0 s (6) | 1.82 USD (6) |
| codex | 38900 (6) | 97.5 s (6) | unknown (0) |
| strong | 52300 (6) | 121.0 s (6) | 4.1 USD (6) |

| Task | claude | codex | strong |
| --- | --- | --- | --- |
| expired-token | 33% (1/3) | 33% (1/3) | 100% (3/3) |
| login-copy | 100% (3/3) | 67% (2/3) | 100% (3/3) |
| old-bug | 0% (0/3) | 0% (0/3) | 0% (0/3) |

| Task | Baseline |
| --- | --- |
| old-bug | invalid: check passes without changes |

These results hold for these tasks, this run and this machine.
```

| Table | Shows |
| --- | --- |
| Arms | Each arm's trials by result, and how many a [trial limit](#trial-limits) stopped. A deviation is a trial whose prompt ran on another tool, team revision or model than its arm's, or without a trial limit its driver could not enforce. A trial is not verified when its record lacks one of those. When an arm runs on other team assets than the pulled revision, a Team column shows each arm's, such as `pulled 3f9c2ab`, `next 81d0e4c`, `3f9c2ab without auth-tokens` or `none`. |
| Usage | Each arm's medians and cost total, with how many trials each used. Tokens and cost appear only as the tool stated them, so a tool that states none shows `unknown (0)`. |
| Tasks | Each task's pass rate on each arm. |
| Baselines | The tasks that did not run, and why. |

The results are not the run's status: a run whose trials all failed still succeeds. The run fails when it times out or is cancelled.

You need [usage reporting](reporting.md) only to publish the results. With it on, the run's end record, with its `benchmark` field, goes to the team repo's `teamai-reports` branch, so the job's token also needs push access to the team repo. [Run records](workflow.md#run-records) lists the record's fields and gives the `jq` command that computes each arm's pass rate from the record alone. With it off, the table is still in the envelope. The dashboard's [Benchmarks page](dashboard.md#benchmarks) draws the published runs and this machine's over time.

## Run in CI

A GitHub Actions job:

```yaml
on: workflow_dispatch
jobs:
  benchmark:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ secrets.TEAM_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @anthropic-ai/claude-code
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
      - run: npx teamai-cli pull
      - run: npx teamai-cli workflow start fix-auth --benchmark --driver local --sandbox > done.json
      - if: always()
        run: jq -r '.data.done.benchmark.text // empty' done.json >> "$GITHUB_STEP_SUMMARY"
```

- `TEAM_TOKEN` reads the team repo, and pushes to it when usage reporting is on.
- `--agent claude` sets teamai up for Claude Code, which a fresh runner has never run.
- The checkout of the suite's `repo` has its full history, so every task's starting commit is there.
- The last step puts the results in the job's summary, also when the run failed.

A GitLab CI job:

```yaml
benchmark:
  image: node:22
  timeout: 1h
  when: manual
  script:
    - npm install -g @anthropic-ai/claude-code
    - npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
    - npx teamai-cli pull
    - npx teamai-cli workflow start fix-auth --benchmark --driver local --sandbox > done.json
  artifacts:
    when: always
    paths: [done.json]
```

Set `TEAM_REPO`, `GITLAB_TOKEN` (reads the team repo) and `ANTHROPIC_API_KEY` as masked CI/CD variables. The job log shows the results, and `done.json` keeps them. For another tool, install it and set its key the same way: each arm's tool must be on the runner.

## Your own driver

Any driver runs trials through `workflow next` and `workflow report`, as [Benchmark trials in your own driver](workflow-advanced.md#benchmark-trials-in-your-own-driver) describes:

```text
teamai workflow next <run> --prepare --json '{"driver":{..., "can":{"isolation":"sandbox","trials":["claude"]}}}'
  -> { data: { lease: { cwd, trial: { tool, model, effort, limits }, envScope: { withhold }, env, ... } } }
launch trial.tool in cwd, on the prompt, with that model and effort, without the withheld variables, with env
teamai workflow report <run> --json '{..., "tool":"claude", "durationMs":84000, "cost":{"amount":0.31,"unit":"USD"}}'
```

| | |
| --- | --- |
| `driver.can` | On every `next`: `isolation: "sandbox"`, and in `trials` the tools it launches. |
| `--prepare` | teamai makes the clone, installs the team assets and runs setup, then answers the lease with `cwd`. |
| `report` | `tool`, `durationMs` measured around the tool launch, and `cost` only when the tool stated one. |
| Limits | Hold the tool to `trial.limits`. When one stopped it, report `outcome: "success"` with `limit`: `timeout`, `budget` or `max_turns`, and list in `unenforced` a `budget` or `max_turns` you could not hold it to. |
| Blocking | The first `next --prepare` runs every task's baseline, and a later one runs a trial's check before it answers, so a call can take minutes. Allow for the suite's setup and check time if your host times out CLI calls. |
| Stopped | A stopped `next --prepare` leaves its step leased to the driver: call it again, and teamai prepares it again. |
| Judges | Once every trial settled, `next` answers `wait` with `judging` until the judges are done: run `teamai score --next` on the install that ran the trials. |
