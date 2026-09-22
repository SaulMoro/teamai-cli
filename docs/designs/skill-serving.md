# Serving built-in skill content from the CLI

Issue: [#678](https://github.com/Tencent/teamai-cli/issues/678). Shipped in 0.23.0.

## The problem

The built-in skills describe the CLI, but they did not travel with it.
`deployBuiltinSkills` copied three whole skill directories into every installed
agent's skills directory on `init`, on `pull` and on a recall toggle, and nothing
else touched them. After `npm i -g teamai-cli@latest` the agent kept reading the
previous release's instructions until the member happened to run a pull, and a
machine with several agents could hold several different versions at once. Four
commits exist only to re-align deployed text after a command changed (`e151d43`,
`1ca43ac`, `8bb0548`, `2ddb546`), and every one of them needed a pull on every
machine to take effect.

The copies were also large — 176 KB per agent, with
`skills/team-wiki-codebase/SKILL.md` alone at 38 705 bytes read in full on every
activation — but that is the secondary cost. The primary one is that the agent's
instructions and the binary they describe were versioned separately.

## The shape

**The skill content is versioned with the CLI.** It ships inside the npm package
and is printed by the installed binary, so `teamai skill get core` on version X
prints version X's instructions, byte for byte, with no pull in between.
Upgrading the CLI is the update; there is nothing else to sync.

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
session start            stub frontmatter (description)    ~0.9 KB  always in context
task matches             stub body                          ~1.3 KB  holds the commands
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
- **Recall is decided at run time**, not by withholding a directory at deploy
  time, and it holds on every path that hands out content or a location:
  `skill get <name>` refuses, `skill get --all` leaves the skill out and says so
  on stderr, `skill path <name>` and `skill show <name>` refuse, and
  `skill list --json` reports `blockedByRecall: true` with `path: null`. With no
  team config to consult it fails open. The gate lives in one place:
  `resolveServableSkill` (`src/skill-content.ts`) is the only way to obtain a
  packaged skill outside that module, and it returns `blocked` instead of the
  skill, so a command cannot print a directory it never received.
- **`skill path` takes a name, always.** Printing the `skill-data/` root would
  hand out the parent of every served skill, and `<root>/share/SKILL.md` is
  readable from there — the content the gate withholds one command over. There is
  no argument-less form to close that way around.
- **A member's own skill outranks a packaged name.** `locateSkill` searches the
  team repo, then the installed agents, then the package. `codebase`, `default`,
  `learning` and `share` are ordinary names: a directory a member created under
  one of them is the skill they are asking about, and the recall gate does not
  apply to it.
- **`skill list` needs no team.** The human-readable listing prints the packaged
  catalog even before `teamai init`, with a hint for the team half, so a fresh
  machine can discover what the installed CLI serves the way `skill get` lets it.


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
earlier releases deployed: `team-wiki-codebase` and `teamai-share-learnings`.
`teamai-workflow` and `teamai-import` sat in the old guard set but were never
packaged, so they are not in it: a directory by either name is the user's own.
Deployment removes them from every installed, non-excluded agent, in its
configured skills path; Codex's pass also covers the shared `.agents/skills`,
which no other tool's pass touches.

Codex's shared root is on the removal side of three commands now, because
`resolveSkillDestination` puts the stub there whenever the skill already lives
there: the legacy prune, `recall disable`, and `uninstall`, whose skill discovery
adds `.agents/skills` for `codex` alone. Without it, an uninstall reported
success while leaving `~/.agents/skills/teamai` behind.

**`uninstall` deletes a CLI-owned directory by the same rule.** A team-repo skill
is synced whole, so uninstall removes the whole directory. A CLI-owned one is
not: deployment writes only `PACKAGED_SKILL_FILES` and never touched a file the
member added beside them, so uninstall removes those same paths through
`removeOwnedFiles` and keeps the rest, saying which directory it kept. Deleting
the directory there would undo, one command over, the guarantee pull makes.

**It removes only the files those releases packaged.** `PACKAGED_SKILL_FILES`
lists them, built as the union of `git ls-tree -r <tag> -- skills/` over every
tag, plus `references/provider-tgit.md`, which #724 put on `main` unreleased and
the next release therefore ships, so each path is provably the CLI's. Those files were overwritten with
`overwrite: true` on every pull and no local edit ever survived in one; a file a
member added beside them was never touched by the old deployment and is not ours
to delete now. Directories left empty go; a directory still holding a member's
file is kept, and `pull` says which one and why. Python bytecode of a script we
shipped counts as ours, so a `__pycache__` left by running the wiki scripts does
not strand the tree. The same rule governs the stub directory: the seven
`teamai/references/*.md` a pre-stub release wrote are removed by name, not by
"everything that is not SKILL.md".

`teamai-wiki` (0.13.0, 0.16.x) is deliberately not in the set. It predates the
trees this migration is about, and widening a destructive set belongs in its own
change.

Between the upgrade and that first pull the legacy trees are still on disk, so
two other commands know the names too: `push` never offers them as new user
skills (`isCliOwnedSkillName`), and `recall disable` still removes
`teamai-share-learnings` (`LEGACY_RECALL_SKILL_NAMES`), as it did before the stub.

**Retire that set once 0.23.x is no longer in the field.** The short names
(`wiki`, `share`) are the canonical ones; the long names survive as aliases in
`SKILL_ALIASES` (`src/skill-content.ts`) for documentation and muscle memory,
and can be dropped on the same schedule.

`/teamai-share-learnings` was never a deployed slash command in its own right —
it existed because the directory was installed. The Stop-hook nudge now names
`/teamai` and carries `teamai skill get share` literally, so an agent can act on
it even without inferring the intent.
