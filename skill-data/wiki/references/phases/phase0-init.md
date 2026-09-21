## Phase 0：初始化

一次性向用户询问以下信息（**同一条消息，不分步骤**）：

1. **项目所有代码仓库路径**（用户把整个项目涉及的所有仓库地址列出来）：
   - 格式：每行一个绝对路径，或逗号分隔
   - 示例：
     ```
     /path/to/api-gateway
     /path/to/order-service
     /path/to/user-service
     /path/to/common-lib
     ```
   - 说明：这是最关键的一步。大型项目的代码散布在多个仓库中，必须**全部提供**才能构建完整的架构认知。遗漏仓库 = 知识库盲区。
2. **项目名称**（用于文档命名，如 "CVM"、"电商平台"）
3. **产品文档来源**（可选，提供则生成 Type-5/6 桥梁文档）：
   - API 文档目录路径
   - 使用限制 / FAQ 文档路径
4. **输出路径**（默认：第一个仓库的父目录下的 `knowledge/`）

**Step 0A：仓库清单整理**

收到用户提供的仓库列表后，构建仓库清单：

```
FOR 每个用户提供的路径:
  1. 验证路径存在且可访问
  2. 检测是否为 git 仓库（是否有 .git 目录）
  3. 检测主要语言（按文件扩展名分布）
  4. 统计代码规模（文件数 + 估算行数）
  5. 记录 git commit SHA + tag

结果写入 _review/repo-manifest.json：
{
  "repos": [
    {
      "path": "/absolute/path/to/repo-a",
      "name": "repo-a",
      "language": "go",
      "files": 320,
      "lines_estimate": 45000,
      "commit": "abc123",
      "tag": "v1.2.0",
      "accessible": true
    },
    ...
  ],
  "total_repos": N,
  "inaccessible": ["path/to/repo-x（权限不足）"]
}
```

展示给用户确认：
```
已识别 {N} 个仓库：
  ✅ repo-a (Go, ~45K 行)
  ✅ repo-b (Python, ~12K 行)
  ✅ repo-c (Go, ~28K 行)
  ❌ repo-x (路径不存在或无法访问)

总计: ~{N}K 行代码，{N} 个仓库
确认无误后回复"继续"，或补充遗漏的仓库。
```

**Step 0B：自动检测主要语言**（按仓库列表汇总，不阻断流程）：
```
检测方法：汇总所有仓库的文件扩展名分布
  .go 文件占比最高         → language: "go"
  .py 文件占比最高         → language: "python"
  .java 文件占比最高       → language: "java"
  .ts/.js 文件占比最高     → language: "typescript"
  .rs 文件占比最高         → language: "rust"
  多语言混合（无明显主导）  → language: "mixed"
备注：language 字段用于接口扫描时选择 grep 模式（详见 Phase K1 Step 5）
```

**Step 0C：记录基准版本**：
```bash
# 对每个仓库分别记录
FOR repo in repos:
  git -C <repo.path> rev-parse HEAD 2>/dev/null
  git -C <repo.path> describe --tags --always 2>/dev/null
```
写入 `_review/metadata.json`：
```json
{
  "project_name": "CVM",
  "scan_time": "<ISO8601>",
  "repos": [
    {"name": "repo-a", "commit": "<sha>", "tag": "<tag>"},
    {"name": "repo-b", "commit": "<sha>", "tag": "<tag>"}
  ]
}
```

**Step 0D：CLI 结构基线（每个代码仓库，推荐）**

在 K1 深读之前，用 TeamAI 提取可证据化的 import/call 结构边（Python/Go/TS 等，`code-ast`）并与 regex 基线合并（`code-heuristic`）：

```bash
# For each repo. Writes <repo>/teamwiki/ (evidence pages + .indices/graph-index.json).
# Existing flags only: --extract [path], optional --project <slug>, optional --incremental.
teamai codebase --extract <repo_abs_path> --project <project_slug>
```

- Output: `teamwiki/evidence/code/<project>/` pages; `teamwiki/.indices/graph-index.json` (structural edges).
- K1/K2/K3 写 `_manifest.json` 的 `edges[]` 时：**优先引用** extract 的 `code-ast` 边 + `evidenceRefs`（`path:line`），Agent 推断标 `INFERRED`/`AMBIGUOUS`。
- After Phase K3, skip any extra graph compile / merge step that is not a `teamai` command. TeamAI does not ship a separate team-wiki CLI. Continue with this skill using `teamai` and the files under this skill directory. No extra plugin is required.

写入初始 progress.json（current_phase: "phase0_done"），进入 **Phase K1**。

---
