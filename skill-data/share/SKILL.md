---
name: share
description: >-
  Turn a session into a team learning: summarize what was solved, discovered or worked around,
  and publish it to the team knowledge base with `teamai contribute`. Also publishes a reusable
  skill or a knowledge doc on request. Loaded on demand by the teamai discovery stub, and by
  the friction reminder that ends a session worth sharing.
allowed-tools: Bash(teamai:*), Bash(npx teamai-cli:*)
---

# Contribute — share what a session taught you with the team

Summarize what this AI coding session taught you and push it to the team knowledge base.

**Write the document in the language the user used in this session** (a Chinese conversation
gets a Chinese document, an English one an English document). Commands, flags, URLs, paths and
code identifiers stay as they are.

## When to Use

- When teamai suggests this session has valuable content worth sharing
- When you've solved a tricky problem and want to document the solution
- When you've discovered a useful workflow or pattern
- After a long session with diverse tool usage

## How It Works

1. **Summarize**: review the tools used, the problems solved and the patterns found in this session
2. **Write the document**: a Markdown document (language as above) covering:
   - What the task or problem was
   - The key decisions and why they were made
   - The solution, workaround or pattern discovered
   - Which tools or skills proved especially useful
   - Pitfalls and things to watch out for
3. **Save it**: write the document to a temporary file
4. **Push it to the team**: run `teamai contribute --file <path> --title "<title>"`

## Document Template

Copy the template, the frontmatter field table and the tag taxonomy from
`{SKILL_DIR}/references/doc-template.md`. The frontmatter is required: it is what
makes the document searchable.

## Example

```bash
# After writing the summary to /tmp/session-summary.md
teamai contribute --file /tmp/session-summary.md --title "Debugging K8s pod startup timeouts"
```

## Important

- Run this as a **sub-agent** (Agent tool) to avoid polluting the main session's context
- The document is pushed to the team repo's `teamai-learnings` branch, under `learnings/`, with no pull request
- Team members will see it on their next `teamai pull`
- Keep summaries concise and actionable — this is a knowledge base, not a diary

## Publishing a reusable skill instead

A member asking to publish a skill ("share this xxx skill with my team") is a
different flow: see `{SKILL_DIR}/references/contribute-member.md`. This file is for
turning a *session* into a learning.

## References

In the files below, `{SKILL_DIR}` is the directory `teamai skill path share` prints.

| File | When to load it |
|---|---|
| `{SKILL_DIR}/references/doc-template.md` | Writing the learning document: template, frontmatter fields, tag taxonomy. |
| `{SKILL_DIR}/references/contribute-member.md` | The user wants to publish a skill, rule or doc they already have, rather than a session summary. |

`teamai skill get share --full` prints this skill with both references appended.
