---
name: wiki
description: >-
  让 AI 真正理解大型代码库：对多仓库、多微服务、迭代多年的项目做架构逆向 + Graph RAG 图谱 + 多语言 AST，
  把海量代码压缩成结构化知识库，每条结论可回溯代码行，每条关系有置信度标注。适用于 10+ 仓库或微服务、
  AI 直接读代码无法全局理解的项目。Triggers: 架构分析, 架构逆向, 代码知识库, code-to-knowledge,
  architecture wiki, large multi-repo codebase. Loaded on demand by the teamai discovery stub.
allowed-tools: Bash(teamai:*), Bash(npx teamai-cli:*), Bash(python3:*)
---

# team-wiki-codebase — 大型代码库 AI 认知工程

> 前置条件：可访问的源码目录（支持多仓库）、Python 3、已安装的 teamai CLI。
> 方法论、子 agent 提示词、模板与脚本随 CLI 一起分发，运行 `teamai skill path wiki` 获取它们的绝对路径；
> 本文中的 `{SKILL_DIR}` 就是该路径。
> Phase 0 结构基线使用 `teamai codebase --extract`。TeamAI does not ship a separate team-wiki CLI. No extra plugin is required.

**解决什么问题**：大型项目（10+ 仓库、数十微服务、迭代多年）让 AI 无法全局理解——上下文窗口装不下所有代码，组件关系散落各处，业务规则隐藏在深层调用链中。直接让 AI 读代码，既慢（海量 token）又不准（缺乏全局视角）。

**怎么解决**：通过架构逆向工程，将海量代码系统化压缩为**结构化、可验证、AI-Native** 的深度知识库——每个结论可回溯到代码行，每条关系有置信度标注，每次更新有增量校验。AI 读知识库而非读源码，用约 **1/50 的 token** 获得全局架构认知。

## 使用方式

用户用自然语言说明模式，或直接说“做代码库知识库”：

```
默认        Standard：单 session 核心路径
--deep      完整 K1~K4 + G1~G9
--update    增量更新已有 knowledge/
continue    从 _review/progress.json 断点继续
```

---

## Agent 架构

| Agent | 文件 | 启动时机 |
|-------|------|---------|
| 知识库文档生成 Agent | `{SKILL_DIR}/references/agents/kb-doc-generator.md` | Phase K2 每批组件 |
| Graph RAG Agent | `{SKILL_DIR}/references/agents/graph-rag-agent.md` | Phase K3 |

**主 Agent 职责**：流程编排、确认点管理、progress.json 维护、质量报告汇总。

---

## 入口判断

**每次激活时必须先执行此判断。**

```
IF 用户输入包含 "--update" 或 "增量更新":
  → Update 模式
ELSE IF 用户输入包含 "continue" 或 "继续":
  → Continue 模式
ELSE:
  → 检查用户指定目录下是否有 _review/progress.json
  IF 存在 → 告知状态，等待"继续上次"或"重新开始"
  ELSE    → Phase 0
```

---

## Continue 模式

```
Step 1：定位 progress.json
Step 2：读取解析，展示恢复摘要
Step 3：根据 current_phase 跳转：
  "phase0_done"              → Phase K1
  "phasek1_waiting_confirm"  → 展示 k1-architecture-map.md，等待确认①
  "phasek1_confirmed"        → Phase K2
  "phasek2_batch_N"          → Phase K2 第 N 批继续（跳过已完成）
  "phasek2_waiting_confirm"  → 等待确认②
  "phasek2_confirmed"        → Phase K3
  "phasek3_done"             → Phase K4
  "phasek4_done"/"completed" → 告知完成，询问是否 --update 或重跑某组件
```

---

## Update 模式（增量更新）

**触发**：用户要求「增量更新」，或在本 skill 中指定 `--update` 模式。
**前提**：已有 completed 状态的 progress.json。

