# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and read-only prompt steps in order.

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    command: npm test
    output:
      ok: boolean
  - id: review
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and exactly one of `command`, `prompt`, or `prompt_file`. `agent` is optional on prompt steps. `output` uses the existing shorthand: `string`, `number`, `boolean`, a literal union, an object, or an array with one item type. TeamAI validates successful command stdout or a prompt tool's `output` against it.

`teamai pull` and `teamai push` check each file on its own. A `prompt_file` must be a regular, non-symlink file under `prompts/` in the team repo. Its text is cached with the validated workflow, so an existing run keeps that revision even if the source is later changed or deleted. A file that was valid before keeps that version in the local cache when a new revision is invalid. A field this version of teamai does not know is different: that workflow has nothing to run until teamai is updated.

Choose headless tools per machine in the local config:

```yaml
workflows:
  tools:
    default: claude
    implementer: codex
```

An agent-specific entry wins over `default`. `claude`, `codex`, and `opencode` are supported. For CI, override this selection for one start with `--tools default=claude,implementer=codex`. A named agent is read from the file `teamai pull` already deployed for the selected tool, in that tool's directory for this scope.

```text
teamai workflow start build --driver local
```

`--driver local` runs one step at a time in the current directory. Each attempt uses `result.json` under the scope's TeamAI data directory, outside the checkout. Prompt steps are read-only: if a tool changes the repository, the step fails and leaves those files in place for inspection. The driver calls the same `next` and `report` operations shown below:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`.

The run is stored in this scope's TeamAI data directory. The command exits when it finishes. A local run that ends `failed` exits with status 1. No workflow process keeps running.

## Run records

Every run publishes a privacy-preserving record to the team's `teamai-reports` branch: once when it starts and once when it ends. Records live in `workflows/runs/<run id>.json`, keyed by run id, so a retried publication updates the same record instead of adding a copy.

A record carries only: the run id, workflow name, phase (`start` or `end`), driver kind and machine, status, start and end times, duration, step counts, the settled-attempt count, the optional agent/tool/model fields, and the publishing username. Prompts, command text, outputs, diffs, secret values, and local workspace paths have no field to land in — the record is built from an allowlist, not filtered from the run state. The driver's workspace is never published.

A publication that fails — no remote, a busy reports lock, a rejected push — is queued in this scope's data directory and retried on the next `teamai pull`. The `start`, `next`, and `report` envelopes then carry `record: pending` instead of `record: published`. The run itself is unaffected: a machine that dies after starting a run leaves it visible as started but not ended.

Run ids are `r` plus 16 hex digits. Runs created before this scheme used 8 hex digits and still resolve.

Workflow totals (runs, succeeded, failed, cumulative duration) are folded into `stats/<username>.yaml` on the reports branch at publication time and shown by `teamai digest`.
