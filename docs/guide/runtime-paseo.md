# Paseo runtime

> Part of [Workflows](workflow.md).

`teamai-runtime-paseo` runs each prompt step as an agent of a [Paseo](https://github.com/getpaseo/paseo) daemon, in a Paseo workspace on teamai's worktree for the step. You watch the agent and answer its permission prompts in the Paseo app. teamai still reads the result, commits, delivers, scores, and recovers the step.

It runs prompt steps only. Commands and `setup` go to the next runtime in the definition, or to this machine. A prompt step that needs `permissions: unattended` or a `role` goes to the next runtime that can run it. It also judges a scored pass, best-effort: see [Judge a scored pass](#judge-a-scored-pass).

## Quick start

Paseo is a prerequisite: teamai ships none of its code. Install Paseo (0.14.0 or later) on the machine that runs the workflow, and start its daemon:

```sh
npm install -g @getpaseo/cli
paseo start
paseo status    # listen: 127.0.0.1:6767
```

The runtime loads Paseo's client from that install when it starts: it follows the `paseo` on `PATH` to its package, so the client always matches your daemon. When teamai runs with a `PATH` that has no `paseo`, point at the client yourself. For an install under its own prefix:

```sh
npm install -g --prefix ~/.paseo-cli @getpaseo/cli
export PASEO_CLIENT_PATH=~/.paseo-cli/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/client
```

Add a definition that sends prompt steps to Paseo and everything else to this machine, in the team repo or in `~/.teamai/drivers/`:

```yaml
# drivers/paseo.yaml
schemaVersion: v1alpha1
name: paseo
description: Run prompt steps as agents of the local Paseo daemon, and the rest here.
runtimes:
  - use: paseo
    options:
      max_parallel: 4
  - use: local
```

A workflow needs nothing Paseo-specific:

```yaml
# workflows/paseo-review.yaml
schemaVersion: v1alpha1
name: paseo-review
description: Count the files, then ask a Claude agent in Paseo whether the README has a title.
steps:
  - id: count
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('fs').readdirSync('.').length}))"
    output:
      files: number
  - id: classify
    needs: [count]
    workspace: new
    tool: claude
    model: { name: claude-sonnet-5-5 }
    prompt: |
      Read README.md and say whether it starts with a Markdown title.
      Answer with the output {"has_title": true} or {"has_title": false}.
    output:
      has_title: boolean
```

```sh
teamai workflow start paseo-review --driver paseo
```

```text
ℹ Run r0769801107010602 started. If it stops before it ends, continue it with: teamai workflow resume r0769801107010602 --driver paseo
{"data":{"done":{"run":"r0769801107010602","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`count` ran on this machine. `classify` ran in Paseo, in teamai's worktree:

```text
$ paseo inspect 9b38e203
Name      teamai classify · r0769801107010602
Provider  claude
Model     claude-sonnet-5-5
Mode      default
Cwd       /repo/.teamai/workflow-worktrees/teamai-r0769801107010602-classify-p1-4e57d9b3cff1
```

While the agent works, the run's details in the dashboard show it, with a link that opens it in Paseo:

```json
{ "label": "teamai classify · r7f54a1690b9ae0ce", "url": "paseo://h/srv_vL5abcnfKUWY/agent/5f95baae-9117-42b7-9e3d-47891dd3e84d", "fields": { "agent": "5f95baae-9117-42b7-9e3d-47891dd3e84d", "workspace": "wks_f55e98406bad64bd", "model": "claude/claude-sonnet-5-5" } }
```

The step's record has its output and Claude's session id:

```json
{ "id": "classify", "outcome": "success", "outputs": { "has_title": true }, "tool": "claude", "session": "35ab4949-21d9-40df-9444-652e96607b7b" }
```

## Judge a scored pass

A step with `scorers` is judged by the `teamai-score` workflow: its bookkeeping commands run on this machine, and its judge is a confined prompt, which reads one evidence directory and nothing else. Paseo answers it, so a definition with only `paseo` runs and judges a scored step on a machine with no agent CLI:

```yaml
# drivers/paseo-only.yaml
schemaVersion: v1alpha1
name: paseo-only
tool: claude
runtimes:
  - use: paseo
```

The step is judged by [`review-quality`](scorers.md), on every pass:

```yaml
# workflows/fix-add.yaml
schemaVersion: v1alpha1
name: fix-add
description: Fix add in math.js, and judge the change.
steps:
  - id: fix
    workspace: new
    prompt: |
      add in math.js returns a - b. Make it return a + b, and add math.test.js that checks add(2, 3) is 5 with node:test.
      Edit the files only, and run no command.
    scorers: { names: [review-quality], sampling: all }
    output:
      fixed: boolean
```

```text
$ command -v claude codex opencode
$ teamai workflow start fix-add --driver paseo-only
ℹ Run rd573bcff8eef4e10 started. If it stops before it ends, continue it with: teamai workflow resume rd573bcff8eef4e10
ℹ run:rd573bcff8eef4e10:fix:1: review-quality good (teamai-score run re02e01c9b0e36c69).
{"data":{"done":{"run":"rd573bcff8eef4e10","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

In this attended run, the fix agent asked before its two edits, answered with `paseo permit allow <agent> --all`. The judge asked for nothing: it only read the directory with `Read`.

Both agents ran in Paseo. The judge's cwd is the evidence directory teamai wrote:

```text
$ paseo ls --all
NAME                                       PROVIDER                STATUS  CWD
teamai score[0].judge · re02e01c9b0e36c69  claude/claude-opus-5-5  closed  ~/.teamai/projects/…/runs/re02e01c9b0e36c69/scratch/a47d92bbe
teamai fix · rd573bcff8eef4e10             claude/claude-opus-5-5  closed  /repo/.teamai/workflow-worktrees/teamai-rd573bcff8eef4e10-fix-p1-a04485788cc1
```

The judge step records what the runtime kept:

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The step asked for two things: change add in math.js from a - b to a + b, and add math.test.js that uses node:test to check add(2, 3) is 5… The diff does both…" } }, "confined": { "tool": "claude", "isolation": "best-effort", "access": "read" } }
```

The judge runs at `best-effort`, never `verified`:

| What | Enforced |
| --- | --- |
| A fresh agent whose cwd is the evidence directory, briefed to read only it | yes |
| No edit, and no command the tool's own rules do not allow: the judge's mode asks first, and any request for permission ends the judge, attended or not | yes |
| Its answer is its last message, parsed as JSON; it writes nothing | yes |
| No read outside the directory | no: nothing stops the agent reading a file elsewhere |
| No network | no |

A confined step whose `confined.json` asks for `verified` never goes to Paseo, whose offer is `best-effort`. Codex never judges on Paseo, since every Codex mode writes without asking. The judge's place shows in the run's details as `Paseo confined prompt, best-effort` until its agent starts.

Scoring reads the step's session where the daemon's agent wrote it: in the tool home of the user the daemon runs as. Run the daemon as the member who runs teamai, on the same machine. A daemon under another user, or another `HOME`, leaves the pass unlabelled, and the score run's `evidence` step says why:

```text
evidence_missing: Pass 1 of step fix in run r080799f10648b1ed cannot be scored: no longer on this machine: claude-code session 346fd0be-1a5a-474b-aedf-24c305d5c1a6 of fix#1. Restore what is missing, or score another pass.
```

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | `ws://127.0.0.1:6767/ws` | The WebSocket address of the Paseo daemon on this machine. |

`max_parallel` is teamai's own key; see [Runtime options](workflow-advanced.md#runtime-options). Paseo has no cap of its own.

```yaml
runtimes:
  - use: paseo
    options:
      url: ws://127.0.0.1:7070/ws
```

## Tools, models and modes

The runtime offers `claude`, `codex` and `opencode` when the daemon has them. The agent starts in the tool's default Paseo mode, never a bypass mode. A judge starts in a mode that asks before it edits or runs anything:

| Tool | Step mode | Judge mode |
| --- | --- | --- |
| `claude` | `default` (asks before what it does not allow) | `default` |
| `codex` | `auto` | none: every Codex mode writes without asking |
| `opencode` | `build` | `plan` |

The step's `model` must be one the daemon offers, and its `effort` one that model has. With no `model`, the agent uses the daemon's default. A model the daemon lacks fails before any agent starts:

```text
✖ Step "classify" failed with model_unavailable: The Paseo daemon at ws://127.0.0.1:6767/ws has no claude model claude-opus-0-1. It offers: claude-opus-5-5, claude-opus-5, claude-fable-5-1, claude-fable-5, claude-opus-4-8[1m], claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-opus-4-7[1m], claude-opus-4-7, claude-opus-4-6[1m], claude-opus-4-6, claude-sonnet-4-6[1m], claude-sonnet-4-6, claude-haiku-5-5, claude-haiku-4-5.
```

The agent gets the step's prompt. A later pass of the step starts a new agent: it does not continue the earlier pass's session. Paseo reports no full token counts, so a step under a token budget runs on the next runtime.

## Credentials

Paseo keeps an agent's environment in plain text under its home, so this runtime takes no `credentials`, and teamai refuses a definition that gives it one:

```text
{"error":{"code":"bad_option","message":"Runtime \"paseo\" of driver definition ~/.teamai/drivers/paseo.yaml refused option \"credentials\": paseo does not offer can.env, so it cannot keep a credential to the processes it is for. Fix the option and start again."}}
```

Remove the entry, and give the tool what it needs on the daemon's host instead: sign in to it there, or set the variable in the environment the daemon starts with, then `paseo restart`. An agent gets the daemon's environment.

## Permissions

A Claude agent may write two things without asking: teamai's result file, and the run's scratch directory, which `$TEAMAI_RUN_DIR` names for the run's commands. The runtime allows `Edit(/<result file>)` and `Edit(/<run directory>/**)`, and the mode stays `default`. Codex and OpenCode get no such grant. Of the step's environment, the agent gets only `TEAMAI_RUN_DIR`, so a prompt that names a file in the directory `$TEAMAI_RUN_DIR` names works as it does on this machine.

In an attended run, any other permission prompt waits for you in the Paseo app, or on the command line:

```sh
paseo permit ls
paseo permit allow 7c483fce --all
```

In an unattended run (`TEAMAI_MODE=unattended` or `CI`), nobody can answer, so the step fails and the agent stops. Here a prompt step `count` asked its agent to run `ls -1 | wc -l`:

```text
✖ Step "count" failed with tool_failed: The claude agent asked for permission (Bash) in Paseo mode default, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.
```

## Cancel, crash and restart

`teamai workflow cancel` stops the agent, and the step ends `cancelled`:

```sh
teamai workflow cancel r144a3913136e7b62
```

A teamai killed while an agent works leaves the agent running. `resume` reconnects to the same agent; it does not start a second one:

```sh
kill -9 <teamai pid>
teamai workflow resume rffcaabe1e1852479 --driver paseo
```

A daemon that restarts mid-step closes its agents. While it is down the step waits for it; once it is back, the step fails, and its work stays in the worktree:

```text
✖ Step "classify" failed with runtime_failed: The step runtime could not run the prompt (daemon_restarted): The Paseo daemon at ws://127.0.0.1:6767/ws stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree; run `teamai workflow retry` to run the step again.
```

```sh
teamai workflow retry r3ad62eacc3c191eb classify
teamai workflow resume r3ad62eacc3c191eb --driver paseo
```

When teamai closes the attempt, the runtime archives its Paseo workspace, which stops anything still running there. Paseo deletes only worktrees it created, so teamai's worktree and branch stay. If Paseo refuses, the run's details say the place was not closed, and why:

```text
Paseo did not archive workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79): <Paseo's error>. Its agents may still run; archive it in the Paseo app.
```

A runtime killed mid-step cannot archive; the step fails `runtime_lost`, and its workspace stays in Paseo until you archive it (`paseo workspace archive <id>`).

## Errors at start

| Code | When |
| --- | --- |
| `client_missing` | No Paseo client was found: no `paseo` on `PATH`, or `PASEO_CLIENT_PATH` names no `@getpaseo/client` package. Install Paseo, or set `PASEO_CLIENT_PATH`. |
| `client_version` | The Paseo client found is older than 0.14.0. Update Paseo, or set `PASEO_CLIENT_PATH` to a newer `@getpaseo/client` package. |
| `daemon_unreachable` | No daemon answers at `url`. Start it with `paseo start`. |
| `daemon_version` | The daemon is older than 0.14.0. Update Paseo and restart it. |
| `tool_unavailable` | The daemon has none of `claude`, `codex`, `opencode` in its default mode. A step whose tool the daemon lacks runs on the next runtime. |
| `bad_option` | An option other than `url`. |