```
Step 1：读取 progress.json，获取 file_hash_cache
Step 2：扫描 project_root，计算各文件当前 SHA256
Step 3：对比 hash，分类：新增 / 修改 / 删除
Step 4：展示变更摘要，等待用户确认：
  ┌────────────────────────────────────┐
  │ 变更摘要                            │
  │ 新增: N 个文件                      │
  │ 修改: N 个文件（含 Aurora.py 等）   │
  │ 删除: N 个文件                      │
  │ 受影响组件: [列表]                  │
  │ 受影响图谱文档: G1/G2/G6/G7        │
  └────────────────────────────────────┘
Step 5：仅重跑受影响范围：
  - Phase K2：重新生成受影响组件的 Type-4 文档（覆盖写入）
  - Phase K3 局部：更新涉及变更组件的图谱文档（G1/G2/G6/G7）
  - Phase K4：重新运行 validate_kb.py
Step 6：更新 file_hash_cache + metadata.json commit SHA
Step 7：组件级 diff（处理新增/删除仓库或组件）
  IF repos 列表与上次不同：
    新增的仓库 → 对新仓库执行完整 K1 扫描，补充到组件清单，生成 Type-4 文档
    删除的仓库 → 对应组件文档顶部加 `⚠️ [DEPRECATED] 此组件对应仓库已移除`
    → 更新 k1-architecture-map.md 的组件清单
    → 更新 G1 矩阵（移除已删除组件的行列，新增新组件行列）
```

---

## progress.json 规范

**路径**：`<output_dir>/../_review/progress.json`

```json
{
  "version": "5",
  "repos": [
    {"name": "repo-a", "path": "/absolute/path/to/repo-a", "language": "go"},
    {"name": "repo-b", "path": "/absolute/path/to/repo-b", "language": "python"}
  ],
  "output_dir": "/absolute/path/to/knowledge",
  "primary_language": "go",
  "project_name": "ProjectName",
  "scan_time": "2026-01-01T10:00:00Z",
  "current_phase": "phasek2_batch_2",
  "confirmed_phases": ["phase0", "phasek1"],

  "service_map": {
    "描述": "Phase K1 Step 3 构建的服务名→仓库映射表",
    "ServiceA": {"repo": "repo-a", "entry": "cmd/serviceA/main.go"},
    "ServiceB": {"repo": "repo-b", "entry": "app/main.py"}
  },

  "kb_progress": {
    "component_total": 12,
    "components_done": ["Aurora", "Frame"],
    "components_pending": ["CCDB", "Dispatcher"],
    "type1_done": false,
    "type2_done": false,
    "type3_done": false,
    "bridge_docs_done": false,
    "graph_rag_done": false
  },

  "accuracy_stats": {
    "total_claims": 0,
    "verified": 0,
    "unverified": 0,
    "ambiguous_relations": 0
  },

  "interface_coverage": {
    "描述": "接口数量对账结果，由 Phase K2 自校验填充",
    "ComponentA": {"type": "HTTP", "scanned": 13, "documented": 0, "gap": 13},
    "ComponentB": {"type": "MQ",   "scanned": 5,  "documented": 0, "gap": 5}
  },

  "consistency_check": {
    "描述": "Phase K3 Step 3 跨文档一致性校验结果",
    "contradictions": 0,
    "missing_refs": 0,
    "g1_deviations": 0,
    "consistency_rate": 0.0
  },

  "e2e_validation": {
    "描述": "Phase K4 Step 4 AI 端到端验证结果",
    "total_questions": 0,
    "correct": 0,
    "partial": 0,
    "incorrect": 0,
    "boundary_ok": 0,
    "boundary_fail": 0,
    "accuracy_rate": 0.0
  },

  "file_hash_cache": {
    "relative/path/to/file.go": "sha256_hex"
  }
}
```

> `accuracy_stats` 在每批 Phase K2 完成后累加，是知识库可信度的全局指标。

---

## 核心原则（准确性优先）

