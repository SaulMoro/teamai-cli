# Serving built-in skill content from the CLI

Issue: [#678](https://github.com/Tencent/teamai-cli/issues/678). Shipped in 0.23.0.

## The problem

`deployBuiltinSkills` copied three whole skill directories — 176 KB — into every
installed agent's skills directory, on `init`, on `pull` and on a recall toggle.
Nothing else redeployed them, so `npm i -g teamai-cli@latest` left the previous
content in place until the member ran a pull. Four commits exist only to
re-align deployed text after a command changed (`e151d43`, `1ca43ac`, `8bb0548`,
`2ddb546`), and `skills/team-wiki-codebase/SKILL.md` alone was 38 705 bytes —
roughly 10k tokens read on every activation, before the agent opened a single
reference file.

## The shape

One deployable unit, everything else served on demand. The pattern is
`vercel-labs/agent-browser`'s, verified against its published 0.38.1 package.

```text
npm package
├── skills/
│   └── teamai/SKILL.md          the only unit deployed into agents (~2 KB)
└── skill-data/                  never deployed; printed by `teamai skill get`
    ├── core/                    daily sync, routing, generated command reference
    ├── setup/                   day 0 and repo lifecycle
    ├── wiki/                    codebase knowledge base, incl. scripts/
    └── share/                   session learnings
```

`skills/` keeps the invariant "everything here is deployed", which is what lets
`BUILTIN_SKILL_NAMES` hold a single name instead of a list of guards.

What an agent reads, and when:

```text
session start            stub frontmatter description      ~1.3 KB   always in context
task matches             stub body                          ~0.9 KB  holds the commands
`teamai skill get core`  daily workflow                     ~5.7 KB  on demand
`… core --full`          + troubleshooting + commands.md     ~32 KB   on demand
`… setup` / `wiki` / `share`                                          on demand
```

## Contracts worth keeping

- **`skill get` prints the file byte for byte**, frontmatter included, with no
  banner. The only transformation is `{SKILL_DIR}`, replaced with the absolute
  packaged directory, so a documented `python3 {SKILL_DIR}/scripts/scan_repo.py`
  runs as written. `agent-browser` leaves that placeholder unsubstituted; an
  agent copying such a line literally fails, which is why we resolve it.
- **Content on stdout, diagnostics on stderr.** An unknown flag warns and the
  command continues — a hallucinated flag should not cost a round trip. An
  unknown *name* is fatal: acting on the wrong instructions is worse than a
  retry.
- **`--full` walks `references/` and `templates/` recursively**, sorted by
  relative path. Our references nest (`references/methodology/`,
  `references/phases/`); a single-level scan would serve an incomplete skill.
- **Nothing repairs the deployed stub.** `ensureSkillFrontmatter` is not called
  on it, so deployed and packaged bytes are identical and a diff means a bug.
- **Recall is decided at run time**, inside `skill get`, not by withholding a
  directory at deploy time. With no team config to consult it fails open.

## Drift guards

Two tests, both in the unit suite:

- `commands-reference.test.ts` renders `skill-data/core/references/commands.md`
  from the Commander table and diffs it. Regenerate with
  `npx vitest run commands-reference -u`.
- `skill-commands-exist.test.ts` resolves every `teamai …` string written
  anywhere under `skill-data/` against that same table, and fails on an unknown
  command or flag. It carries a case proving it catches `teamai extract graph`,
  the command the wiki skill advertised for four releases.

A third, in `skill-content.test.ts`, asserts through `npm pack` that both
`skills/` and `skill-data/` are in the published tarball. Without it, a missing
`package.json` "files" entry passes every other test and serves nothing once
installed.

## Migration

`LEGACY_BUILTIN_SKILL_NAMES` (`src/builtin-skills.ts`) names the directories
earlier releases deployed: `team-wiki-codebase`, `teamai-share-learnings`, and
the two that were only ever guards, `teamai-workflow` and `teamai-import`.
Deployment removes them from every installed agent, in the configured skills
path and in Codex's shared `.agents/skills`. The removal is unconditional
because those trees were overwritten with `overwrite: true` on every pull, so no
local edit ever survived in them.

**Retire that set once 0.23.x is no longer in the field.** The short names
(`wiki`, `share`) are the canonical ones; the long names survive as aliases in
`SKILL_ALIASES` (`src/skill-content.ts`) for documentation and muscle memory,
and can be dropped on the same schedule.

`/teamai-share-learnings` was never a deployed slash command in its own right —
it existed because the directory was installed. The Stop-hook nudge now names
`/teamai` and carries `teamai skill get share` literally, so an agent can act on
it even without inferring the intent.
