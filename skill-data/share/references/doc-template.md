# Learning document template

**【必须】文档必须包含 YAML frontmatter，用于搜索索引和知识发现。**

```markdown
---
title: "<简短标题，描述核心问题或发现>"
author: <username>
date: <YYYY-MM-DD>
tags: [tag1, tag2, tag3]
---

## 背景
在做什么？遇到了什么问题？

## 解决方案
怎么解决的？关键步骤是什么？

## 经验总结
- 经验 1
- 经验 2

## 相关 Skills
- skill-name-1
- skill-name-2
```

### Frontmatter 字段说明

| 字段 | 必须 | 说明 | 示例 |
|------|------|------|------|
| title | ✅ | 简短标题（<60 字符） | "K8s Pod OOM 排查指南" |
| author | ✅ | 贡献者用户名 | jeffyxu |
| date | ✅ | 日期 YYYY-MM-DD | 2026-03-28 |
| tags | ✅ | 2-5 个关键标签 | [k8s, oom, troubleshooting] |

### Tags 选择建议

从以下类别中选择 2-5 个：
- **技术栈**: python, typescript, go, k8s, docker, sglang, cuda
- **问题类型**: troubleshooting, performance, deployment, config, api
- **模式**: workflow, pattern, tool-usage, best-practice
- **场景**: debugging, testing, monitoring, security
