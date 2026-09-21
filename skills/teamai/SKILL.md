---
name: teamai
description: >-
  Make every team AI native — TeamAI syncs a team's AI skills, rules, docs and env across AI coding
  tools. Use when the task operates on team-shared AI configuration or team knowledge: setting up a
  team repo, joining one, managing members, syncing with pull or push, or checking team status.
  Also use to build or query a codebase knowledge base for a large multi-repo project (架构分析,
  架构逆向, 代码知识库, code-to-knowledge, architecture wiki), and to share what a session taught you
  back to the team (分享 Session 经验, contribute a learning, share this with my team), including
  after a friction reminder. Triggers include "set up teamai", "join the team repo", "sync team
  skills", "team wiki", "share what I learned", and running /teamai. Talking about a team needs no
  skill; operating on what the team shares does.
allowed-tools: Bash(teamai:*), Bash(npx teamai-cli:*)
---

# teamai

Make every team AI native — one shared foundation for the skills, rules, docs and env a team works with.

Install: `npm i -g teamai-cli` (Node.js >= 20)

## Start here

This file is a discovery stub, not the usage guide. Load the workflow from the CLI before running anything, so the instructions match the installed version:

```bash
teamai skill get core             # daily work: pull, push, status, doctor, command reference
teamai skill get core --full      # adds troubleshooting
```

The CLI serves skill content that always matches the installed version, so instructions never go stale. The content in this stub cannot change between releases, which is why it just points at `skill get`.

## Specialized workflows

```bash
teamai skill get setup            # day 0: create a team repo (admin) or join one (member), manage, uninstall
teamai skill get wiki             # large multi-repo codebase: architecture reverse-engineering and knowledge base
teamai skill get share            # turn what this session taught you into a team learning
```

A friction reminder at the end of a turn means `teamai skill get share`.

`teamai skill list` shows everything the installed version serves. `teamai skill path <name>` prints the directory holding a skill's scripts and templates.
