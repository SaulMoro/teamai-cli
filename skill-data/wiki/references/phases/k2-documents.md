## Phase K2：文档生成（分批并行 + 中间质量确认）

**方法论**：`{SKILL_DIR}/references/methodology/phase2-document-types.md`

### 生成顺序（依赖链驱动，底层先写）

```
批次1: 数据层 + 基础执行层 Type-4 组件文档    ← 并行
批次2: 资源/调度层 Type-4 组件文档            ← 并行
批次3: 消息/服务层 Type-4 组件文档            ← 并行
批次4: API入口层 Type-4 组件文档              ← 并行
           ⛔ 确认点② ← 人工抽查组件文档质量
批次5: 架构总览层 (Type-1 + Type-2 + Type-3) ← 串行（依赖上层全部完成）
批次6: 桥梁文档 (Type-5 + Type-6 + Type-7)   ← 串行（依赖产品文档）
批次7: 知识增强 (Type-8: 反模式/RPC契约/排障) ← 串行
```

### 每批执行流程

读取 `{SKILL_DIR}/references/agents/kb-doc-generator.md`，拼装输入包并启动：

```
component_list:    本批次组件/文档类型列表
architecture_map:  _review/k1-architecture-map.md 完整内容
repos:             _review/repo-manifest.json 中的仓库列表
service_map:       progress.json 中的 service_map
output_dir:        <Phase 0>
project_name:      <Phase 0>
product_docs_dir:  <Phase 0，可为空>
methodology_dir:   {SKILL_DIR}/references/methodology/
completed_docs:    kb_progress.components_done（断点恢复跳过）
parallel_mode:     true（批次1~4）/ false（批次5~7）
```

每批完成后：
- 将完成组件追加到 `kb_progress.components_done`
- 累加 `accuracy_stats`（从 Agent 返回的自校验摘要中提取）
- 更新 `current_phase` 为 `"phasek2_batch_N"`
- 展示本批次 token 消耗和 `[UNVERIFIED]` 统计

### ⛔ 确认点②（批次1~4完成后）

展示给用户：
```
已生成 {N} 份组件设计文档。准确性统计：
  总声明数: {N} | 已验证: {N} | [UNVERIFIED]: {N}（{X}%）
  AMBIGUOUS 关系: {N} 条

请抽查 2~3 份文档（建议选最复杂的组件）：
  路径：<output_dir>/XX_<组件名>设计说明.md

确认要点：
  1. AI 快速理解表的代码入口是否精确到函数名？
  2. 核心流程描述是否与代码实际一致？
  3. [UNVERIFIED] 比例是否可接受？（建议 <15%）

如发现系统性问题，请描述，我将调整策略后重新生成。
```

更新 `current_phase` 为 `"phasek2_waiting_confirm"`。
用户确认后更新为 `"phasek2_confirmed"`，继续批次5~7。

### 全部批次完成后

写入 `_review/k2-doc-list.md`（文档清单：路径 + 规模KB + [UNVERIFIED]数 + 生成时间）。
更新 `current_phase` 为 `"phasek2_done"` → Phase K3。

---
