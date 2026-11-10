# oxlint-plugin-teamai

This repository's own lint rules. `npm run lint` loads them through `jsPlugins` in `.oxlintrc.json`, as `teamai/<rule>`.

| Rule | What it stops |
|---|---|
| `teamai/home-env` | HOME reads outside `packages/shared/src/home.ts`. |
| `teamai/learnings-root` | Manual learnings-root joins outside their owner. |
| `teamai/configured-tool-paths` | Manual configured skill, rules, and instruction-file joins outside `src/locate.ts`. |
| `teamai/launch-env` | A launch variable spelled outside its owner (`src/launch-context.ts`, or `@teamai/runtime-protocol` for `TEAMAI_RUN_DIR`), and any `TEAMAI_` variable spelled in a runtime package. |
| `teamai/launch-through-workflows` | Launching an AI tool outside a workflow driver: an import of `src/workflow/runtimes/tool-caller.ts`, of `runConfined` from `src/workflow/confined-launch.ts`, or of any name or subpath of `@teamai/runtime-tools` or `@teamai/tool-launch`, from outside `src/workflow/`, `packages/runtime-tools/` and `packages/runtime-sandbox/`; or a process call (`spawn`, `execFile`, `exec`, `crossSpawn`, `execa`, `execCommand`, `probeBinary`, `execute`) there whose command is a tool's executable, unless its arguments start with `--version`, `claude plugin`, `opencode serve` or `opencode session`. Run the AI work as a workflow step (`docs/designs/ai-through-workflows.md`). Tests and type-only imports are exempt. The rule's test fails on an allowed folder that does not exist and on a launcher no import reaches. |
| `teamai/workflow-boundaries` | Workflow entry-point violations and transitive skill-to-local dependencies. |
| `teamai/no-provider-merge` | Merge operations in providers and delivery, and forbidden delivery/snapshot dependencies. |
| `teamai/windows-tests` | POSIX constructs in the current `WINDOWS_TESTS` selection. |
| `teamai/rules-locate` | MCP path lookups during rules activation. |
| `teamai/workflow-failure-codes` | Unclassified failure producers and unexplained forwarded codes. |
| `teamai/config-load-options` | Missing preview options at named `loadLocalConfig`, `loadLocalConfigForScope`, and `autoDetectInit` calls outside their owner. Forwarded options are accepted; wrapper behavior still needs tests. |
| `teamai/remove-delivered` | A call of `remove` from `fs-extra` or `src/utils/fs` in `src/pull.ts` or any file under `src/resources/`, which leaves a stale entry on the delivery record when it deletes a delivered copy (#1577). Use `removeDelivered(ledger, dest)`. A new file under `src/resources/` is checked without being listed; a delivery written elsewhere is not. |
| `teamai/attempt-result-writes` | A write to an attempt's result file outside `src/workflow/attempt-result.ts`, which would keep any credential its body repeats. Use `AttemptResult.write(file, body, secrets)`. It recognizes the file by `attemptResultPath(...)`, a name bound to one, or a `resultPath`: a path passed on under another name is not caught. |
| `teamai/untrusted-finish-git` | A `commitWork(` call whose git is not `untrustedGit`: left to its default, the host `git`, or `boundedGit`. A step ran in the checkout it commits, so any other git runs the hooks and fsmonitor the step planted in its config on the host. It reads `commitWork` under any import name or off a namespace, and accepts `untrustedGit(...)`, a name every assignment in scope binds to one, and a call of a function of the same file whose every returned git is one; a parameter, so a git passed in from another module, is reported, so pass the factory's result where it is made. |
| `teamai/git-exit-code` | A simple-git `.raw([...])` call of a git command that answers only with its exit code: `merge-base --is-ancestor`, `cat-file -e`, `diff`/`diff-index`/`diff-files`/`diff-tree` with `--quiet` or `--exit-code`, `show-ref --quiet`/`--exists`, `check-ignore -q`. `raw` resolves on a non-zero exit with nothing on stderr, so such a check always passes. Use `git()` from `src/workflow/worktree.ts`, which returns `code`. |
| `teamai/spawn-command` | `cross-spawn` imported in production source (`import`, `import()` or `require`) outside `packages/shared/src/exec.ts`. Start a process with `spawnCommand` or `spawnCommandSync` from `@teamai/shared/exec`: on Windows they run an npm `.cmd` shim under the system cmd.exe with its arguments escaped twice and look a bare name up on the child's `PATH`, so every launch takes one Windows path. Tests may mock `cross-spawn`. |
| `teamai/readline-error` | A `createInterface` whose `input` is not `process.stdin` (a socket, a child's output, a file stream), in any source or test, with no `error` listener: none chained on the interface or on the name it is bound to, and no `for await` or async iterator over it. readline re-emits its input's errors on the interface and throws them when nothing listens there, so a failed socket or stream ends the process. A terminal's `process.stdin` is left alone: an error there ends the command as it should. |
| `teamai/regular-file-reads` | A `readFile`, `readFileSync`, `createReadStream`, `copyFile`, `copyFileSync`, or an `open` or `openSync` whose flags may read, of `fs`, `fs/promises` or `fs-extra`, fs-extra's `readJson` / `readJSON` and `copy`, or node's `cp` (and their `Sync` forms) (called off the module, its `promises`, or imported by name), in production source under `src/` and each package's `src/`. The rule takes no option and no file is exempt: `src/utils/fs.ts` is checked where its wrappers (`readFileSafe`, `readJson`, `fileHash`) are written, and a read that must stay plain, such as the helper's own or the nonblocking one of `src/hook-fast-path.ts`, which cannot load it, carries an `oxlint-disable-next-line` saying why. A step writes the paths the engine reads, and a FIFO it leaves at one blocks a plain read until a writer opens it, past every deadline, while a plain copy reads a device as a file. Read with `readRegularFile` or `openRegularFile`, and copy with `copyRegularFile` or `copyRegularTree`, from `@teamai/shared/regular-file`, which open without blocking and refuse anything but a regular file. A read through a module the rule cannot see as `fs`, such as one passed in, is not caught. |
| `teamai/tool-facts` | A list of tool ids, or a table keyed by tool that leaves some out, outside `src/tools.ts`. Put the fact in `TOOLS`, or key the table by every tool (`Record<ToolId, ...>`), so a new tool fails the type check until it is decided. An ordered registry, an alias map or a frozen history table carries an explained disable. It checks `src/` and `packages/*/src/`, against the shipped ids in `tool-ids.generated.json`, which `node scripts/check-docs.mjs --write` writes from the tool registry; a missing or empty file fails every production file instead of checking nothing. |
| `teamai/yaml-parse` | `YAML.parse` or yaml's `parse` outside `packages/shared/src/yaml.ts`. Use `parseYaml` (`@teamai/shared/yaml`), which returns JSON values instead of a Set, Buffer or Date for `!!set`, `!!binary` or `!!timestamp`. |
| `teamai/package-boundaries` | A workspace package (`packages/<name>/`) importing `src/` or any repository file outside itself, a relative import into another package instead of its name (`'../../tool-core/src/definition.js'` → `'@teamai/tool-core/definition'`), `src/` importing a `packages/runtime-*` package but `runtime-protocol` and `runtime-tools`, which runs in teamai's process (its tests may import `@teamai/runtime-testing`), a runtime package importing another runtime but `runtime-protocol`, `runtime-kit` and, from tests and `src/testing/`, `runtime-testing`, `runtime-protocol` importing more than `@teamai/shared` and the tool-core levels, home and usage, `runtime-kit` importing more than the protocol and `shared`, `tool-launch` importing a runtime package or, outside its tests, a value from a module that starts a process (`PROCESS_STARTERS`, as in `teamai/tool-family-shape`), and a package whose `package.json` is missing `"private": true`. It reads `import`, `export … from`, `import()`, `require()` and `vi.mock`, a template with no placeholder as a literal; an `import()` or `require()` whose module name is computed is reported in a package and in production `src/`, since its side cannot be checked: disable that line saying why the module is outside the repository. A new folder under `packages/` is checked with no change here. |
| `teamai/tool-registry` | Importing `TOOLS`, `LAUNCH_ADAPTERS` or `ADAPTER_REGISTRY` outside the registry (`src/tool-registry.ts`, and `src/launch-registry.ts` for launch adapters): `import { TOOLS } from './tools.js'` then `TOOLS[tool].autoCompact` becomes `descriptorOf(tool).autoCompact` from `./tool-registry.js`. Readers not moved yet are listed in the rule's `NOT_YET_MOVED`, which only shrinks: an entry that stops reading a table fails until it is removed. Tests are exempt. |
| `teamai/runtime-serve` | In a `packages/runtime-*` package's production source (not `runtime-protocol`, `runtime-kit`, `runtime-testing`, tests or `src/testing/`): a `createInterface` over the process input (`process.stdin`, or a value named `input`), a `RuntimeRequestSchema.parse` or `.safeParse`, or an object literal with `op` and an `event` of `exited`, `finished`, `cancelled` or `failed`. `serveRuntime` and the ledger from `@teamai/runtime-kit` do those for every runtime. Files not on the kit yet are listed in the rule's `notYetOnTheKit` option in `.oxlintrc.json`, which only shrinks: an entry that stops serving the protocol itself, or whose file is gone, fails until it is removed. |
| `teamai/tool-family-shape` | In a tool family's production source (`packages/tool-*/src/`, not `tool-core`, `tool-testing`, `tool-definitions`, `tool-launch`, tests or `src/testing/`): importing a value from a module that starts a process (`PROCESS_STARTERS` in `utils.js`: `node:child_process`, `cross-spawn`, and every workspace module that reaches one, such as `@teamai/shared/exec` or `@teamai/shared/cli-path`; a test derives that list from the source graph, through relative imports and workspace module names, so a new wrapper fails until it is listed and a stale entry fails until it is removed), and an `index.ts` that exports more than `family`. A family builds argv and reads output; `@teamai/tool-launch` runs the launch through the port its caller gives, and the host runs a version detector's probe argv (`readVersion` in `@teamai/tool-core/detect`). A new `tool-<name>` package is checked with no change here. The rule takes no option and lists no exception: session readers and token formats run their tool through the processes the host gives them. |
| `teamai/test-seams` | A `*.test.ts` under `packages/*/src/` importing a file of its own package other than the module it is named after (`offer.test.ts` → `./offer.js`), files under `src/testing/`, and the files its `exports` map names. Tests that still reach past a seam are listed in `PAST_A_SEAM`, which only shrinks: an entry the test no longer imports fails until it is removed. |
| `teamai/mock-source` | A `vi.mock` or `vi.doMock` of a module that only re-exports another one, which leaves every module importing the original unmocked. With a `src/utils/log-forward.ts` that is `export * from '@teamai/shared/log'`, `vi.mock('../utils/log-forward.js', ...)` becomes `vi.mock('@teamai/shared/log', ...)`, because code in `packages/*` imports the package. Imports of the old path still get the mock. Any file under lint is checked; a barrel over several modules is not reported. |
| `teamai/uncached-entry` | An import of anything but a `node:` module or another file in `UNCACHED` from what `src/bin.ts` loads before the CLI bundle: every hook loads it, and the hook fast path exits on it alone (#1788). A new file there joins `UNCACHED` once it imports nothing else. Type-only imports are exempt. |
| `teamai/no-low-value-comments` | A comment that only repeats the name below it (`// State` above `const state`), commented-out code, a `TODO` with no issue, or a JSDoc type in TypeScript. Issue numbers and `// ───` dividers stay allowed. |
| `teamai/suppression-reason` | An `oxlint-disable` / `eslint-disable`, or a `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck`, that says nothing about why. End it with `-- reason` (after a TypeScript directive, just the reason), or put the reason in a comment on the line above. |

Production-scoped rules check `src/` and `packages/*/src/`, outside `src/__tests__/` and `*.test.ts`.

The plugin also carries the generic rules of anti-slop, vendored in `anti-slop/` (`anti-slop/UPSTREAM.md` says from where). They report as `teamai/<rule>` and hold production code only; tests are exempt. Each message names its fix, for example:

| You wrote | `npm run lint` says | Fix |
|---|---|---|
| `typeof payload.session_id === 'string'` on parsed hook JSON | `` teamai(no-runtime-typeof): A `typeof` check narrows a representation without establishing its contract. `` | Parse the payload with a zod schema where it comes in, then read `parsed.data.session_id`. |
| `return name as ToolId;` | `` teamai(require-safety-comment-for-type-assertion): This type assertion has no `SAFETY:` justification. `` | Drop the cast, or write the check that makes it true on the line above: `// SAFETY: the includes() check above proves name is a ToolId.` |
| `const body: Record<string, unknown> = { name, private: true }` | `` teamai(no-known-value-widening): The explicit open dictionary type on binding `body` discards known type evidence. `` | `const body = { name, private: true }` |
| `items.filter((item) => item.active).map((item) => item.id)` | `` teamai(no-array-filter-map): Avoid consecutive array `filter` and `map` passes. `` | `items.flatMap((item) => (item.active ? [item.id] : []))` |

## Add a rule

1. Write `rules/<rule>.js` with `defineRule`, and register it in `index.js`. oxlint imports these files with plain Node, so they are JavaScript (`npm run lint` runs on Node 20 in CI); `npm run typecheck` checks them through their JSDoc types.
2. Turn it on in `.oxlintrc.json`: `"teamai/<rule>": "error"`.
3. Test it with real oxlint in `rules/<rule>.test.ts`:

```ts
import { describe, expect } from 'vitest';
import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/remove-delivered', { filename: 'src/pull.ts' });

const bareRemove = `import { remove } from './utils/fs.js';\nawait remove(dir);`;

describe('teamai/remove-delivered', () => {
  rule.invalid('reports remove from src/utils/fs', bareRemove, (output) => {
    expect(output).toContain('removeDelivered');
  });
  rule.valid('allows removeDelivered', `await removeDelivered(ledger, dir);`);
  rule.valid('only in pull\'s files', bareRemove, { filename: 'src/push.ts' });
});
```

`filename` is where the fixture sits, relative to the repository root, so a rule scoped to some files can be tested in and out of them. Shared AST helpers go in `utils.js`. All cases in one harness invocation run through one oxlint subprocess, with diagnostics checked against each fixture and its intended rule.

A line that must break a rule carries the reason:

```ts
// oxlint-disable-next-line teamai/remove-delivered -- a team-repo file, which pull never records
await remove(teamFile);
```

`npx vitest run oxlint-plugin-teamai` runs the rule tests; `npm run typecheck` checks the plugin.
