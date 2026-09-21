## Phase K3：AI-Native 增强 + 图谱文档集

**方法论**：`{SKILL_DIR}/references/methodology/phase3-ai-enhancement.md`

### Step 1：AI-Native 元素注入

对所有已生成文档补充（如 Phase K2 的 Agent 未完整添加）：

| 元素 | 要求 | 适用范围 |
|------|------|---------|
| `search-anchor` | 5~15 个关键词，标题后第一行 | 所有文档 |
| AI 快速理解表 | 10 维度，紧跟标题 | 所有 Type-4 组件文档 |
| 双向链接 | 组件↔主架构，桥梁↔组件 | 所有文档 |
| 检索路由规则 | 4条分流规则 + 4级优先级 | 仅技术架构总览 |
| QA 对 | 10~20 个高频问题+答案引用 | 仅技术架构总览第9章 |

### Step 2：Graph RAG 图谱文档集

读取 `{SKILL_DIR}/references/agents/graph-rag-agent.md`，拼装输入包并启动：

```
all_kb_docs_dir:  <output_dir>
architecture_map: _review/k1-architecture-map.md
doc_list:         _review/k2-doc-list.md
project_name:     <Phase 0>
output_dir:       <output_dir>/graph/
methodology_file: {SKILL_DIR}/references/methodology/phase2-document-types.md
```

生成 G1~G9（每条关系强制置信度三态标注）：

| 图谱文档 | 解决的问题 | 置信度要求 |
|---------|---------|-----------|
| G1 组件依赖关系矩阵 | "谁依赖 X？" | EXTRACTED 来自文档明确描述 |
| G2 调用链路全景 + 状态机 + 约束矩阵 | "API 经过哪些模块？" | 调用链 EXTRACTED，推断依赖 INFERRED |
| G3 数据流与存储依赖图 | "数据存哪里？" | 读写关系 EXTRACTED |
| G4 错误码组件映射表 | "错误码是哪个模块的？" | EXTRACTED |
| G5 跨组件交互场景手册（≥10个时序图） | "配额检查怎么做？" | 时序 EXTRACTED，边界 INFERRED |
| G6 知识图谱三元组（≥100条） | "A 间接依赖谁？" | 每条标 E/I/A + 分值 |
| G7 架构风险与影响面分析 | "X 挂了影响多大？" | 直接依赖 EXTRACTED，间接 INFERRED |
| G8 核心配置参数索引 | "怎么改 XX 配置？" | EXTRACTED 来自配置文件 |
| G9 业务规则约束矩阵 + AI 推理决策树 | "能不能做 XX？" | 规则 EXTRACTED，推断 INFERRED |

同时生成 `<output_dir>/graph/README.md`（索引 + 按问题类型查找表 + 检索路由建议）。

### Step 3：跨文档一致性校验

**Graph RAG Agent 完成后，主 Agent 自行执行此步骤（不委托给子 Agent）。**

目的：检测组件文档之间的矛盾描述，防止"A 说调用 B 用 RPC，B 说被 A 用 MQ 调用"这类不一致。

```
Step 3A：构建"声称矩阵"

  对每份 Type-4 组件文档，从**两个层面**提取关系声称：
  
  层面1：AI 快速理解表中的"上游组件"和"下游组件"字段
  层面2：正文中的接口设计章节、核心流程章节中的调用描述
  
  如果层面1和层面2对同一关系描述不一致 → 首先记录为"文档内矛盾"（比表头和正文优先级更高的问题）
  
  提取示例：
    组件X.md 表头声称: X→Y(RPC), X→Z(MQ)
    组件X.md 正文声称: X→Z(HTTP)  ← 与表头矛盾！
    组件Y.md 表头声称: Y←X(RPC), Y→Z(DB)
    组件Z.md 表头声称: Z←X(HTTP), Z←Y(DB)

Step 3B：交叉比对

  FOR 每对组件 (A, B):
    IF A.md 声称 "A→B 用 RPC" AND B.md 声称 "B←A 用 MQ":
      → 记录矛盾: "A→B 通信方式不一致: A说RPC, B说MQ"
    IF A.md 声称 "A→B" BUT B.md 未提到 "被A调用":
      → 记录缺失: "A声称调用B，但B的文档未提及被A调用"
    IF G1矩阵中的关系 与 组件文档声称不一致:
      → 记录偏差: "G1矩阵说A→B(RPC)，但A的文档说A→B(MQ)"

Step 3C：生成一致性报告

  写入 `_review/k3-consistency-check.md`：

  ```markdown
  # 跨文档一致性校验报告

  ## 矛盾项（必须修复）
  | 组件A | 组件B | A的描述 | B的描述 | 矛盾类型 |
  |-------|-------|---------|---------|---------|
  | X | Z | X→Z(MQ) | Z←X(HTTP) | 通信方式不一致 |

  ## 缺失项（建议补充）
  | 声称方 | 被引用方 | 声称内容 | 缺失 |
  |--------|---------|---------|------|
  | A | B | A→B(RPC) | B的文档未提及被A调用 |

  ## G1矩阵偏差（建议对齐）
  | G1矩阵 | 组件文档 | 偏差 |

  ## 统计
  - 矛盾项: N 处（❌ 需修复）
  - 缺失项: N 处（⚠️ 建议补充）
  - G1偏差: N 处（⚠️ 需对齐）
  - 一致关系: N 条（✅）
  - 一致率: X%
  ```

Step 3D：自动修复（仅限明确情况）

  IF 矛盾项 > 0:
    FOR 每个矛盾项:
      回溯代码验证：用 Grep 查找实际的调用方式（如 rpc.Call / mq.Publish）
      IF 能明确正确方 → 修复错误方文档中的描述 + 更新 G1 矩阵
      IF 无法明确 → 标记为 AMBIGUOUS，留待用户在确认点确认
    修复后重新统计一致率

  IF 矛盾项 = 0:
    → 跳过修复，直接进入 Phase K4
```

**完成后**：更新 `current_phase` 为 `"phasek3_done"` → Phase K4。

---
