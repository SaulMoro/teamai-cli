# Agent sessions

Maintainer notes on `src/session-flow/`, the code behind `teamai session`. The commands are described in the [Dashboard](../guide/dashboard.md) guide page.

Each rule below spans more than one file. The rule names the code that owns it, so you can read the details there.

## Rules that span files

- **Every target id is derived.** An adapter's `writeSession` gets the id it writes under from `deriveTargetSessionId` in `ids.ts`, never from the source session, even when the source id is a UUID. The key is the target platform, the target workspace, and the source id, for every platform. Claude Code resumes by id across all project directories, so a copy in a second workspace needs its own id. A new adapter calls `deriveTargetSessionId` before it writes anything.
- **One workspace has one spelling.** `deriveTargetSessionId` hashes the native real path of the workspace, so `/tmp/x` and `/private/tmp/x`, or two letter cases on macOS and Windows, name the same target. It refuses a workspace that is not absolute, such as a relative path or an `md5:<hash>` placeholder. Don't hash a workspace through `resolveRealCwd` in `fs.ts`: that one keeps the letter case it was given and decides where files land, not ids.
- **A copy never overwrites.** Every path that writes a session into a tool (`AgentSession.copy` in `agent-session.ts` for `session migrate`, and `session resume`) first calls `existingCopyId`, which looks the target up through the adapter's `existingSessionId`: the derived id across all of the platform's storage (every Codex rollout, archived ones included), then the ids an older TeamAI wrote (`legacyTargetSessionIds` in `ids.ts`) in the target workspace only. A target that exists but does not parse still exists. When one is found, the result is `reused` and nothing is written. When the write fails, the rollback deletes only the derived id, and only in the target workspace: it is the one target this call created. `writeJsonl` writes through a temp file and a rename.
- **Session index lock.** Every write to a team repo archive (`saveSession`: dedup lookup, name choice, file writes, `_index.json` upsert) and every index rebuild (`rebuildIndex`, `rebuildAllIndexes`) runs inside `withSessionIndexLock(repoRoot, fn)`. The async command callers take it; `SyncManager` stays synchronous and never takes it, so it cannot re-enter. The lock file is `~/.teamai/locks/sessions-<hash>.lock`, keyed by the real path of the team repo's `sessions/`. It stays out of the team repo because there the archive commit could stage it and `pull --all`'s directory renames could move it while held. It covers one machine only; two machines writing `_index.json` is #1133.

## Tests

Test ids through an adapter's `writeSession` under a temporary home, as `src/__tests__/session-target-id.test.ts` does. Test copies through `AgentSession.copy`, as the contract suite in `src/__tests__/agent-session-copy.test.ts` does. A new writable platform joins the `WRITABLE` list of both.
