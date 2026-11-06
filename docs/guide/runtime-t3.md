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

**1. Open T3 Code on this machine**, or run `t3 serve`. If the repository is not a T3 project yet, the first run adds it, as `t3 project add ~/src/acme-app` would.

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

The first run signs teamai in to T3 Code with no page and no question. teamai asks the `t3` command on this machine for a pairing code that lasts two minutes, and uses it to approve its own sign-in with Auto access, even when you [tighten `runtime_mode`](#how-much-a-step-thread-asks-you): each thread still runs in its own mode, and one sign-in serves every run. The command it runs:

```sh
t3 auth pairing create --json --base-dir ~/.t3 --scope orchestration:read --scope orchestration:operate --ttl 2m --label "teamai workflow"
```

T3 lists the sign-in as a session of its own:

```text
$ t3 auth session list
af508185-8908-4575-a1d0-f3c6f67cddec
  scopes: orchestration:read orchestration:operate
  method: bearer-access-token
  subject: mcp-client
  client: teamai workflow | bot | 127.0.0.1
  expires: 2026-12-05T18:57:31.647Z
```

teamai keeps the credential in `~/.teamai/runtime-state/t3/credentials.json` (mode 0600). Later runs reuse it. When T3 expires it after 30 days, the next run signs in again the same way. To revoke it, run `t3 auth session revoke <id>`.

teamai runs the first `t3` it finds: `$T3CODE_CLI_PATH` (T3 sets it in its own threads), then `t3` on your PATH, then `bin/t3` in T3's data directory (`~/.t3/bin/t3`, or under `$T3CODE_HOME`). If it finds none, or T3 refuses the code, the run opens T3's sign-in page instead. Create a pairing code in T3 Code, pick **Auto** access, enter the code and approve. The access you pick is the broadest mode a step thread can run in.

**4. Watch the step in T3.** `inventory` runs on your machine. `review` appears in the project's thread list as `review · teamai r928e2fc23ab9bd62`. Its first message says which run it belongs to:

```text
This thread runs step "review" of teamai workflow run r928e2fc23ab9bd62 (attempt a96c8bc03). It was started from
the T3 thread <t3-thread://v2/88e28b29-…/thread-…>. Work only in this worktree. Do not run teamai workflow commands:
teamai commits, pushes and reports the step itself.

Read README.md. Count its markdown sections …

Write the workflow result as JSON to ~/.teamai/projects/…/attempts/a96c8bc03/out/result.json. …
```

In this run Claude read the README, ran `grep -c '^#' README.md`, made the result directory and wrote the result file, all without asking. About 20 seconds later the step ended:

```text
{"data":{"done":{"run":"r928e2fc23ab9bd62","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

While the step runs, the run's details in `teamai dashboard` link its thread, with the thread id and the model. The link opens the thread in the T3 Code desktop app, from the dashboard or from a terminal:

```sh
open 't3code://threads/88e28b29-…/mcp%3Alaunch%3A3891149…'
```

Once a step ends, teamai settles its thread. The thread leaves your list of active threads for T3's collapsed **Settled** group, and the link still opens it:

| The step | Its thread |
| --- | --- |
| succeeded, failed, or reported a failure in its result | settled once teamai collects the step |
| was cancelled (`teamai workflow cancel`) | stopped, then settled |
| still runs, or is an interactive step waiting for you | stays active |
| ended before teamai saw its thread stop (T3 did not stop it, or teamai lost track of it) | stays active, so you can stop it; closing the step's place stops it first |

teamai settles only the threads it launched. If T3 refuses to settle one, the step still counts and the thread stays active.

## How much a step thread asks you

A step thread is a thread of its own, so nobody but you can answer its requests. It starts in the default mode you set in T3 Code: the project's own setting if it has one, else the global one, else Auto. It never takes the mode of the thread you started the run from, and never runs in Full access. When your default is Full access, it runs in Auto.

| Mode | What you see in the thread |
| --- | --- |
| Auto | The provider's own review approves routine actions, such as reading files, editing in the worktree and ordinary commands. It asks you about the rest. A provider with no automatic review asks about everything, as in Supervised. |
| Auto-accept edits | Edits in the worktree go through. Every command waits for you, and so does the write of the result file. |
| Supervised | Every command and every edit waits for you, including the write of the result file. |

On your machine teamai lets Claude write a step's result file without asking. A T3 thread gets no such grant, because T3 has no way to pass one. The result file is outside the worktree, so in Auto-accept edits and Supervised the thread asks once to write it ("Path is outside allowed working directories"). Approve that write, and the step ends.

The same README review asked for nothing in Auto. In Supervised it asked twice, once to make the result directory and once to write the result file, and the step took 9 minutes because the requests waited for someone to approve them.

To pick the mode of every step thread on this machine, whatever T3's default, set `runtime_mode`:

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          runtime_mode: approval-required   # or auto-accept-edits
```

It takes `auto`, `auto-accept-edits` or `approval-required`. Any other value fails before T3 is called:

```text
{"error":{"code":"bad_option","message":"Runtime \"t3\" of driver definition …/drivers/teamai-t3.yaml refused option \"runtime_mode\": runtime_mode \"full-access\" is not one runtime t3 takes. A step thread runs in the member's T3 default mode, or auto, never full access; runtime_mode sets it to auto, auto-accept-edits or approval-required. Remove it, or set one of those three. Fix the option and start again."}}
```

teamai's sign-in caps the mode. If it allows less than the run's mode, T3 refuses the thread and the step fails. For example, someone approved teamai in T3's page with Supervised access, and this run uses Auto:

```text
✖ Step "review" failed with runtime_failed: The step runtime could not run the prompt (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode, because teamai's sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.
```

## Pick the provider instance and the model

The tools are the T3 provider instances that can run now, leaving out any you turned off for the project. When a provider has several, a tool runs on the instance of your T3 default model, else the one named after the provider (`claudeAgent` for Claude, `codex` for Codex). To run every prompt on one instance, for example a second Claude account, name it in your machine's config:

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

A step's `model: { name, effort }` picks the model, and `effort` becomes the option that instance names it by (`effort` for Claude, `reasoningEffort` for Codex). A step with no model gets your T3 default model (the project's, else the global one) when that model is on the step's instance; T3 picks it, as for a thread you start. Otherwise it gets the first model the instance lists. Something the instance cannot run fails before any thread starts:

