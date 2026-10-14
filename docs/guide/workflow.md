# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and read-only prompt steps, each after the steps it needs.

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    needs: [compile]
    command: npm test
    output:
      ok: boolean
  - id: review
    needs: []
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and exactly one of `command`, `prompt`, or `prompt_file`. `agent` is optional on prompt steps. `output` uses the existing shorthand: `string`, `number`, `boolean`, a literal union, an object, or an array with one item type. TeamAI validates successful command stdout or a prompt tool's `output` against it.

Every step after the first lists the steps it waits for in `needs`. `needs: []` starts another branch with no dependency. One step runs at a time: the first step in the file whose needs are done. A step is skipped when a step it needs failed, or when every step it needs was skipped. A skipped step never runs. A failure does not stop other branches. When nothing is left to run, the run ends `failed` if any step failed, otherwise `succeeded`. A missing `needs`, a `needs` id that is not a step, or a cycle makes the file invalid. A missing `needs` also leaves the workflow with nothing to run, even when an older version was valid.

`teamai pull` and `teamai push` check each file on its own. A `prompt_file` must be a regular, non-symlink file under `prompts/` in the team repo. Its text is cached with the validated workflow, so an existing run keeps that revision even if the source is later changed or deleted. A file that was valid before keeps that version in the local cache when a new revision is invalid. A field this version of teamai does not know is different: that workflow has nothing to run until teamai is updated.

A workflow can declare named `ends`, each `succeeded` or `failed`, such as `ends: { dropped: succeeded, stuck: failed }`. A step with `end: <name>` finishes the workflow when it succeeds. A step with only `id`, `needs`, and `end` runs nothing: it ends the workflow as soon as its needs are done. When an end is reached, every step that has not run is skipped, and the run takes that end's outcome, even if another step failed. `done` then carries the end: `{"done":{"run":"<run>","outcome":"succeeded","end":"dropped"}}`. An `end` that is not in `ends`, an `end` without `ends`, a declared end that no step uses, or a step that needs a step that only ends the workflow makes the file invalid.

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