1. **代码为唯一事实来源**：每个结论必须有代码文件:行号 作为证据，无法验证的标 `[UNVERIFIED]`
2. **置信度三态强制**：图谱中每条关系标 `EXTRACTED(1.0)` / `INFERRED(0.6~0.9)` / `AMBIGUOUS(0.1~0.3)`；禁止凭空发明，禁止用 0.5 默认值
3. **两级准确性验证**：Phase K2 每份文档生成后立即自校验；Phase K4 全库质量检验
4. **人在回路两次确认**：架构理解（K①）和组件文档质量（K②）必须人工确认，防止系统性错误扩散
5. **并行生成 + 断点续传**：Type-4 组件文档并行分发（同一消息发出所有 Agent calls）；每批持久化 progress.json
6. **Token 精简**：`Glob → Grep → Read` 三步法，禁止全量目录扫描
7. **诚实审计**：`[UNVERIFIED]` 不得隐藏；质量数字完整展示；不确定用 AMBIGUOUS 不删除
8. **认知边界声明**：知识库 README 必须明确声明覆盖范围和不覆盖范围，让 AI 知道何时应该说"不确定"
9. **跨文档一致性**：Phase K3 强制交叉比对组件间关系描述，矛盾项必须修复后才计入"一致"
10. **端到端可验证**：Phase K4 用标准化问题测试知识库实际回答能力，E2E 准确率目标 ≥ 80%

---

## 阶段流程（按需加载）

每个阶段的完整步骤在独立文件中，轮到该阶段时再加载，不要一次性读完：

| 阶段 | 文件 | 内容 |
|---|---|---|
| Phase 0 | `{SKILL_DIR}/references/phases/phase0-init.md` | 初始化、`teamai codebase --extract` 结构基线、仓库清单 |
| Phase K1 | `{SKILL_DIR}/references/phases/k1-reverse-engineering.md` | 架构逆向与源材料采集、扫描脚本、架构分析报告 |
| Phase K2 | `{SKILL_DIR}/references/phases/k2-documents.md` | 文档生成（分批并行 + 中间质量确认） |
| Phase K3 | `{SKILL_DIR}/references/phases/k3-ai-native.md` | AI-Native 增强 + Graph RAG 图谱文档集 |
| Phase K4 | `{SKILL_DIR}/references/phases/k4-quality.md` | 质量评估、校验脚本、质量报告 |

方法论背景（可选，写文档时参考）：`{SKILL_DIR}/references/methodology/`；
子 agent 提示词：`{SKILL_DIR}/references/agents/`；
知识库 README 模板：`{SKILL_DIR}/references/templates/project-overview.md`。

人类可读概览（非执行用）：`{SKILL_DIR}/references/overview.md`。

`teamai skill get wiki --full` 一次性打印全部参考文件（约 100 KB），仅在需要通读时使用。

## 输出目录结构

```
<output_dir>/
├── README.md                           ← 知识库索引 + 检索路由规则 + 认知边界声明（AI 专用）
│                                         起手用模板：cp {SKILL_DIR}/references/templates/project-overview.md <output_dir>/README.md
├── {项目名} 技术架构.md                ← [Type-1] 架构总览（目标 ≤80KB，超过则自动拆分）
├── {项目名} 技术架构-核心链路.md       ← [Type-1b] 仅当 Type-1 超 80KB 时拆出
├── {项目名} 技术架构-AI元数据.md       ← [Type-1c] 仅当 Type-1 超 80KB 时拆出
├── {项目名} 业务架构.md                ← [Type-2] 产品能力 + 生命周期 ~70KB
├── {项目名} 部署架构.md                ← [Type-3] 部署拓扑 ~40KB
├── XX_{组件名}设计说明.md × N          ← [Type-4] 每份 20~100KB
├── XX_{项目名}核心API产品代码映射.md    ← [Type-5] 仅有产品文档时生成
├── XX_{项目名}产品规则速查表.md         ← [Type-6]
├── XX_{项目名}业务开发规范SOP.md       ← [Type-7]
├── {知识增强文档} × N                  ← [Type-8] 反模式/RPC契约/排障/知识文库
└── graph/                              ← [Type-9] Graph RAG 图谱文档集
    ├── README.md                       ← 图谱索引 + 按问题类型查找
    ├── G1_{项目名}组件依赖关系矩阵.md
    ├── G2_{项目名}组件调用链路全景.md
    ├── G3_{项目名}数据流与存储依赖图.md
    ├── G4_{项目名}错误码组件映射表.md
    ├── G5_{项目名}跨组件交互场景手册.md
    ├── G6_{项目名}知识图谱三元组.md
    ├── G7_{项目名}架构风险与影响面分析.md
    ├── G8_{项目名}核心配置参数索引.md
    └── G9_{项目名}业务规则约束矩阵.md

_review/                                ← 过程文件（不入知识库）
├── progress.json                       ← 断点续传 + 增量更新状态
├── metadata.json                       ← 代码基准版本
├── interface-inventory.json            ← 接口扫描基准（Phase K1 Step 5）
├── k1-architecture-map.md              ← 架构逆向结果（用户确认过）
├── k2-doc-list.md                      ← 文档清单 + 准确性统计
├── k3-consistency-check.md             ← 跨文档一致性校验报告（Phase K3 Step 3）
└── k4-quality-report.md                ← 质量报告（含 E2E 验证结果）
```

