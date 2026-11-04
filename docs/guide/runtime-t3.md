# T3 runtime

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

The `t3` [step runtime](workflow-advanced.md#driver-definitions-and-step-runtimes) runs each prompt step of a workflow as a [T3 Code](https://t3.codes) thread of its own. You can watch the agent work in the app, answer its approval requests, steer it with a message, or stop it. teamai still prepares the step's worktree, reads the result, and commits and pushes on your machine. Command steps and steps with `setup` run on `local`, as they do with `--driver local`.

It ships with teamai as the executable `teamai-runtime-t3`. `--driver t3` uses the definition teamai ships:

```yaml
# drivers/teamai-t3.yaml, shipped with teamai
schemaVersion: v1alpha1
name: teamai-t3
description: Run each prompt step as a T3 Code thread of its own, in a worktree teamai prepares, and every other step on this machine.
runtimes:
  - use: t3
    options:
      environment: local
      max_parallel: 4
  - use: local
```

## Quick start

**1. Open T3 Code on this machine, and add the repository as a project**, in the app (Add project) or from a terminal:

```sh
t3 project add ~/src/acme-app
```

**2. Write a prompt step with `workspace: new`, and spell out the result in the prompt.** The agent reads the prompt, not the `output` block: told only to "put the count in output.sections", Claude wrote `markdown_sections`, and the step failed `invalid_output`.

```yaml
# workflows/readme-review.yaml
schemaVersion: v1alpha1
name: readme-review
description: Count the README's sections and suggest one improvement
steps:
  - id: inventory
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('node:fs').readdirSync('.').length}))"
    output:
      files: number
  - id: review
    needs: [inventory]
    workspace: new
    tool: claude
    model: { name: claude-haiku-5-5 }
    prompt: >-
      Read README.md. Count its markdown sections (lines that start with "#") and suggest one short improvement.
      Do not change any file. The result file must be exactly
      {"output": {"sections": <the count>, "suggestion": "<the improvement>"}}, with those two key names.
    output:
      sections: number
      suggestion: string
```

**3. Start it**, from a terminal on this machine or from a T3 thread:

```sh
teamai pull
teamai workflow start readme-review --driver t3
```

The first run opens T3's sign-in page in your browser. Approve teamai there with **Auto** access. The access you pick is the broadest mode a step thread can run in, and a thread runs in Auto unless you [tighten it](#how-much-a-step-thread-asks-you). teamai keeps the credential in `~/.teamai/runtime-state/t3/credentials.json` (mode 0600), so later runs sign in without the page until T3's credential expires.

**4. Watch the step in T3.** `inventory` runs on your machine. `review` appears in the project's thread list as `review · teamai r928e2fc23ab9bd62`. Its first message says which run it belongs to:

```text
This thread runs step "review" of teamai workflow run r928e2fc23ab9bd62 (attempt a96c8bc03). It was started from
the T3 thread t3-thread://v2/88e28b29-…/thread-… . Work only in this worktree. Do not run teamai workflow commands:
teamai commits, pushes and reports the step itself.

Read README.md. Count its markdown sections …

Write the workflow result as JSON to ~/.teamai/projects/…/attempts/a96c8bc03/out/result.json. …
```

In this run Claude read the README, ran `grep -c '^#' README.md`, made the result directory and wrote the result file, all without asking. About 20 seconds later the step ended:

```text
{"data":{"done":{"run":"r928e2fc23ab9bd62","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

Once the step's result is collected, teamai settles the thread, so it leaves your list of active threads. A thread whose step failed stays active, so you see it.

## How much a step thread asks you

A step thread is a thread of its own, so nobody but you can answer its requests. It always runs in the mode below, never in the mode of the thread you started the run from, and never in Full access:

| Mode | What you see in the thread |
| --- | --- |
| Auto (the default) | The provider's own review approves routine actions, such as reading files, editing in the worktree and ordinary commands. It asks you about the rest. A provider with no automatic review asks about everything, as in Supervised. |
| Auto-accept edits | File edits go through. Every command waits for you. |
| Supervised | Every command and every edit waits for you, including the write of the result file, which is outside the worktree. |

The same README review asked for nothing in Auto. In Supervised it asked twice, once to make the result directory and once to write the result file, and the step took 9 minutes because the requests waited for someone to approve them.

To make every step thread on this machine ask more, set `runtime_mode`:

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          runtime_mode: approval-required   # or auto-accept-edits
```

`runtime_mode` only tightens the mode. Any other value fails before T3 is called:

```text
{"error":{"code":"bad_option","message":"Runtime \"t3\" of driver definition …/drivers/teamai-t3.yaml refused option \"runtime_mode\": runtime_mode \"full-access\" is not one runtime t3 takes. A step thread runs in auto, T3's Auto mode; runtime_mode only tightens it, to auto-accept-edits or approval-required. Remove it, or set one of those two. Fix the option and start again."}}
```

If you approved teamai with narrower access than the mode, for example Supervised, T3 refuses the thread and the step fails:

```text
✖ Step "review" failed with runtime_failed: The step runtime could not run the prompt (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode, because teamai's sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json, start the workflow again, and approve teamai with Auto access or broader. Or set runtime_mode to a mode the sign-in allows.
```

## Pick the provider instance and the model

The tools are the T3 provider instances that can run now: Claude on the `claudeAgent` instance, Codex on `codex`. To run every prompt on one instance, for example a second Claude account, name it in your machine's config:

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          instance: claude-work      # the id in T3 Settings → Providers
          max_parallel: 2
```

A step's `model: { name, effort }` picks the model, and `effort` becomes the option that instance names it by (`effort` for Claude, `reasoningEffort` for Codex). A step with no model gets the first model the instance lists. Something the instance cannot run fails before any thread starts:

```text
✖ Step "review" failed with model_unavailable: T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.
```

## Unattended runs

In CI, or a run with `TEAMAI_MODE=unattended`, nobody can approve a sign-in or a tool request. An unattended run reuses the credential an attended run kept, and fails at once without one:

```text
{"error":{"code":"runtime_failed","message":"Runtime \"t3\" of driver \"teamai-t3\" did not start (login_required): teamai has no valid T3 Code sign-in for http://127.0.0.1:3773, and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again."}}
```

An unattended run's threads still run in Auto, or your `runtime_mode`. A step whose agent asks for an approval anyway is stopped, and fails `tool_failed` naming the thread. Interactive steps run only in attended runs.

## Restart, cancel and retry

The step's thread lives in T3, not in teamai's process. If the driver dies, `teamai workflow resume <run> --driver t3` reconnects to the same thread instead of starting another one. `teamai workflow cancel <run>` stops the thread as its Stop button does. The thread ends interrupted, stays in your list of active threads, and any request it was waiting on is withdrawn.

```sh
teamai workflow resume r928e2fc23ab9bd62 --driver t3
teamai workflow cancel r70d31098c8884803
```

## Interactive steps

An `interactive: true` prompt step opens a thread you work in. The thread is told to write the result file only once you say the step is done, so a thread that goes idle between your turns does not end the step. No other step of the run starts until it ends.

## When it does not start

| What you see | Why | Do this |
| --- | --- | --- |
| `T3 Code is not running on this machine.` | No T3 server here. teamai reads `~/.t3/userdata/server-runtime.json`, or `$T3CODE_HOME/userdata/…` | Open T3 Code, then run again. |
| `… (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode …` | You approved teamai with narrower access than the mode the thread runs in. | Remove `~/.teamai/runtime-state/t3/credentials.json`, run again, and approve with Auto access. Or set `runtime_mode`. |
| `… is not a project in T3 Code <machine>.` | The checkout is not a T3 project. | Add it in T3 Code (Add project), or run `t3 project add <path>`. |
| `T3 Code has no provider instance "claude-sandbox".` | `instance` names an instance T3 does not have, or one that is disabled. | Add or enable it in T3 Code under Settings → Providers, or remove `instance`. |
| `… ended without writing the result file …` | The agent finished without writing its result. | Open the thread from the link in the message, then `teamai workflow retry <run> <step>`. |
| `… kept no session for …` | The tool kept no transcript for the worktree, so the step could not be scored. | Check that the instance uses the tool's default home (`~/.claude`, `~/.codex`). |

## What it does not do yet

- A step's thread is a thread of its own, not a child of the thread that started the run. T3 keeps a parent link only for a thread launched on another, linked environment.
- The run's details show the project and the environment for a step on T3, and the thread's link only after a restart reconnects it.
- A step with `session: continue` or `session.from` starts a new conversation, as OpenCode does: T3 has no way to launch a thread on an existing session.
- It offers `workspace: new` and `continue`. A read-only prompt step, or one with `env` or `setup`, goes to `local`.
- T3 reports no token usage, so a `budget` in tokens cannot be checked here, and it cannot cap `max_turns`.
- `permissions: unattended` steps are not offered. They need a thread whose tool runs in a sandbox, which a later version adds.
