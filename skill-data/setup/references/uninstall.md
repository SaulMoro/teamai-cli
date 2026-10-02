# Scenario: Uninstall — remove TeamAI from this machine

The user wants to remove TeamAI. **You run the command for them** — they should not
have to type `teamai uninstall` themselves. Everything you say goes in the user's
language (global rule 1); only the commands stay verbatim.

## Step 1 — Confirm scope first (ASK — this is destructive)

Uninstalling removes hooks and synced resources from the machine and cannot be
undone with a single button, so confirm before running anything. Ask ONE question:

*"Do you want to remove TeamAI from **just this AI tool**, or from the **whole
machine** (all tools)?"*

- **Just this tool** → `--agent <tool>` (use the tool this conversation runs in,
  e.g. `claude`). Shared resources are removed only if it is the last tool using
  them. An instructions file several tools read (CodeBuddy and WorkBuddy share
  `.codebuddy/rules/teamai-context.md`) is cleaned block by block: a teamai
  block stays while a remaining tool on that file still writes it, so
  `--agent workbuddy` keeps that file while CodeBuddy is installed. A file an
  earlier release wrote the blocks to, such as the project `AGENTS.md`, loses
  its teamai blocks, since no tool reads them there now. A file teamai created
  goes with its last block; one the user had before stays, even if empty.
- **Whole machine** → no `--agent` flag.

Reassure them (in their language): *"This only removes things from your computer.
Your team's repo on the website is untouched — you can rejoin any time with
`/teamai` and the repo URL."*

## Step 2 — Run it (you run it)

Whole machine:

```bash
teamai uninstall
```

Just the current tool (example for Claude Code):

```bash
teamai uninstall --agent claude
```

`teamai uninstall` asks for a confirmation of its own. Let the user answer that
prompt. Only add `--force` (skips the prompt) if the user has already clearly told
you to go ahead without further confirmation:

```bash
teamai uninstall --force
```

## Step 3 — Report the result in the user's language

Tell them what was removed and remind them, in one line, how to come back:
*"Done — TeamAI has been removed from this machine. To rejoin later, run `/teamai`
and give it your team repo URL."*

## Notes

- Uninstall cleans legacy Codex rule copies at the recorded `toolRoots`
  location, including publishers' bare local filenames. It keeps edited copies.
  For a rule the team has
  removed, it deletes the copy only if its hash matches the recorded delivery.
  Without that record, it keeps the copy and names it in a warning. Save any
  changes you need, then delete the copy manually.
- If an OpenCode config entry cannot be removed, repair its config or permissions
  and retry the same uninstall command. Uninstall reports failure and keeps
  its ownership record and shared data directory, even for the last tool.
- Project uninstall keeps the global Pi and Oh My Pi extensions and Hermes
  plugin and config for other projects. User-scope uninstall removes them.
- Do **not** delete the team repo on the Git platform — uninstall never touches it,
  and neither should you.
- If the user only wants to stop auto-sync for one tool but keep TeamAI otherwise,
  that is the `--agent <tool>` form, not a full uninstall.
- In a project, uninstall also takes teamai's lines out of `.git/info/exclude`
  (the `# [teamai:mcp-exclude:start]` block) for MCP configs it proves hold no
  resolved `${VAR}` value. A line names the path a write lands in: for a config
  under a symlinked directory, the link's target (`/config/mcp.json` for
  `.cursor/` linking to `config/`). For one it cannot prove clean (including one written
  under a `toolPaths` mapping since changed, at the built-in location of a tool
  the team dropped or moved that no other tool maps, or in a nested repository's
  linked worktree, that still holds servers, and one written for a tool since moved
  (or at its built-in location) that another tool maps, holding a server that tool
  did not write) it keeps the line
  and warns, naming the file and why: have the user remove teamai's servers from
  that file, then delete the line (with the last one, the block's markers). Do not
  delete a kept line while its file still holds a token.