---

## 阶段间控制

| 用户回复 | 行为 |
|---------|------|
| "继续" / "continue" / "ok" | 进入下一阶段 |
| "停止" / "stop" | 停止，已生成文件保持可用 |
| 直接描述问题 | 调整后重新确认，再继续 |
| 直接编辑文件后回复"继续" | 以修改后文件内容为准继续 |

---

## 约束

- **主 Agent 不执行代码分析**：全部由专职 Agent 完成；启动前必须先 Read 对应 agent 文件
- **严禁冗余输出**：生成文件直接 Write，禁止先在对话中打印完整内容
- **组件文档命名**：`XX_{组件名}设计说明.md`（XX 为两位数编号，按依赖链顺序分配，底层组件编号小）
- **无产品文档时**：Type-5/6 可跳过或将约束值标注为 `[PRODUCT_DOC_MISSING]`，不得推测
- **并行模式**：Type-4 批次必须同一消息并发发出所有 Agent calls；串行批次顺序执行

### 诚实审计规则（Honesty Rules）

- **禁止凭空发明**：图谱每条关系必须有组件文档明确依据，不得基于名称猜测
- **置信度不得伪造**：EXTRACTED=1.0，INFERRED 按证据强度 0.4~0.9，AMBIGUOUS 0.1~0.3；禁用 0.5 默认值
- **[UNVERIFIED] 不得隐藏**：超过 20% 则文档顶部加可见警告
- **质量数字完整展示**：validate_kb.py 输出不得只展示通过项
- **token 成本透明**：每批完成后展示读取文件数和估计 token 消耗
- **不确定优先 AMBIGUOUS**：宁可标注待确认，也不删除或假装确定

---

## 与 TeamAI CLI 的配合（必读）

| 阶段 | 命令 / 路径 |
|------|-------------|
| Phase 0 结构基线 | `teamai codebase --extract <repo> --project <slug>`（writes `<repo>/teamwiki/`） |
| Deep knowledge | Use `teamai codebase --deep-enrich --project <slug> --output <repo>` after extract has written `teamwiki/evidence/code/<slug>/`. `--output` is the repository root, not the `teamwiki/` directory. Prefix with `teamai --dry-run` to preview without writing. TeamAI does not ship a separate team-wiki CLI. No extra plugin is required. |
| K3 后编译进 wiki | Skip. TeamAI does not ship a separate team-wiki CLI. Continue with this skill using `teamai` and the files under this skill directory. No extra plugin is required. |
| 产品文档入图 | Skip. Same English note as above. |
| 产品↔代码桥接 | Use `teamai codebase --reconcile --output <repo>` after product pages and extracted code pages are under `<repo>/teamwiki/`. Prefix with `teamai --dry-run` to preview without updating the graph. |
| 一键刷新 | Use `teamai codebase --extract <repo> --project <slug> --incremental`, reusing the Phase 0 repository path and project slug even when running from another directory. Do not look for another CLI. |
| 质量评估 | Use `python3 {SKILL_DIR}/scripts/validate_kb.py <output_dir>` and `teamai codebase --lint --output <repo>` to check `<repo>/teamwiki/` (`--output` takes the repository root, not the `teamwiki/` directory). Skip any extra evaluate binary. |

**路径约定**：`{SKILL_DIR}` 是 `teamai skill path wiki` 打印的目录，方法论在 `{SKILL_DIR}/references/methodology/`，子 agent 提示词在 `{SKILL_DIR}/references/agents/`，脚本在 `{SKILL_DIR}/scripts/`。

所有流程在 `teamai skill get wiki` 提供的内容与 `teamai` CLI 内完成。No extra plugin is required.
