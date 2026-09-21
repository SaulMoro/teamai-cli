---
name: setup
description: >-
  TeamAI day 0 and repo lifecycle: create a team repo as admin, join an existing team as a member,
  manage members, roles, MCP and env, and uninstall. Loaded on demand by the teamai discovery stub.
allowed-tools: Bash(teamai:*), Bash(npx teamai-cli:*)
---

# teamai — setup and lifecycle

You run the commands; the user only makes choices when you ask. **They may not
know Git** — never explain branches, commits or clones.

## Before anything

```bash
node --version      # must be >= 20
teamai --version    # install once with: npm install -g teamai-cli
```

Then pick the flow. A user **setting up a new team** becomes its admin and creates
the repo; a user **joining an existing team** needs a repo URL from their admin. A
would-be member without a URL is still the **join** flow — `join-member.md` tells
them how to ask for it. Do not send them to the create-repo flow because the URL
is missing.

| The user wants to…                                                          | Load this                                   |
|-----------------------------------------------------------------------------|---------------------------------------------|
| Set up TeamAI for a team from scratch (create the repo)                      | `{SKILL_DIR}/references/setup-admin.md`     |
| Join their team, with or without a repo URL                                  | `{SKILL_DIR}/references/join-member.md`     |
| Publish or update skills, rules, MCP, env; invite members; manage roles      | `{SKILL_DIR}/references/manage-admin.md`    |
| Remove TeamAI from this machine                                              | `{SKILL_DIR}/references/uninstall.md`       |
| Publish one skill or contribute a doc                                        | `teamai skill get share`                    |
| Anything that breaks along the way                                           | `teamai skill get core --full` (troubleshooting) |

Supported Git providers are Tencent TGit (工蜂), GitHub, GitLab and CNB;
`setup-admin.md` carries the detection probe, the sign-in and create-repo URLs,
and the per-provider caveats.

## Rules for these flows

1. **Always use a full URL** for the team repo (e.g.
   `https://github.com/yourorg/yourrepo`). Never the `owner/repo` short form.
2. **Don't limit which AI tools get set up — cover all of them by default.**
   Unless the user names specific tools, do **not** pass `--agent` to restrict the
   install. Let `teamai init` set up every AI tool already installed (omitting
   `--agent` gives an interactive picker; select all detected tools). **After init,
   report which agents were set up** — in the user's language, which tools now
   auto-start TeamAI, and which detected tools were skipped and why (e.g. Codex
   trust-gate, CodeBuddy design). Verify the real per-tool result with
   `teamai doctor` and `teamai hooks list`.
3. **After init, resources appear on the NEXT session.** `teamai init` injects a
   session-start hook that auto-runs `teamai pull`. Empty skills/rules directories
   right after init are normal; they fill in when the user opens a fresh session in
   this tool. To sync immediately, run `teamai pull`.
4. **Finish with `teamai doctor`.** Every setup or onboarding flow ends by running
   it and resolving what it reports before you call the job done.

Every command and flag, including the ones `--help` hides, is listed in
`teamai skill get core --full` under `references/commands.md`. Do not guess a flag:
there is no member-invite flag, for instance — inviting happens on the Git
platform's website, as `manage-admin.md` describes.

## References

| File | When to load it |
|---|---|
| `{SKILL_DIR}/references/setup-admin.md` | Creating a team repo: provider detection, auth, repo creation, first push. |
| `{SKILL_DIR}/references/join-member.md` | Joining an existing team from a repo URL. |
| `{SKILL_DIR}/references/manage-admin.md` | Day-to-day admin: publishing resources, roles, projects, MCP, env, members. |
| `{SKILL_DIR}/references/uninstall.md` | Removing TeamAI from a machine or from one agent. |

`teamai skill get setup --full` prints this skill with all four appended (about 31 KB).
