# Design: teamai data directory layout — global home + per-project partitioning

> Status: **P0 + P1 + P2 + P3 implemented** (issue #374 complete). P1 shipped as PRs #397 / #402 /
> #406 / #414 / #417 (partition routing) and #439 (P1-3 auto-migration). P2 (self
> mode slimming, #455) and P3 (constant functionization + `status --all`) are below.

## Problem

teamai's machine-local data currently lives inside the business repository. In a
real checkout `<repo>/.teamai/` measured **18 MB** — a team-repo clone (12 MB),
downloaded skill resources (4.1 MB), a search index (1.8 MB), plus config, state,
`env`, `token`, and docs. This causes three concrete problems:

- **Workspace residue.** Machine data pollutes the business repo working tree.
- **Worktree / subdirectory blindness.** teamai only looked at the cwd's own
  `.teamai/config.yaml`, so running from a subdirectory found nothing, and a git
  worktree (which does not carry gitignored `.teamai/`) had no config at all.
- **Cross-project mixing.** Global singletons under `~/.teamai/`
  (`dashboard`, `sessions`, `votes`, `usage.jsonl`, ...) are hardcoded to one
  location, so multiple projects' data is indistinguishable.

The end goal (P1+) is to move machine-local data to `~/.teamai/projects/<slug>/`
so the business workspace has **zero residue**, partitioned per project.

## The two anchors (the core model)

A git worktree has two distinct "roots", and teamai needs both:

```
projectAnchor  = first entry of `git worktree list --porcelain` (the main worktree)
                 → the MAIN checkout, SHARED by the repo and all its worktrees.
                 → the stable per-project identity; P1 keys machine data under
                   ~/.teamai/projects/<slug(projectAnchor)>/ by it.

workspaceRoot  = `git rev-parse --show-toplevel`
                 → the CURRENT checkout, DISTINCT per worktree.
                 → where project-scope AI-tool resources (skills/rules/agents,
                   tool config, CLAUDE.md) must be written.
```

They are equal for a plain (non-worktree) repository.

**Why resources must go to `workspaceRoot`, not `projectAnchor`:** every AI tool
(Claude, Codex, CodeBuddy, OpenCode) discovers project resources by scanning up
from the launch directory to the *current* repository root. None of them follows
`git-common-dir` back to the main checkout, and gitignored files do not appear in
a fresh worktree. So resources have to land in the worktree the user is actually
working in.

**What that means for "already synced".** `state.json` sits in the shared
partition, so its `lastPullRev` and `lastPullTargets` say what the *project* last
synced, not what this checkout holds. A project-scope `pull` also records both per
checkout in `lastPullByWorkspace`, keyed by `managedMcpWorkspaceId(workspaceRoot)`
plus the inode and birth time of the checkout's `.git` entry (new each time a
worktree is created, so a worktree re-created at the same path gets its own key),
and takes the unchanged-repo fast path only when the shared `lastPullRev` and this
checkout's own revision and tool targets all match. A worktree added after the
last pull therefore gets a full sync on its first pull, and two checkouts with
different tool directories no longer force a full sync on each other (#807).
Clearing `lastPullRev` still forces a full sync, which is how exclude, tags,
roles, projects, init and bootstrap apply their changes: the pull that finds
`lastPullRev` cleared resets every other checkout's entry to an empty `rev`,
which matches no revision, so each checkout does its own full sync (an older
CLI compares `rev` too, so it also misses the fast path). A new team revision
resets nothing, since a checkout recorded at an older revision already misses
the fast path. `push` needs that entry too: before scanning, it syncs each rule
and skill the member never edited, and "never edited" means equal to the
version at a revision *this* checkout synced, not the shared `lastPullRev`
another checkout may have moved (#812). A placed agent, which push does not
sync, is held when the team file has changed since any of those revisions, or
since it was added if one of them predates it (#823). That sync brings the
unedited copies up
to the team repo, so when push has refreshed the team repo it adds the
revision it synced to the entry's `pushBaseRevs`, newest first, even under
`--dry-run`, since the sync has already written the files, and even when the
sync stopped partway (it warns), since the copies it did not reach still match
an older base. If push cannot save that revision, it stops before scanning and
pushes nothing. The next push
accepts a copy at any of `pushBaseRevs` or at `rev`, so a copy the sync left
alone as edited is recognized again once the member undoes the edit, back to
whichever version a sync gave it. The list keeps the 20 newest revisions; a
copy at an older one reads as an edit until the checkout pulls. Push never
moves the entry's `rev`: the pull fast path reads it, and the checkout still
lacks that revision's docs and agents. A reset entry keeps its bases, `rev`
included, in `pushBaseRevs`, and the next pull in the checkout rewrites the
entry without them. A checkout with no entry (new, or last pulled by an older
CLI) syncs against the shared `lastPullRev`, which may be another checkout's or
cleared, so when the scan lists a team rule or skill as modified, push stops
before creating a branch and asks the member to save any edits to them and run
`teamai pull` in the checkout. A rule this machine placed (`placedRules`) is the
author's own copy and does not count; config-only pushes and new resources go
through. Every full sync keeps only the
entries of checkouts `git worktree list` still reports, so a deleted or
re-created worktree's entry goes with the next full sync in any checkout. A
state.json written before this field has no entry, so each checkout does one
full sync after the upgrade.

### Why the main worktree, not `git-common-dir` (verified)

`projectAnchor` uses the first entry of `git worktree list --porcelain` rather than
`dirname(git rev-parse --git-common-dir)`. Two traps make the git-common-dir route
wrong:

- With `git init --separate-git-dir`, the common dir lives outside the checkout
  (e.g. `gitdirs/proj.git`), so its parent is a shared `gitdirs/` — **colliding**
  across unrelated repos, and not the workspace either.
- `--git-common-dir` alone returns a **relative** path (`.git`) in the main repo
  (only absolute inside a worktree), so it needs `--path-format=absolute` (git
  ≥ 2.31) just to be usable — and still hits the collision above.

`git worktree list --porcelain` lists the main worktree first, and every linked
worktree reports the same first entry, giving a shared-yet-distinct identity in all
cases. Both anchors are `realpath`-normalized so a symlinked prefix (macOS `/tmp` →
`/private/tmp`) does not make one checkout look like two.

### Partition naming (#546 + adoption)

`slug(anchor) = <safe-path>-<sha256(normalized anchor) first 16 hex>` — the whole
anchor path made filesystem-safe (leading separator dropped, separators and other
unsafe chars → `-`), so the directory name reads back to its project, mirroring
Claude Code's `~/.claude/projects/` naming: `/Users/x/Project/app` →
`Users-x-Project-app-<hash>`. The trailing hash is what guarantees uniqueness
(a `/`→`-` escape alone is not injective: `/x/my-proj` and `/x/my/proj` would
collide and silently merge two projects' plaintext env), and the prefix is
length-bounded so a deep path can never overflow `NAME_MAX`. The per-partition
`anchor` file stays the authoritative reverse lookup.

Because #546 changed the prefix without changing the hash, partitions written by
older teamai (`<safe-basename>-<hash>`) are **adopted, not stranded**: every seam
that resolves "this project's partition" (detection, init, migration) goes through
`resolvePartitionDir`, which computes the anchor's exact legacy name and ATOMICALLY
RENAMES the directory into the current name (same-parent metadata move — no data
copied, an interruption leaves either name intact). A partition that cannot be
renamed (read-only home) keeps serving under its legacy name; an authoritative
current-format partition is never clobbered by a leftover legacy one. `status
--all` never renames (read-only) — it reports a legacy-named partition as
`active (legacy name; renamed automatically on next command)` instead of corrupt.

The rename alone is not enough: `repo.localPath` is stored in config.yaml as an
ABSOLUTE path to the team-repo clone (`<oldPartition>/team-repo`), so adoption
also rebases it onto the new directory — otherwise `pull` would read the team
config from a now-gone path and silently skip the sync (exit 0, "Team config not
found"). The rewrite is idempotent (a modern install's localPath already sits in
the canonical dir and is left untouched; an external clone outside the partition
is left untouched) and self-healing (it finishes an adoption that crashed between
the rename and the config rewrite) — the same `repo.localPath` rebase that
`migrate.ts` applies when moving a legacy `.teamai/` into a partition.

The rewrite is ATOMIC (same-dir temp file + rename, via `writeFileAtomic`). By
this point the legacy source has already been renamed away, so config.yaml is the
partition's only copy; a plain overwrite that failed partway (ENOSPC, EFBIG, a
crash mid-write) would truncate it with no way back. rename(2) is atomic, so a
failed write removes the temp file and leaves the original config.yaml intact —
the next command retries the (idempotent) rebase and converges.

## P0 (this PR) — atomic lock + anchor split

P0 is deliberately **structural**: it establishes the primitive and fixes
discovery, WITHOUT relocating any data. The physical layout
(`<projectRoot>/.teamai/`, `getTeamaiHome()`) is unchanged, and the 61
`resolveBaseDir()` call sites are untouched — their divergence from the data home
is a P1 concern. This keeps P0 independently reviewable (issue R7).

1. **Atomic locking** — `src/update.ts` `acquireLock()` / `releaseLock()`.
   The old lock was check-then-write (`pathExists` → `writeFile`): two racing
   processes could both observe "no lock" and both succeed, and `releaseLock()`
   unconditionally deleted the file — including a lock another process later
   acquired. Rewritten to:
   - Acquire with an atomic exclusive create: the payload is written to a private
     temp file and hard-linked to the lock name (`link` fails with `EEXIST` like
     `O_CREAT|O_EXCL`), so the lock never exists without its content (#760); a
     filesystem without hard links falls back to `writeFile(path, payload, { flag: 'wx' })`.
     Payload is JSON `{ pid, startedAt, owner }` with a random `owner` token.
   - On `EEXIST`, reclaim only a **stale** lock: one whose owner is provably gone
     (`process.kill(pid,0)` fails with `ESRCH`). The reclaim is **serialized behind an
     atomically-created reclaim sentinel** and finished with an atomic rename-into-place,
     so concurrent reclaimers cannot each end up believing they hold the lock; a live
     holder returns "busy". Anything that cannot name a dead owner is held (#760): a
     lock that cannot be read (`EACCES`), an empty or partly written one (the `wx`
     fallback and older teamai open the file before writing), and a pid owned by another
     user (`EPERM`). A lock that names no owner, or cannot be read, stays until
     removed by hand if a crash left it, and a warning names it. A lock that vanished before it could be read gets one more
     exclusive create instead (a third process may already have re-created it).
   - Migration skips the locks' transient artifacts (`<lock>.<uuid>.tmp`, `.sentinel`
     and its temps, `.new-<uuid>`) along with the locks themselves.
   - `releaseLock()` returns early when this process holds no owner token for the
     path, and otherwise deletes only when the on-disk `owner` still matches the token
     this process recorded — never another process's lock.
   - Back-compatible with legacy plain-integer PID lock files.
   The three call sites (`update.ts`, `bootstrap.ts`, `utils/reports-branch.ts`)
   keep their signatures and all benefit.

2. **Anchor primitive** — `src/utils/git.ts` `resolveAnchors(cwd?)`.
   Returns `{ workspaceRoot, projectAnchor }`, or `null` outside a git repo (callers
   fall back to cwd-based behavior).

3. **Subdirectory / worktree-aware discovery** — `src/config.ts`
   `detectProjectConfig()`. When the cwd has no `.teamai/config.yaml`, it retries at
   the git `workspaceRoot`, so teamai runs from any subdirectory and resolves a
   worktree's `projectRoot` to that worktree.

4. **Semantics** — `resolveBaseDir()` (`src/types.ts`) documented to return the
   *workspace root*; behavior unchanged.

### P0 acceptance (verified end-to-end with the real CLI)

- Concurrent `acquireLock` on one path → exactly one winner; stale locks reclaimed;
  non-owner release is a no-op (`src/__tests__/lock-atomic.test.ts`).
- `resolveAnchors` on a real repo + real `git worktree add`: shared anchor, distinct
  workspace (`src/__tests__/anchors.test.ts`).
- Real CLI: `status`/`pull` from a nested subdirectory detect **project** scope and
  deploy to the repo root; run inside a worktree, resources land in the worktree and
  the main checkout is untouched (`src/__tests__/detect-subdir.test.ts` + manual run).

## P1-3 — automatic migration (implemented)

An install created before partitioning keeps its machine data in the business repo
at `<workspaceRoot>/.teamai/`. P1-2 routed NEW installs to the partition and reads
old installs through a legacy fallback; P1-3 moves a real legacy `.teamai/` INTO the
partition on the next write command, so the workspace ends up with zero residue.

**Trigger** (`src/migrate.ts`, wired into the global `preAction` hook in `index.ts`):
- Only `init` / `pull` / `push`. Read-only commands (`status`, `recall`, …) keep using
  the double-read fallback and never move data.
- `hook-dispatch` is excluded outright (via `TEAMAI_HOOK_SUBCOMMANDS`): it is a
  high-frequency silent path and must never move 12 MB.
- `--dry-run` (the existing global flag) previews without writing.

**Gate** (`planMigration`, deliberately NOT `detectProjectConfig` — that
short-circuits on an existing partition and runs the self-heal bootstrap as a side
effect, both of which would mask the raw legacy state). Act iff:
- in a git repo (the partition only exists for git repos), AND
- `<workspaceRoot>/.teamai/config.yaml` exists, AND
- the legacy config is `scope: project` (user data never lives under `.teamai/`), AND
- the legacy config is NOT `kind: self` — **self mode is a hard no-op**: its `.teamai/`
  is team knowledge committed to main, and `init --self` already retires any partition,
  so moving it would break "knowledge on main".

The plan's **mode** then depends on the partition: a full copy when
`<partition>/config.yaml` does not exist yet, or **retire-only** when it exists and
detection can read it (a prior run built the partition but was interrupted before
retiring the source — see Interrupt recovery). retire-only never re-copies onto the
authoritative partition; it only cleans up the leftover legacy dir. A partition
`config.yaml` that exists but that detection cannot read (it is empty or cannot be
opened, does not parse, does not validate, or is not `scope: project`) plans nothing:
the legacy dir holds the only config that still loads, so it stays in place (a warning
names the file) until the member fixes the partition file, and the next write command
then gets the retire-only cleanup. A partition dir with no `config.yaml` at all (say,
one moved aside by hand) plans nothing either, with a warning: the full copy replaces
the whole dir, so it would take that dir's data with it. The full copy's re-check under
the lock in `runMigration` applies the same rules, warning included.

**Steps** (`runMigration`) — copy → verify → atomic rename, so an interruption never
leaves data half-in-both-places:

```
0. Acquire <legacyDir>/.sync-lock (the exact lock an un-migrated pull/push contends
   on, since their getDataHome still resolves to the legacy dir pre-migration).
   Contention → skip this attempt (idempotent; the next write command retries).
1. Copy legacyDir → <partition>.staging  (raw fse.copy, NOT copyDir — copyDir filters
   out `.git` and would corrupt the team-repo clone). Skip reports-wt/learnings-wt/knowledge-wt
   (disposable worktrees with absolute gitdirs — rebuilt on demand) and lock files.
2. Verify staging: config.yaml parses; if the source has team-repo/.git the copy must
   too; every migratable top-level entry is present. Failure → discard staging, abort,
   source untouched.
3. Atomic switch: fse.rename(staging → partition)  (same-filesystem, atomic).
4. Write <partition>/anchor with the projectAnchor path — the slug's readable
   prefix is lossy (path chars folded, length-bounded) and its hash is one-way,
   so this file is the authoritative reverse lookup; it lives off the workspace.
5. Release the lock, then retire the source:
   a. Drop a self-contained `.gitignore` (`*`) INTO legacyDir first. An old
      install's `.teamai/` was often protected only by a repo-root rule matching
      `.teamai/`, which does NOT match `.teamai.bak/` — so without this the rename
      would expose the plaintext env/token to the next `git add`. Written before
      the rename so the credentials are never in a non-ignored directory.
   b. Rename legacyDir → the first FREE `.teamai.bak[.N]` name. An existing backup
      (a prior migration's, or the user's own) is NEVER removed — it may hold
      irreplaceable data — so we pick `.teamai.bak`, else `.teamai.bak.1`, …
   The backup is NEVER auto-deleted: it is the manual rollback path.
```

Interrupt recovery: staging is a separate sibling dir, so a crash before step 3 leaves
the partition absent and the source intact — a rerun discards `.staging/` and starts
clean. A crash between steps 3 and 5 leaves the partition built with the legacy dir
still present; the next write command's `planMigration` sees "readable partition AND
legacy lingers" and returns a **retire-only** plan that finishes the job — it retires
the leftover legacy dir to `.teamai.bak/` WITHOUT re-copying onto the now-authoritative
partition. This closes the gap where the legacy dir (including its plaintext `env`)
would otherwise linger in the workspace forever, breaking the zero-residue guarantee.

The staged team-repo clone is smoke-checked (`git rev-parse HEAD`) before the rename,
so a partial/corrupt copy aborts with the source untouched rather than promoting a
broken clone. If a write command's migration fails, teamai prints a clean error and
exits non-zero (the source is intact, so a rerun retries safely) instead of surfacing
a raw async-hook rejection.

**Downgrade is not supported** — an older teamai treats a partitioned install as
uninitialized; `.teamai.bak/` is the manual rollback. Flag prominently in release notes.

## P2 — self (single-repo) mode slimming (implemented)

Before P2, self mode kept its class-A1 machine data (config, state, env backup,
search index, managed-mcp, the per-worktree resource cache) inside the business
repo at `<repo>/.teamai/`, alongside the class-B team knowledge that is committed
to main. A hand-maintained `.gitignore` blacklist kept `git status` clean — a
fragile arrangement (the per-worktree `workspaces/` tree and the user-scope
`managed-mcp.json` were, in fact, never listed, so a self repo running MCP
reconcile or the local agent leaked them into the working tree).

P2 physically relocates the A1 data to the partition `~/.teamai/projects/<slug>/`,
leaving `.teamai/` with only class-B knowledge. The lever is the same as non-self
installs: attach a partition `dataHome` to the self LocalConfig, and every
`getDataHome()`-based write follows.

**Invariant:** `getKnowledgeDir` / `repo.localPath` stay `<repo>/.teamai` — that is
the class-B knowledge anchor, committed to main, and the ~230 `path.join(localPath,
…)` call sites do not change. `reports-wt/`, `learnings-wt/` and `knowledge-wt/`
stay in the repo too (git worktrees must live in the same repo; they anchor on
`localPath`, not `getDataHome`). Learnings themselves left the default branch in
issue #485: new ones are written to `learnings-wt/` (the `teamai-learnings`
branch) and queued in `pending-learnings/` until they are published, while the
learnings already on main are read from where they are.

- **init** (`initSelfRepo`): resolves the partition up front, attaches it as
  `dataHome`, and writes config/state there. The pre-P2 "retire the stale
  partition" step is gone — self now USES the partition, so there is nothing to
  retire.
- **bootstrap** (teammate fresh clone, `bootstrapSelfRepo`): the "already
  initialized" check and the config write both target the partition (with a legacy
  fallback so a pre-P2 install is still recognized).
- **detection seam** (the delicate part): on a fresh clone the partition config
  does not exist yet, so partition-first misses. The legacy branch runs the
  self-heal bootstrap — which now writes the config into the PARTITION — then reads
  it back FROM the partition (`selfHealAndReadPartition`). A pre-P2 install whose
  config still sits in `<repo>/.teamai` is read via the legacy branch (double-read
  compat) until migration relocates it.
- **migration** (`migrate.ts`, `mode: 'self'`): self CANNOT use the git-mode whole
  directory copy→rename (that would carry the knowledge off and rename `.teamai` to
  `.bak`, breaking "knowledge on main"). Instead it selectively relocates the A1
  whitelist (config.yaml, state.json, env.local, env.sh, search-index.json,
  managed-mcp.json, workspaces/) entry-by-entry, destination-first (copy to the
  partition, then delete the source), leaving class-B knowledge and the worktrees
  untouched and never renaming `.teamai/`. self `repo.localPath` is NOT rebased —
  it must keep pointing at the in-repo knowledge.

Acceptance: after slimming, `git status` is clean (the A1 data is physically gone,
not merely ignored) and a teammate's fresh clone bootstraps into the partition.

## P3 — constant functionization + `status --all` (implemented)

**Functionization.** A handful of top-level path constants were computed once at
module import: `export const TEAMAI_HOME = path.join(getUserHome(), '.teamai')` and
its derivatives (config/state/token/update-lock/session-logs/learnings/votes/
search-index). Because they froze at import, a test that later swapped `HOME` never
saw the new value — so `HOME`-based isolation silently failed (tests worked around
it with `vi.resetModules()` or `vi.mock('../types.js')`). P3 converts them to
call-time getters (`getTeamaiHomeDir()`, `getUserVotesDir()`, `getSessionLogsDir()`,
…), matching the existing `getUserHome()` / `getDataHome()` pattern, so isolation
just works. Seven consts that already had runtime getters and no live consumers
(`TEAMAI_SOURCES_DIR`, `TEAMAI_USAGE_PATH`, `TEAMAI_KNOWN_SKILLS_PATH`,
`TEAMAI_PUSHIGNORE_PATH`, `CONTRIBUTE_SESSIONS_DIR`, `DASHBOARD_EVENTS_DIR/PATH`)
were removed.

**Functionization ≠ project-scoping.** All of these are class-A2 (machine-level):
the getters still return `~/.teamai/...`, unchanged, except
`getUserVotesDir()` (below). The project-scoped equivalents
already route through `getDataHome()`. Skill usage moved there too (#748):
`usage.jsonl` lives in each scope's `getDataHome()`, because one shared file let a
project's report carry every project's skills. The user scope records in
`~/.teamai/user-usage.jsonl`, not that old shared `~/.teamai/usage.jsonl`, which
an earlier release still writes after a rollback; the shared file is never
read. Local votes followed for the same reason (#787): `<dataHome>/votes/`, and
`~/.teamai/user-votes/` (`getUserVotesDir()`) for the user scope, so a scope
pushes only the votes cast where it is set up. The old shared `~/.teamai/votes/`
is never read, and its pending deltas are not pushed. The dashboard stays an A2
singleton: `teamai dashboard`, `session save` and the contribute check read
across scopes; `stats --by-repo` reads only the current scope's events, as the
rest of `stats` does (#795). Each event instead
carries `dataHomeKey`, a hash of the realpath'd `getDataHome()` of the scope the
hook resolved (#785; a hash, so a Copilot event still stores no path), and a
scope's report keeps the sessions whose first keyed event is its own, whole: a
Stop carries the whole transcript's totals, so a session that moved scope (a `cd`
mid-session) is reported once, where it started. A tool's own session ID is one
session whatever ends it records: `claude --resume` continues it, in a new
process, and its Stop carries the whole transcript. A fallback ID (`pid-…`;
Copilot's is the parent PID) names one run up to its `session_end` or
`process_exit`, so a later run that reuses it is decided on its own; a second end with nothing
recorded since the first (the dashboard monitor's `process_exit` after
`SessionEnd`) belongs to the run it closed. A `session_start` on a fallback ID
(`pid-…`) whose `monitorPid` differs from its open run's begins a new run even
though nothing ended that one (a crash with no dashboard running), and that one
counts as the run closed before it; a tool's own
ID is not split this way, since Claude fires SessionStart again on resume, in a
new process, and its Stop carries the whole transcript. The monitor's `process_exit` also
records `processExitAfter`, the last event it observed, and closes only that
run: an exit appended after the next run of the same ID began does not end it,
and one whose run compaction dropped is ignored. A dashboard started before
that field existed writes none. A dead process records nothing more, so such
an exit followed by more events of its fallback ID before the next start did
not end the open run: it belongs to the run closed before it, however late it
was appended. A tool's own session ID is
reported and snapshotted under the ID itself, as before, so a session resumed
after compaction dropped its events still reads what its scope reported. The
scope that first reports it also appends the ID and its own data home key to
`~/.teamai/dashboard/session-owners.jsonl` (never a path, #666), and a session
recorded there is that scope's wherever it is resumed later, whatever the log
still holds, so another scope never reports its transcript again; the first
line for an ID wins, and the file grows by one line per such session, like the
snapshots. An earlier release kept only per-scope snapshots, so the file is
first written from them: a tool's own ID is the scope's whose snapshots show it
reported it with the greatest total (prompts, then tokens). They show it when the
shared snapshots (all three) hold none of it, or the scope is past their total:
that release copied the shared file into every scope it ran in, so a copy, even
the only one, shows nothing, and a tie names no owner. When several scopes
reported it (a session that release split per event), the owner's line also
carries the credit of their parts, applied once as its baseline: a part whose
daily entry shows it ended in a Stop holds the transcript's cumulative total, so
the greatest such part counts once, while a part with no Stop counted its own
prompts, which add; interruptions, rejections and tokens, from Stops, take the
greatest, and corrections, counted per prompt, add. Whether a part with no
Stop came before another's cumulative Stop, which already counts it, is read
from the session's transcript when it has one (Claude): it keeps every prompt
in order with the directory it was typed in, so the Stop covers the first
prompts and only the part's prompts after those add. With no transcript to
place them they all add, which undercounts once but never sends a prompt again. The scopes read are the
user scope, every partition, and a project whose data home is in its workspace
that a session still in the log leads to; each report also records the IDs of
its own snapshots that have no owner yet and show it reported them (absent from
the shared snapshot, or past its total there). A session none of these reach
(a project whose data home is in its workspace, with no event left in the log)
is found by its transcript: hooks record `transcriptPath` on UserPromptSubmit,
Stop and SessionEnd (not SessionStart, whose path on a resume from another
project names a file that never exists; never Copilot's), and a Claude
transcript keeps its first `cwd` when resumed elsewhere, as a Codex rollout
keeps its `session_meta` and Copilot's own session log, found by the session ID
without storing its path, its `session.start` context. So a tool's own session
with no owner is the scope's that directory resolves to, when that scope's
snapshots already hold it; else it is decided as before (a fork under a new ID,
a tool whose transcript records no start). A session main split across scopes
per event, whose events are still in the log with each part's `dataHome`, is
credited once with every part reported: for each scope, the shortest prefix of
its events whose metrics reach its snapshot, and the owner's entry is raised,
counter by counter, to at least the metrics of their union (a part may have
reported more time, tokens or costs with no more prompts), so parts counted before
any Stop carried the transcript's total are neither lost nor sent twice.
A Codex session (any Codex variant: `codex`, `codex-internal`, `tcodex`) is kept
per rollout, with or without a token record, and when
its tokens come from a thread-level counter that already spans rollouts (then
no rollout holds tokens of its own, nor does the prior rollout an entry from
before leaves); a rollout's prompts are its Stop's count or
else its submits. A
rollout's counters restart, and compaction drops its events, so its prompt-token
entry holds each rollout's reported prompts, tokens, interruptions, rejections,
corrections, active time and request costs under a hash of the rollout's path,
written with any delta, and whether it failed (an error, an interruption or a
correction). The session's daily request costs sum its rollouts in the log. A
rollout compaction has dropped keeps those totals in the session's prompt-token,
intervention and daily sums (cache tokens from its tokens), and a failed one
keeps the session unsuccessful, so a later rollout is reported in full and does
not turn it into a success. An entry
written before rollouts were kept is one total: an earlier release rewrote every
session in the log on each report, so it covers the rollouts begun by the time
its file was last written, or, earlier, when that report wrote the team stats
file in this scope's reports checkout (after reading the log, before its push;
the snapshot came after the push). That is read before this report writes
anything; a seed keeps the
shared file's time, and `teamai stats`, which only reads, writes no seed). Those still in
the log consume it in order, as far as each had got by that time, what is left is the dropped rollouts', kept as one
prior rollout, and a rollout begun later is new.
Compaction also keeps a session whose tool process is still running, so a run
an exit from a dashboard before `processExitAfter` marked stopped keeps its
start, and its ID. A
fallback run is reported and snapshotted as `<id>@<first event's timestamp>`,
which does not change when compaction drops earlier runs. A snapshot entry keyed
by a bare fallback ID (written before) is the sum of the runs of that ID in the
log at the earlier release's last report, and compaction keeps or drops the
runs of an ID together. So the next time the scope reports, those runs consume
the entry in log order, each taking up to its own totals of what is left; once
the prompt-token entry is used up, the later runs were not reported and count
as new sessions (the interventions and daily snapshots follow the prompt-token
one, since their counts say nothing when they run out). A run keeps its own
success and correction flags, since the sum's are no single run's, so an
adopted run changes no status total. The first run always
takes a share, as the entry means that release reported it. The entry is then
removed, so no later run of that ID reads it. Only an earlier release wrote bare
entries, and a seeded one may be another scope's, so a run whose first event
carries `dataHomeKey` (recorded by this release), and every later run of its ID,
takes none. A session written before that field existed is attributed by its first
`cwd`: to the scope `resolveConfigForDir` resolves that directory to now, the
dispatcher's rule, so a nested clone under a project is not the project's; no
`cwd`, or one removed since, is no scope's. Inside git an event also carries `projectAnchor`, the repo's
main checkout, which all of its worktrees share (#809); a Copilot event, with no
`cwd`, carries none. `stats --by-repo`,
`session save` and the dashboard's Repository filter key a session by the last
anchor it recorded, else by its `cwd`, and the dashboard gives an event to the
project rooted at its anchor, so a worktree counts as its repo, also after it
is removed. A hook whose `cwd` no longer exists (a session that outlives its
worktree) would resolve to the user scope, or be dropped without one, so it
keeps the scope its session last recorded instead (#810): the config at that
event's `projectAnchor` (for a bare repo, at one of its worktrees that still
exists), used only while the key of its `getDataHome()` is still the recorded
`dataHomeKey`. Its events and skill uses stay with the project, and the share
reminder's gate reads the project too. A project config there that
cannot be read records nothing, and with nothing recorded to match the hook
resolves from its `cwd` as before. The recorded scope is read from `events.jsonl`, so it lasts as long
as the session's earlier events do (compaction keeps only active sessions),
and Copilot, whose events record no directory, has none to recover.
The snapshots of what was already reported are per scope
too (#786), because a session ID can recur in another scope (Copilot's fallback
ID is the parent PID):
`<dataHome>/dashboard/reported-*.json`, and `~/.teamai/dashboard/user-reported-*.json`
for the user scope. The first time a scope needs one it seeds it from the shared
`~/.teamai/dashboard/reported-*.json`, so nothing reported before the upgrade is
sent again; after that it reads only its own. That file summed every scope's
runs of an ID, so the runs of the whole log consume it in log order, whichever
scope each belongs to, and the seed keeps the shares of the scope's own runs,
under their run IDs; none goes to a run recorded
with a `dataHome` path: that release already kept per-scope snapshots, so a
shared entry under its ID is another scope's. An unmatched fallback entry is
dropped, so a later reuse of the PID cannot inherit it; a tool's own session ID
is copied whole, as before, so a session resumed after compaction dropped its
events is not sent again. The shared file is no longer
written, except by an earlier release after a rollback, so every scope seeds from
what the machine had reported by then, never from another scope's later report.
The seed holds a session's whole total, so a session still running at the
upgrade goes on from the reported total, as before.

**`anchor` on save.** Previously only migration wrote a partition's `anchor`
reverse-lookup file, so freshly-init'd partitions had none. `saveLocalConfigForScope`
now writes it whenever the config lands in a partition (via the shared
`writeAnchorFile`), so every partition can be resolved back to its project.

**`status --all`.** Extends the existing `status` command with an `--all` flag that
enumerates every partition under `~/.teamai/projects/` and marks each
active / ORPHAN (project path gone → safe to delete) / unknown / corrupt. The
verdict rests **only on the `anchor` file** — the shared project anchor the
partition is keyed by. The config's businessRepoRoot/projectRoot is read purely as
a display fallback: it is a persisted *workspace* path that may point at a linked
worktree, so its disappearance does not prove the shared partition is orphaned. A
partition with no anchor (e.g. one written before anchor-on-save) is therefore
`unknown`, never ORPHAN — we never recommend deleting data we cannot confirm is
dead. teamai never auto-collects orphans (a renamed or deleted project leaves its
partition behind — a `gc` command is explicitly out of scope), so this is how a
user finds partitions safe to `rm -rf` by hand.

### Explicitly out of scope

`teamai migrate` / `gc` / `--revert` commands; cross-project shared team-repo clone.
Downgrade to an older teamai after
P1 migration is not supported (`.teamai.bak/` is the manual rollback path).
