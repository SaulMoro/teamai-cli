# Workflow engine

Maintainer notes on `src/workflow/`. The workflow file format and the driver contract are in the [Workflows](../guide/workflow.md) guide page.

Each rule below spans more than one file. The rule names the code that owns it, so you can read the details there.

## Rules that span files

- **A run ends only in `settleRun`.** `leaseNext` calls it before it hands out a lease. `reportAttempt` records the outcome and never ends the run. After a failed report, the next `next` skips the dependents and ends the run. To run code when a run ends, hook into that path in `leaseNext`. Do network I/O only after `withRun` releases the run lock.
- **Settling does not change `revision`.** Only `reportAttempt` increments it. Skips, `if`, `end`, and the creation of child steps happen inside `next`, so the `report` of an open lease still matches its revision.
- **A step waits for every step it reads.** `readsOf` collects the steps that the step's `if`, templates, and `with` read. For a step that runs an inline workflow, it also collects the outer steps that the inline steps read. `skipUnreachable` uses that set to decide readiness. If a new field reads steps, add it to `readsOf`. Otherwise the step can read a value before it exists, or an inline workflow can wait forever.
- **Pull and the engine share one list of templated fields and one list of actions.** The templated fields are in `templatedTexts` in `template.ts`. The actions are in `STEP_ACTIONS` in `types.ts`. Add a new field or action there, not to a copy in `parse.ts` or `engine.ts`.
- **A new step status must fit `stopped()` and `settled()`.** Both are in `step-state.ts`. `stopped()` decides which dependents are skipped, which steps can recover, and the run outcome. `settled()` decides readiness. Each switches over every status, so a status added to `StepStateSchema` does not compile until both place it.
- **Only the transitions in `step-state.ts` write step fields.** `skip`, `lease`, `release`, `start`, `succeed` and `fail` change a step in place and drop the fields its new status does not have. `readRun` parses every step through `StepStateSchema`, which gives a run file from an older teamai its defaults: `settledAt` 0, `outcome` from `status`, and no fields its status does not have.
- **A pull check that changes what a file means carries a `code`.** `dropsKeptVersion` in `cache.ts` removes the cached copy when a diagnostic has a `code`. An older definition then cannot keep running with the new meaning. A diagnostic without a `code` keeps the last valid version, but only after `checkReferences` checks that version again against what the workflows it runs settle to in the same sync.
- **The workflow cache holds only what one sync settled.** `checkReferences` checks each file's version against the versions the other files settle to, and `dropUnsettled` removes every other cache entry. `startRun` relies on this: it reads the workflows a run uses from the cache and does not check them against each other again. A new way for a file to keep or lose its version goes through `checkReferences`.
- **Step ids are paths.** A step inside a sub-workflow has an id such as `ship.check.classify`, and an item of a `for_each` step will have one such as `build[2]`. `parseStepPath` in `step-path.ts` reads both; don't split ids by hand. A child step exists in the run only after the engine reaches it. To find a step's definition, use `locateStep`. Don't look it up by top-level id.

## Tests

Test parsing through `parseWorkflow` and `syncWorkflowDefinitions`. Test the engine through `startRun`, `leaseNext`, and `reportAttempt`. Every driver must pass the conformance suite in `src/workflow/conformance.ts`. If a driver can see a new behavior, add a scenario there.
