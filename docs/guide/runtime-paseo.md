# Paseo runtime

> Part of [Workflows](workflow.md).

`teamai-runtime-paseo` runs each prompt step as an agent of a [Paseo](https://github.com/getpaseo/paseo) daemon, in a Paseo workspace on teamai's worktree for the step. You watch the agent and answer its permission prompts in the Paseo app. teamai still reads the result, commits, delivers, scores, and recovers the step.

It runs prompt steps only. Commands, `setup`, and steps that need `permissions: unattended` or a `role` go to the next runtime in the definition.

## Quick start

Start the Paseo daemon (0.14.0 or later) on the machine that runs the workflow:

```sh
paseo start
paseo status    # listen: 127.0.0.1:6767
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

The step's record has its output and Claude's session id:

```json
{ "id": "classify", "outcome": "success", "outputs": { "has_title": true }, "tool": "claude", "session": "35ab4949-21d9-40df-9444-652e96607b7b" }
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

The runtime offers `claude`, `codex` and `opencode` when the daemon has them. The agent starts in the tool's default Paseo mode, never a bypass mode:

| Tool | Mode |
| --- | --- |
| `claude` | `default` (asks before what it does not allow) |
| `codex` | `auto` |
| `opencode` | `build` |

The step's `model` must be one the daemon offers, and its `effort` one that model has. With no `model`, the agent uses the daemon's default. A model the daemon lacks fails before any agent starts:

```text
✖ Step "classify" failed with model_unavailable: The Paseo daemon at ws://127.0.0.1:6767/ws has no claude model claude-opus-0-1. It offers: claude-opus-5-5, claude-opus-5, claude-fable-5-1, claude-fable-5, claude-opus-4-8[1m], claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-opus-4-7[1m], claude-opus-4-7, claude-opus-4-6[1m], claude-opus-4-6, claude-sonnet-4-6[1m], claude-sonnet-4-6, claude-haiku-5-5, claude-haiku-4-5.
```

The agent gets the step's prompt and no environment from the run. Paseo reports no full token counts, so a step under a token budget runs on the next runtime.

## Permissions

Claude's `default` mode asks before it writes teamai's result file, which sits outside the worktree, so each Claude step asks at least once.

In an attended run, a permission prompt waits for you in the Paseo app, or on the command line:

```sh
paseo permit ls
paseo permit allow 7c483fce --all
```

In an unattended run (`TEAMAI_MODE=unattended` or `CI`), nobody can answer, so the step fails and the agent stops:

```text
✖ Step "classify" failed with tool_failed: The claude agent asked for permission (Write) in Paseo mode default, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.
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

Archiving the Paseo workspace (`paseo workspace archive <id>`) leaves teamai's worktree and branch in place.

## Errors at start

| Code | When |
| --- | --- |
| `daemon_unreachable` | No daemon answers at `url`. Start it with `paseo start`. |
| `daemon_version` | The daemon is older than 0.14.0. Update Paseo and restart it. |
| `tool_unavailable` | The daemon has none of `claude`, `codex`, `opencode` in its default mode. A step whose tool the daemon lacks runs on the next runtime. |
| `bad_option` | An option other than `url`. |
