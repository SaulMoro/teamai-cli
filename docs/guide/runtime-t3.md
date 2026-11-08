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

**1. Open T3 Code on this machine**, or run `t3 serve`. If the repository is not a T3 project yet, the first run adds it, as `t3 project add ~/src/acme-app` would, and says so:

```text
⚠ Step runtime "t3", operation op-7110631d3e39: Adding /Users/you/src/acme-app to T3 Code as a project, so its steps can run there.
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

The first run signs teamai in to T3 Code with no page and no question. teamai asks the `t3` command on this machine for a pairing code that lasts two minutes, and uses it to approve its own sign-in with Auto access, even when you [tighten `runtime_mode`](#how-much-a-step-thread-asks-you): each thread still runs in its own mode, and one sign-in serves every run. Only [`runtime_mode: full-access`](#full-access-on-a-machine-you-can-lose) makes it sign in with Full access. The command it runs:

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

teamai runs the first `t3` it finds: `$T3CODE_CLI_PATH` (T3 sets it in its own threads), then `t3` on your PATH, then `bin/t3` in T3's data directory (`~/.t3/bin/t3`, or under `$T3CODE_HOME`). If it finds none, or T3 refuses the code, the run opens T3's sign-in page instead, and prints its link in case no browser opens. Create a pairing code in T3 Code, pick **Auto** access (**Full access** when `runtime_mode` is `full-access`), enter the code and approve. The access you pick is the broadest mode a step thread can run in.

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

teamai settles only the threads it launched, and the threads of the tasks they delegated. If T3 refuses to settle one, the step still counts and the thread stays active.

## How much a step thread asks you

A step thread is a thread of its own, so nobody but you can answer its requests. It starts in the default mode you set in T3 Code: the project's own setting if it has one, else the global one, else Auto. It never takes the mode of the thread you started the run from, and never runs in Full access unless `runtime_mode` says so. When your default is Full access, it runs in Auto, and the run says so.

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

It takes `auto`, `auto-accept-edits`, `approval-required` or `full-access`. Any other value fails before T3 is called:

```text
{"error":{"code":"bad_option","message":"Runtime \"t3\" of driver definition …/drivers/teamai-t3.yaml refused option \"runtime_mode\": runtime_mode \"yolo\" is not one runtime t3 takes. A step thread runs in the member's T3 default mode, or auto, never full access unless runtime_mode says so; runtime_mode sets it to auto, auto-accept-edits, approval-required or full-access. Remove it, or set one of those four. Fix the option and start again."}}
```

teamai's sign-in caps the mode. If it allows less than the run's mode, T3 refuses the thread and the step fails. For example, someone approved teamai in T3's page with Supervised access, and this run uses Auto:

```text
✖ Step "review" failed with runtime_failed: The step runtime could not run the prompt (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode, because teamai's sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.
```

### Full access, on a machine you can lose

When T3 Code runs somewhere a step can do no harm, such as a VM of its own, `runtime_mode: full-access` runs every step thread in Full access, so it asks you nothing:

```yaml
# .teamai/drivers/t3-vm.yaml
schemaVersion: v1alpha1
name: t3-vm
description: T3 threads in full access, for a T3 that runs inside its own VM.
runtimes:
  - use: t3
    options: { environment: local, runtime_mode: full-access }
  - use: local
```

The run says so once, as it starts, and records the steps' isolation as `none`:

```text
⚠ Runtime t3 of driver t3-vm runs steps in full access on this machine, as /repo/.teamai/drivers/t3-vm.yaml sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.
```

teamai signs in again, this time with Full access (the pairing code also asks for `settings:write` and `source-control:write`). A judge's thread still runs in Auto. `permissions: unattended` steps are still not offered.

## Pick the provider instance and the model

The tools are the T3 provider instances that can run now, leaving out any you turned off for the project. A step that names no tool, in a definition that names none, runs on the tool of your T3 default model (the project's, else the global one). When a provider has several instances, `claude` and `codex` run on the instance of your T3 default model when it runs the provider's own binary (no Binary path, or one named `claude` or `codex`), else on the one named after the provider (`claudeAgent` for Claude, `codex` for Codex) whatever its Binary path, else on the first that runs the provider's own binary. An instance whose Binary path is a wrapper, such as a team tool's command, runs only that team tool, even when it is your T3 default; a step with no tool then runs on that team tool, or, when no team tool runs on it, as `claude` on the instance picked above. To run every prompt on one instance, for example a second Claude account, name it in your machine's config:

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

To move one tool alone, map it under `instances`, for example `instances: { claude: claude-work }`: Claude steps run on `claude-work`, and Codex steps keep their instance. A mapping to an instance T3 cannot run leaves that tool out of T3: its steps run on the next runtime of the definition that has it, this machine on `teamai-t3`, or fail before T3 is called, saying what to set, when none has it. A name there that is neither `claude`, `codex` nor a [team tool](reference.md#team-tools-tools) you have maps nothing, and the run says so as it starts. The other tools still run:

```text
⚠ Step runtime "t3": instances names acme-cluade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.acme-cluade, or name the instance as its tool definition does.
```

A step's `model: { name, effort }` picks the model, and `effort` becomes the option that instance names it by (`effort` for Claude, `reasoningEffort` for Codex). A step with no model gets your T3 default model (the project's, else the global one) when that model is on the step's instance; T3 picks it, as for a thread you start. Otherwise it gets the first model the instance lists. Something the instance cannot run fails before any thread starts:

```text
✖ Step "review" failed with model_unavailable: T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.
```

Started from a T3 thread, such as by the thread's agent, a step that names no tool or model runs as that thread does: on its provider instance and model, in place of your T3 default. For example, from a thread on `claude-work` with `claude-sonnet-5-5`, a step with no tool runs `claude` on `claude-work` with `claude-sonnet-5-5`. T3 does not report a thread's model options, so the model runs with its own default effort. The mode is never the thread's: it comes from [How much a step thread asks you](#how-much-a-step-thread-asks-you). When the thread runs on an instance T3 cannot run steps on here, the run uses your T3 default. When T3 cannot read the thread, it does too, and says so as it starts:

```text
⚠ Step runtime "t3": teamai could not read the T3 thread thread-7f3a… this run was started from (Thread thread-7f3a… is no longer available), so a step that names no tool or model runs on your T3 Code default instead.
```

### Team tools

A [team tool](reference.md#team-tools-tools) such as `acme-claude` (`extends: claude`, `command: acme-claude`) runs on the T3 provider instance whose Binary path, in T3 Code under Settings → Providers, is the absolute path of `acme-claude`, or on the one `instances: { acme-claude: <its id> }` maps. A tool with a home of its own and no command, such as `claude-work` (`extends: claude`, `home: { dir: .claude-work, env: CLAUDE_CONFIG_DIR }`), runs on the instance that runs Claude's own binary with that Home path. Its session is read in that instance's Home path.

When no instance runs it, teamai adds one the first time a step runs on it, and says so:

```text
⚠ Step runtime "t3", operation op-5781c58b81a1: Added the T3 Code provider instance "acme-claude" (driver Claude, Binary path /opt/acme/bin/acme-claude), so acme-claude runs on T3 Code. It stays for later runs; remove it in T3 Code under Settings → Providers.
```

The instance is named after the tool. Its Binary path is the tool's command as your PATH finds it (Claude's own binary for `claude-work`), and its Home path the tool's own home, when that is not its base tool's (`~/.claude`, `~/.codex`), which teamai leaves unset. teamai writes it into T3's settings and keeps every other setting; T3 Code picks it up at once. Two runs add it once, and later runs use it with no change. A run that never runs the tool adds nothing.

teamai writes T3's settings file as you, in attended and unattended runs alike, as it adds a project with the `t3` command. It asks T3 for no wider sign-in: each thread still starts in the mode it would. When T3 Code writes the file at the same moment, teamai reads it again and keeps what T3 wrote.

When T3 does not offer the tool (the command is not on your PATH, two instances run it, one that runs it is turned off, or T3 already has an instance of its name), its steps run on the next runtime of the definition that has it, this machine on `teamai-t3`; on a definition with no other runtime for it they fail before any thread starts, with that reason:

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: t3: No T3 Code provider instance runs acme-claude, and teamai cannot add one: acme-claude is not on PATH here. Install acme-claude, or add one in T3 Code under Settings → Providers, with driver Claude and Binary path the absolute path of acme-claude (command -v acme-claude), or map one with instances: { acme-claude: <its id> } in the definition's t3 options. Or remove tool from the step.
```

When the instance that runs a team tool has another home than teamai gives the tool, the tool signs in and keeps its sessions in the instance's home, and the run says so as it starts. A tool with no home of its own, such as `acme-claude`, has its base tool's home, which `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moves; in a run started from a T3 thread teamai leaves those out, since T3 sets them there to the thread's own instance:

```text
⚠ Step runtime "t3": T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.claude, while teamai gives acme-claude the home ~/.acme-claude: on T3 it signs in and keeps its sessions there. To use the same home, set the instance's Home path in T3 Code under Settings → Providers to ~/.acme-claude.
```

## Project scripts

T3 runs a project's **setup** script ("Run on worktree creation") in each worktree a thread opens on, and its **settle** script when a thread is settled. teamai prepares the step's worktree itself, so neither runs for a step:

- When the project has a setup script, teamai adds the step's worktree to T3 Code as a project of its own, titled `acme-app · teamai <run>`, and runs the thread there. Once teamai removes the step's worktree, it removes that project and its thread from T3 Code. It never renames or removes the project you run from.
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
- It runs in `runtime_mode` (Auto when that is `full-access`), else your global T3 default mode, else Auto; never in Full access. When the judge's place closes, teamai settles the thread and removes the copy.

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

Stop the thread, then run the same cancel again. If T3 still cannot confirm it once you checked the thread no longer runs, `teamai workflow cancel <run> --release <attempt>` lets the attempt go: teamai tries the stop once more, then forgets the thread, whatever T3 answers.

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
| `… (t3_version): T3 Code runs version 0.1.7…; teamai-runtime-t3 needs T3 Code 0.1.8 or later …` | Your T3 Code is older than the one teamai is tested against. | Update T3 Code, then run again. |
| `… (login_required): … could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ~/.t3/bin/t3) …` | An unattended run has no valid sign-in, and the `t3` command could not create one. The text in brackets says why. | Check that `t3 auth session list` works in the shell teamai runs in, then run again. Or start a workflow from a terminal once and approve teamai in the page. |
| `… (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode …` | teamai's sign-in allows less than the mode the thread runs in. | Remove `~/.teamai/runtime-state/t3/credentials.json` and run again: teamai signs in again; approve it with Auto access if T3 Code asks. Or set `runtime_mode`. |
| `… (sign_in_too_narrow): teamai's T3 Code sign-in was approved without Full access, which runtime_mode full-access needs …` | Someone picked a narrower access than Full access in T3's sign-in page. | Start the workflow again and pick Full access, or remove `runtime_mode: full-access`. |
| `… is not a project in T3 Code <machine>, and teamai could not add it (…)` | The checkout is not a T3 project, and `t3 project add` failed. The text in brackets says why. | Add it in T3 Code (Add project), or run `t3 project add <path>`. |
| `T3 Code has no provider instance "claude-sandbox".` | `instance` names an instance T3 does not have, or one that is disabled. | Add or enable it in T3 Code under Settings → Providers, or remove `instance`. |
| `… No T3 Code provider instance runs acme-claude, and teamai cannot add one: T3 Code already has a provider instance "acme-claude" that runs another command …` | An instance of that name, yours, runs something else. teamai never changes it. | Point its Binary path at the tool's command, or map another instance with `instances`. |
| `… T3 Code cannot run the provider instance "claude-work" for claude-work yet: Claude Code is not authenticated …` | The instance is there, and T3 Code's own check of it failed, such as a tool never signed in in the instance's home. | Do what T3 Code says, in the home the message names (for Claude, `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`), then retry the step. |
| `… ended without writing the result file …` | The agent finished without writing its result. | Open the thread from the link in the message, then `teamai workflow retry <run> <step>`. |
| `… (cancel_failed): The T3 thread t3code://threads/… ("review · teamai r70d…") still runs, and T3 Code did not stop it …` | teamai cancelled the step, and T3 did not confirm its thread stopped within 10 s. | Open the thread from the link, stop it with its Stop button, then `teamai workflow cancel <run>` again. |
| `… (cancel_failed): teamai launched the T3 thread "review · teamai r70d…", and T3 Code did not confirm the launch …`, or `… could not be followed, so it may still run …` | The step failed while its thread may still run in T3: T3 Code did not answer its launch, or went away during the step. teamai keeps the place and commits nothing. | Open T3 Code, then `teamai workflow cancel <run>`: it finds the thread and stops it. |
| `Not closed: thread_still_runs …` in the run's details | teamai closed the step's place while its thread, or work the thread delegated, still ran, and T3 did not stop it. | Open the thread from the link, and stop it with its Stop button. |
| `Not closed: t3_unavailable: teamai launched the T3 thread "review · teamai r70d…" and T3 Code never answered …` | A step's launch got no answer, and T3 Code could not be reached to look the thread up. | Open T3 Code, then `teamai workflow cancel <run>` again. |
| `… launch_unconfirmed: teamai launched the T3 thread "review · teamai r70d…" in the T3 project "acme-app" under an earlier T3 Code sign-in …` | A step's launch got no answer, and you have signed in to T3 again since, so teamai cannot look the thread up. | In T3 Code, stop the thread the message names if it runs, delete the file the message names, then `teamai workflow cancel <run>` again. |
| `… journal_unreadable: Runtime t3 cannot read its record of t3-r70d…, ~/.teamai/runtime-state/t3/places/….json …` | The file where teamai keeps a step's threads is damaged, so it cannot tell which threads to stop, and it keeps the place. | Stop the run's threads in T3 Code, delete the file the message names, then `teamai workflow cancel <run>` again. |
| `… kept no session for <worktree> in <home> …` | The tool kept no transcript for the worktree in the instance's home: its home path in T3, else `~/.claude` or `~/.codex`. So the step could not be scored. | Check the instance's home path in T3 Code under Settings → Providers. |
| `✖ Step "review" failed with usage_limited: claude reached its usage limit on T3 Code provider instance "claudeAgent" (Claude): …` | The instance reached its provider's usage limit. T3's message after the colon says when it resets, when T3 knows. | Wait for the reset, or switch `instance`, then run the retry command the message ends with. |

## What it does not do yet

- A step's thread is a thread of its own, not a child of the thread that started the run. T3 keeps a parent link only for a thread launched on another, linked environment.
- It takes no `credentials`. A thread's tool runs in T3 Code's environment, on T3 Code's own sign-in, so teamai refuses them for this runtime before a step runs: `NAME: env:VAR` with `t3 does not offer can.env, so it cannot keep a credential to the processes it is for`, and `<tool>: login` with `t3 launches agents its own way, in each tool's own home, so it brings no login`.
- A step with `session: continue` or `session.from` starts a new conversation, as OpenCode does: T3 has no way to launch a thread on an existing session.
- A read-only prompt step runs in the copy teamai keeps for it, as a `new` step does in its worktree. A `clone` or `team` step runs on its own folder, which teamai adds to T3 Code as a project. Once the folder is gone, the next T3 step that closes removes that project. A step with a `role`, `env` or `setup` goes to `local`.
- T3 reports no token usage, so a `budget` in tokens cannot be checked here, and it cannot cap `max_turns`.
- `permissions: unattended` steps are not offered. They need a thread whose tool runs in a sandbox, which a later version adds.
