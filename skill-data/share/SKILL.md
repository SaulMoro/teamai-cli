---
name: share
description: >-
  Turn a session into a team learning: summarize what was solved, discovered or worked around,
  and publish it to the team knowledge base with `teamai contribute`. Also publishes a reusable
  skill or a knowledge doc on request. 分享 Session 经验到团队知识库。Loaded on demand by the
  teamai discovery stub, and by the friction reminder that ends a session worth sharing.
allowed-tools: Bash(teamai:*), Bash(npx teamai-cli:*)
---

# Contribute — 分享 Session 经验到团队知识库

总结本次 AI 编码 session 中学到的经验，推送到团队知识库。

**文档使用用户本次会话所用的语言撰写**（中文提问 → 中文文档，英文提问 → 英文文档）。
命令、参数、URL、路径和代码标识符保持原样。

## When to Use

- When teamai suggests this session has valuable content worth sharing
- When you've solved a tricky problem and want to document the solution
- When you've discovered a useful workflow or pattern
- After a long session with diverse tool usage

## How It Works

1. **总结**：回顾本次 session 的工具使用、解决的问题、发现的模式
2. **生成文档**：撰写 Markdown 文档（语言同上），涵盖：
   - 任务/问题是什么
   - 关键决策及原因
   - 解决方案、变通方法或发现的模式
   - 哪些工具/skill 特别有用
   - 踩坑点和注意事项
3. **保存临时文件**：写入临时文件
4. **推送到团队**：运行 `teamai contribute --file <path> --title "<title>"`

## Document Template

Copy the template, the frontmatter field table and the tag taxonomy from
`{SKILL_DIR}/references/doc-template.md`. The frontmatter is required: it is what
makes the document searchable.

## Example

```bash
# AI 生成总结文档到 /tmp/session-summary.md 后
teamai contribute --file /tmp/session-summary.md --title "K8s pod 启动超时排查"
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

| File | When to load it |
|---|---|
| `{SKILL_DIR}/references/doc-template.md` | Writing the learning document: template, frontmatter fields, tag taxonomy. |
| `{SKILL_DIR}/references/contribute-member.md` | The user wants to publish a skill, rule or doc they already have, rather than a session summary. |

`teamai skill get share --full` prints this skill with both references appended.
