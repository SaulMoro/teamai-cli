---
name: core
description: >-
  TeamAI daily workflow: route a /teamai request, sync with pull and push, inspect status,
  diagnose with doctor, and reach the specialized workflows. Loaded by the teamai discovery stub.
---

# teamai — daily workflow

You are guiding a user through TeamAI. **They may not know Git.** You run the
commands; they only make choices when you ask. Follow the steps literally —
do not skip, reorder, or invent commands.

## Start here

Look at what the user typed after `/teamai`.

**If they gave NO scenario right after a TeamAI friction reminder** (the
`[teamai]` line that suggests `/teamai share what this session taught me`),
that reminder is the scenario: load `teamai skill get share` and follow it.

**If they gave NO scenario otherwise** (bare `/teamai`, or only greetings/no task):
print the menu below **exactly**, then **STOP and wait**. Take no other action —
do not run any command, do not load another skill yet.

```
teamai — Team AI Skills & Rules Sync

Usage examples (copy one to get started):

  🏗️  Admin — set up a new team repo:
      /teamai Help me set up TeamAI for my team from scratch

  🤝  Member — join an existing team:
      /teamai Help me join my team's TeamAI, repo URL is https://...

  🔧  Admin — daily management (publish & update skills, rules, MCP, env):
      /teamai I already have TeamAI set up, help me manage it

  📊  Anyone — open the team dashboard:
      /teamai Open the TeamAI dashboard

  💡  Member — share a skill with the team (just ask in plain language):
      /teamai Share this <skill-name> skill with my team

  🗑️  Anyone — remove TeamAI from this machine:
      /teamai Uninstall TeamAI
```

**If they DID describe a scenario**, match it to one row and follow what it loads.

| The user wants to…                                                    | Load this                                      |
|-----------------------------------------------------------------------|------------------------------------------------|
| Set up a team from scratch, join a team, manage one, or uninstall      | `teamai skill get setup`                       |
| Publish a skill, rule or doc they already have                         | `{SKILL_DIR}/references/contribute-member.md`  |
| Share what this session taught them                                    | `teamai skill get share`                       |
| Understand a large multi-repo codebase, build an architecture wiki     | `teamai skill get wiki`                        |
| Sync now, see differences, diagnose                                    | `teamai pull` · `teamai status` · `teamai doctor` |
| Open the team dashboard                                                | `teamai dashboard` — it starts a local server (default port 3721); give the user the URL |
| Something broke                                                        | `{SKILL_DIR}/references/troubleshooting.md`    |

If the request is ambiguous (e.g. "help me with teamai" with no direction),
ask ONE short question to pick a row, then proceed.

Sharing a session's learnings needs no menu choice: TeamAI prompts on its own at
the end of a session that produced something worth sharing, and that prompt means
`teamai skill get share`. (Only when recall is on; it is off by default. The team turns it on with
`sharing.recall.enabled: true` in `teamai.yaml`, a member with `teamai recall enable`;
while it is off, or while the teamai config cannot be loaded, `teamai skill get share`
says so and why.)

## Global rules

1. **Reply in the user's language — including every example and hand-off blurb.**
   Answer in whatever language the user used, for the whole conversation. This
   applies to **everything you write**: the invite line you give an admin to
   forward, the one-line explanations, the "what's next" summary — all of it is
   translated before you show it. *Only* commands, flags, URLs, file paths and
   code identifiers stay verbatim (never translate `teamai pull`, `--scope user`,
   `/teamai`, a repo URL).
2. **Never teach Git.** Do not mention branches, commits, clone, or push/pull of
   Git itself. TeamAI hides all of that. The user thinks in terms of "my team's
   skills", not repositories.
3. **You run the commands.** Only pause to ask the user when you need a web login,
   a value only they know, or a genuine either/or choice. Show each command before
   you run it, in one short line.
4. **Detect the current AI tool first.** TeamAI behaves differently per host. Note
   which tool this conversation is running in (Claude Code, Cursor, CodeBuddy,
   WorkBuddy, ChatGPT App, Codex, OpenCode, Kiro, Gemini CLI, …). When you reopen a
   session, use the name of **this** tool — do not assume Claude Code or Cursor.
   Some hosts need extra manual steps for hooks — see the troubleshooting
   reference ("Agent-specific caveats").

## Daily commands

```bash
teamai pull        # Sync team resources into local AI tools now
teamai push        # Publish your local skills/rules/docs to the team
teamai status      # Show local vs team differences
teamai doctor      # Diagnose configuration and hook problems
teamai list        # List resources (skills|rules|docs|env|agents|hooks|mcp)
teamai recall <q>  # Search what the team has already learned
```

Every other command, every flag, and the flags `--help` hides live in the
generated reference below. Read it instead of guessing a flag.

`teamai pull` mirrors the non-hidden docs you receive into `sharing.docs.localDir`,
removing stale and local-only documents; an edited doc of a docs namespace you left
is kept and named. Use a dedicated directory; preview with `--dry-run`.

`teamai pull` keeps a skill, rule or agent copy the user changed since teamai
delivered it, `--force` included, and names it (`Kept <path>: ...`). To share
the change, `teamai push`; when pull or push says the team version has changed
since, merge that change into the copy first, or the push replaces it. To take the team version instead, delete
the copy and run `teamai pull --force`. The first pull after upgrading, and a
new worktree's first pull, still overwrite: nothing is recorded yet.

A team agent (`agents/<name>.yaml`) can set `model: strong`, `model: fast`, or an
alias the team defines, instead of one tool's model. The team maps each alias per
tool in `models/aliases.yaml`, in that tool's own model value, with an optional effort:

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex:  { model: gpt-6-sol, effort: high }
```

`teamai pull` writes the mapped model into each tool's agent file, with the effort
in that tool's own field: `effort` for the Claude family, CodeBuddy, Qoder and Qoder CN,
`model_reasoning_effort` for the Codex family, `variant` for OpenCode. Cursor takes
effort inside its model string (`claude-opus-5[effort=high]`); Copilot, Kiro, WorkBuddy,
JoyCode, ZCode and OMP take none, and pull warns and drops an effort mapped for them.
Qoder CN uses the `qoder` entry; only the Claude and Codex variants and Qoder CN inherit
an entry, so never expect a `claude` model in Qoder or ZCode. A tool the alias does
not map gets no `model` and uses its default; a concrete model such as `opus` is
written as is; `tool_extras.<tool>.model` pins one tool and skips the alias. Suggest
YAML agents: a legacy `agents/<name>.md` is copied as is, so its alias is not resolved.

## References

In the files below, `{SKILL_DIR}` is the directory `teamai skill path core` prints; a reference file you open on its own writes that directory as `SKILL_DIR` in braces.

| File | When to load it |
|---|---|
| `{SKILL_DIR}/references/commands.md` | Before using any command not in the daily list, or any flag. Generated from the CLI's own command table, so it cannot drift. |
| `{SKILL_DIR}/references/troubleshooting.md` | A command fails, a hook does not fire, or a host needs manual steps. |
| `{SKILL_DIR}/references/contribute-member.md` | A member wants to publish a skill, rule or doc they already have. Any member can, not just admins. |

`teamai skill get core --full` prints this skill with all three references
appended. Load a single file above when you only need one.