```text
✖ Step "review" failed with model_unavailable: T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.
```

## Project scripts

T3 runs a project's **setup** script ("Run on worktree creation") in each worktree a thread opens on, and its **settle** script when a thread is settled. teamai prepares the step's worktree itself, so neither runs for a step:

- When the project has a setup script, teamai adds the step's worktree to T3 Code as a project of its own, titled `acme-app · teamai <run>`, and runs the thread there. That project stays in T3 Code after the run, so its thread and link keep working. Remove it in T3 Code once you no longer need it.
- When the project has a settle script, teamai does not settle the step's thread: it stays in your active threads.

## Score a pass with only T3

T3 can also judge. A member who has T3 but no agent CLI on the machine can run a workflow with [scorers](scorers.md#score-a-step) and have each pass labelled, with a definition that lists only `t3`:

```yaml
# .teamai/drivers/t3only.yaml
schemaVersion: v1alpha1
name: t3only
tool: claude
runtimes:
  - use: t3
    options: { environment: local }
```

```yaml
# .teamai/workflows/readme-test-section.yaml
schemaVersion: v1alpha1
name: readme-test-section
description: Add a Test section to the README.
steps:
  - id: write
    workspace: new
    model: claude-haiku-5-5
    prompt: Add a "## Test" section to README.md that says to run `npm test` before opening a pull request. Change no other file.
    scorers: { names: [review-quality], sampling: all }
```

`review-quality` is the scorer from [Scorers](scorers.md). `sampling: all` judges every pass, whatever its `samplingRate`.

```text
$ command -v claude codex codebuddy opencode
[exit 1: none found]
$ teamai workflow start readme-test-section --driver t3only
ℹ run:r943880abc4705751:write:1: review-quality good (teamai-score run rdecc208adbba4b79).
{"data":{"done":{"run":"r943880abc4705751","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`write` runs as a thread in the project, as above. teamai's own scoring commands (evidence, label, write) run on this machine and need no agent. The judge runs as a second thread, `score[0].judge · teamai rdecc208adbba4b79`, under **No project** in T3:

- It is a new thread of its own, in a new scratch folder (`~/.t3/scratch/…`). teamai fills that folder with a copy of the evidence the judge reads (the transcript, the diff, `evidence.json`), and makes the copy read-only.
- Its first message tells it to read only that folder, gives the JSON Schema of the reply, and points each mention of the evidence directory in teamai's prompt at the copy.
- Its last message is the reply: `{"answer":{"label":"good","reasoning":"The step asked for a \"## Test\" section … diff.patch adds exactly that …"}}`.
- It runs in `runtime_mode`, else your global T3 default mode, else Auto; never in Full access. When the judge's place closes, teamai settles the thread and removes the copy.

A T3 judge runs at **best-effort** [isolation](scorers.md#isolation):

| What it keeps | What it does not |
| --- | --- |
| The agent works in a copy, so it cannot change the evidence teamai labels with. | The agent's tool still runs on your machine with your files. Only the brief keeps it from reading outside the folder, and Auto approves routine reads. |
| The copy is read-only, and holds no symlink that could reach outside it. | It does not cut the network. |
| teamai records `best-effort` and `read` access on the label's run. | A scorer with `isolation: verified` waits for a runtime that reaches it, such as the sandbox runtime, and is never judged here. |

## Unattended runs

In CI, or a run with `TEAMAI_MODE=unattended`, nobody can approve a sign-in or a tool request. An unattended run signs in through the `t3` command as any run does, so a scheduled run keeps working after the credential expires. When the `t3` command cannot sign it in, it fails at once and says why:

```text
{"error":{"code":"runtime_failed","message":"Runtime \"t3\" of driver \"teamai-t3\" did not start (login_required): teamai has no valid T3 Code sign-in for http://127.0.0.1:3773 and could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ~/.t3/bin/t3), and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again."}}
```

An unattended run's threads run in the mode above. A step whose agent asks for an approval anyway, or delegates a task that asks for one, is stopped, and fails `tool_failed` naming the thread. If T3 does not stop the thread, the step fails `cancel_failed` instead, and teamai keeps the step's place until a later `teamai workflow cancel` stops it. Interactive steps run only in attended runs.

## Restart, cancel and retry

The step's thread lives in T3, not in teamai's process. If the driver dies, `teamai workflow resume <run> --driver t3` reconnects to the same thread instead of starting another one. `teamai workflow cancel <run>` stops the thread as its Stop button does. The thread ends interrupted, any request it was waiting on is withdrawn, and teamai settles it. A cancel needs no new sign-in: after the driver died, teamai opens the runtime only to stop what it recorded, with the sign-in it kept, and reaches T3 Code only for the stop.

T3 gets 10 s from the cancel to confirm a stop, a launch still under way included. If it does not, teamai keeps the step's place and nothing of it is committed, and the cancel says which thread still runs:

```text
⚠ Could not stop attempt a96c8bc03 of run r70d31098c8884803 on step runtime "t3" of driver "teamai-t3": its exec or prompt may still run, since the runtime did not confirm it stopped (cancel_failed): The T3 thread t3code://threads/88e28b29-…/mcp%3Alaunch%3A3891149… ("review · teamai r70d31098c8884803") still runs, and T3 Code did not stop it: T3 Code acknowledged the stop, but its run was still running 10 s later. Stop it in T3 Code with its Stop button, then run teamai workflow cancel r70d31098c8884803 again.
```

Stop the thread, then run the same cancel again.

A thread's run may hand work to subagents or background tasks. The step ends only once that work has settled too, and a cancel or close counts the thread as stopped only then.

If T3 Code launched a step's thread but its answer never reached teamai, a cancel or close finds the thread by sending the same launch again, which T3 answers with that thread, and stops it. If T3 had launched nothing, that second launch adds an idle thread, which teamai settles. T3 answers it only under the sign-in that sent the first launch, so after you signed in to T3 again, teamai keeps the place and tells you which thread to stop.

```sh
teamai workflow resume r928e2fc23ab9bd62 --driver t3
teamai workflow cancel r70d31098c8884803
```

## Interactive steps

An `interactive: true` prompt step opens a thread you work in. The thread is told to write the result file only once you say the step is done, so a thread that goes idle between your turns does not end the step. No other step of the run starts until it ends.

## When it does not start

| What you see | Why | Do this |
| --- | --- | --- |
| `T3 Code is not running on this machine.` | No T3 server here. teamai reads `~/.t3/userdata/server-runtime.json`, or `$T3CODE_HOME/userdata/…` | Open T3 Code, or run `t3 serve`, then run again. |
| `T3 Code at http://127.0.0.1:3773 does not answer. Open T3 Code, or run \`t3 serve\` …` | T3 left its server file behind, but nothing answers there. | Open T3 Code, or run `t3 serve`, then run again. |
| `… (login_required): … could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ~/.t3/bin/t3) …` | An unattended run has no valid sign-in, and the `t3` command could not create one. The text in brackets says why. | Check that `t3 auth session list` works in the shell teamai runs in, then run again. Or start a workflow from a terminal once and approve teamai in the page. |
| `… (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode …` | teamai's sign-in allows less than the mode the thread runs in. | Remove `~/.teamai/runtime-state/t3/credentials.json` and run again: teamai signs in again; approve it with Auto access if T3 Code asks. Or set `runtime_mode`. |
| `… is not a project in T3 Code <machine>, and teamai could not add it (…)` | The checkout is not a T3 project, and `t3 project add` failed. The text in brackets says why. | Add it in T3 Code (Add project), or run `t3 project add <path>`. |
| `T3 Code has no provider instance "claude-sandbox".` | `instance` names an instance T3 does not have, or one that is disabled. | Add or enable it in T3 Code under Settings → Providers, or remove `instance`. |
| `… ended without writing the result file …` | The agent finished without writing its result. | Open the thread from the link in the message, then `teamai workflow retry <run> <step>`. |
| `… (cancel_failed): The T3 thread t3code://threads/… ("review · teamai r70d…") still runs, and T3 Code did not stop it …` | teamai cancelled the step, and T3 did not confirm its thread stopped within 10 s. | Open the thread from the link, stop it with its Stop button, then `teamai workflow cancel <run>` again. |
| `… (cancel_failed): teamai launched the T3 thread "review · teamai r70d…", and T3 Code did not confirm the launch …`, or `… could not be followed, so it may still run …` | The step failed while its thread may still run in T3: T3 Code did not answer its launch, or went away during the step. teamai keeps the place and commits nothing. | Open T3 Code, then `teamai workflow cancel <run>`: it finds the thread and stops it. |
| `Not closed: thread_still_runs …` in the run's details | teamai closed the step's place while its thread, or work the thread delegated, still ran, and T3 did not stop it. | Open the thread from the link, and stop it with its Stop button. |
| `Not closed: t3_unavailable: teamai launched the T3 thread "review · teamai r70d…" and T3 Code never answered …` | A step's launch got no answer, and T3 Code could not be reached to look the thread up. | Open T3 Code, then `teamai workflow cancel <run>` again. |
| `… launch_unconfirmed: teamai launched the T3 thread "review · teamai r70d…" in the T3 project "acme-app" under an earlier T3 Code sign-in …` | A step's launch got no answer, and you have signed in to T3 again since, so teamai cannot look the thread up. | In T3 Code, stop the thread the message names if it runs, delete the file the message names, then `teamai workflow cancel <run>` again. |
| `… journal_unreadable: Runtime t3 cannot read its record of t3-r70d…, ~/.teamai/runtime-state/t3/places/….json …` | The file where teamai keeps a step's threads is damaged, so it cannot tell which threads to stop, and it keeps the place. | Stop the run's threads in T3 Code, delete the file the message names, then `teamai workflow cancel <run>` again. |
| `… kept no session for …` | The tool kept no transcript for the worktree, so the step could not be scored. | Check that the instance uses the tool's default home (`~/.claude`, `~/.codex`). |

## What it does not do yet

- A step's thread is a thread of its own, not a child of the thread that started the run. T3 keeps a parent link only for a thread launched on another, linked environment.
- It takes no `credentials`. A thread's tool runs in T3 Code's environment, on T3 Code's own sign-in, so teamai refuses them for this runtime before a step runs: `NAME: env:VAR` with `t3 does not offer can.env, so it cannot keep a credential to the processes it is for`, and `<tool>: login` with `t3 launches agents its own way, in each tool's own home, so it brings no login`.
- A step with `session: continue` or `session.from` starts a new conversation, as OpenCode does: T3 has no way to launch a thread on an existing session.
- A read-only prompt step runs in the copy teamai keeps for it, as a `new` step does in its worktree. A `clone` or `team` step runs on its own folder, which teamai adds to T3 Code as a project. A step with a `role` runs here too. A step with `env` or `setup` goes to `local`.
- T3 reports no token usage, so a `budget` in tokens cannot be checked here, and it cannot cap `max_turns`.
- `permissions: unattended` steps are not offered. They need a thread whose tool runs in a sandbox, which a later version adds.
