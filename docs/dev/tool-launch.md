# Tool launch

Maintainer notes on `src/tool-launch/`, the code that starts a coding tool headless: for teamai's own AI calls, for a workflow step, and for a run confined to one directory, which judges a scorer.

Each rule below spans more than one file. The rule names the code that owns it, so you can read the details there.

## Rules that span files

- **A tool launches through its adapter.** `launch` on the tool's descriptor (`packages/tool-<family>/src/definitions.ts`) names an entry of `LAUNCH_ADAPTERS` in `adapters.ts`, or `none`. The adapter holds the profiles teamai builds for it, declared in the family's `launch.ts`: `call` always, `step` and `confined` when the tool can run them. Code in `src/` reads an adapter with `launchAdapterOf(tool)` (`tools.ts`), never `LAUNCH_ADAPTERS` itself (lint rule `teamai/tool-registry`). `LAUNCH_ORDER` in `tools.ts` is the order a call tries installed tools in; the step tools (`LAUNCH_TOOLS`) and confined tools (`CONFINED_TOOLS`) are the tools of that order whose adapter has the profile. To add a tool, add or reuse a profile in its family's `launch.ts`, add the adapter's row to `LAUNCH_ADAPTERS`, set `launch`, and place the tool in `LAUNCH_ORDER`.
- **Every AI call goes through `callTool`.** `call.ts` picks the tool (`TEAMAI_AI_TOOL`, then `ai.tool` of the scope's loaded config, its own before the machine's (the scope a caller acting for one passes, else the working directory's), then the first installed tool of `LAUNCH_ORDER`), runs it with `runTool` in `run.ts`, and reads the reply with the adapter's `read`. A caller with a fallback rethrows `isOverrideInvalid` errors, so a wrong override, or a scope config that cannot be read, is never hidden.
- **A launched session says who launched it.** Calls, steps and judges set `LAUNCHED_BY_ENV` (`launch-context.ts`). `hook-dispatch-cli.ts` skips every hook of a session teamai launched, except a workflow step's.
- **The support page follows the adapters.** The `workflows` and `aiBackend` cells in `src/tools.ts` stay hand-written, for their evidence and notes, and `tools.test.ts` fails when a cell marks a feature built that the adapter has no profile for, or the reverse.
- **Steps and confined runs still switch on the adapter.** `invocation` in `drivers/local/local-tool-adapter.ts` ends in a `never` check, and the confined argv and reply tables in `confined.ts` (`LAUNCHES`, `REPLIES`) need an entry per adapter with a `confined` profile, so a new adapter with a `step` or `confined` profile fails the type check until both handle it.
