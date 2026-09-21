## Phase K1：架构逆向与源材料采集

**方法论**：`{SKILL_DIR}/references/methodology/phase0-collection.md` + `{SKILL_DIR}/references/methodology/phase1-reverse-engineering.md`

### Step 1：可选运行扫描脚本（推荐）

```bash
python3 {SKILL_DIR}/scripts/scan_repo.py <project_root> --depth 2 --top 10
```
输出：文件统计 + 关键文件发现报告 + 语言分布。

### Step 2：关键文件提取

按优先级扫描（详见 phase0-collection.md）：
- **P0 必须**：入口文件、路由/Handler、流程编排配置、Proto/IDL
- **P1 重要**：数据库 Schema（DDL）、常量/错误码定义
- **P2 增强**：配置文件、测试文件（理解预期行为）

### Step 3：架构逆向（详见 phase1-reverse-engineering.md）

- 自底向上分层：叶子节点(DB/MQ) → 中间节点(编排/调度) → 根节点(API入口)
- 三层穿透追踪：对核心 API ≥5 条完成 API入口→编排层→服务执行层 全链路追踪
- 构建 N×N 组件关系矩阵（标注通信方式：RPC/MQ/DB）

### Step 4：生成架构分析报告

写入 `_review/k1-architecture-map.md`：

```markdown
## 架构分层（≥4层）
| 层级 | 组件列表 | 核心职责 | 代码仓库 |

## 组件清单
| 组件名 | 架构层级 | **所属仓库** | 语言 | 核心度(P0/P1/P2) | 入口文件 | **接口校验类型** |

接口校验类型取值（在确认点①请用户核对此列）：
  - `HTTP`    → API 接入层，有 HTTP/gRPC 路由注册，需做接口数对账
  - `MQ`      → 消息处理层，有 MQ Consumer/Exchange 声明，以 Topic 数做基准
  - `RPC`     → 内部服务层，有 .proto / .thrift / IDL 文件，以 Method 数做基准
  - `NONE`    → 调度/执行/数据层，无对外接口，不做接口数校验

## N×N 组件通信矩阵
（值：RPC/MQ/DB/—，标注置信度 [E]EXTRACTED/[I]INFERRED/[A]AMBIGUOUS）

## 核心调用链路（≥5条）
（格式：API(file:line) → 编排层(config:line) → 服务层(handler:line) → DB(table)）

## 术语表
| 内部术语 | 外部/产品术语 | 说明 |

## 不确定项（供人工确认）
（标注 [A] 的关系和推断，说明不确定原因）
（接口校验类型不确定的组件，标注 [?] 等用户在确认点①明确）
```

### Step 5：接口清单扫描（按校验类型分别执行）

**仅对 k1-architecture-map.md 中接口校验类型 ≠ NONE 的组件执行**：

```
FOR 每个 接口校验类型 = HTTP 的组件:
  执行 grep 扫描：
    Go:   grep -rn "\.GET\|\.POST\|\.PUT\|\.DELETE\|router\.Handle\|@handler" <component_dir>
    Python: grep -rn "@app\.route\|@router\.\|APIRouter\|include_router" <component_dir>
  记录：组件名 → HTTP接口数 N（SCAN_CONFIDENCE: HIGH/MEDIUM）

FOR 每个 接口校验类型 = MQ 的组件:
  执行 grep 扫描：
    grep -rn "Exchange\|Queue\|Topic\|consumer\|subscribe\|@KafkaListener" <component_dir>
  记录：组件名 → MQ Topic/Queue 数 N

FOR 每个 接口校验类型 = RPC 的组件:
  解析 .proto / .thrift 文件：
    find <component_dir> -name "*.proto" -o -name "*.thrift" | xargs grep "^rpc\|^service"
  记录：组件名 → RPC Method 数 N
```

结果写入 `_review/interface-inventory.json`：
```json
{
  "ComponentA": {"type": "HTTP", "count": 13, "confidence": "HIGH"},
  "ComponentB": {"type": "MQ",   "count": 5,  "confidence": "MEDIUM"},
  "ComponentC": {"type": "RPC",  "count": 8,  "confidence": "HIGH"},
  "ComponentD": {"type": "NONE", "count": 0,  "confidence": "—"}
}
```

**完成后**：更新 `current_phase` 为 `"phasek1_waiting_confirm"`。

**⛔ 确认点①** — 等待用户明确回复，不得自动进入下一阶段。

展示给用户：
```
架构分析完成。

组件清单（共 N 个）：
  P0 核心: [列表]
  P1 重要: [列表]
  P2 辅助: [列表]

接口扫描结果（供校验用）：
  HTTP 接口：ComponentA 13个, ComponentB 7个
  MQ Topic：  ComponentC 5个
  RPC Method：ComponentD 8个
  无接口组件：ComponentE, ComponentF, ...

AMBIGUOUS 关系（请明确）：
  - ComponentX → ComponentY 的通信方式不确定

请确认（直接编辑 k1-architecture-map.md 后回复"继续"）：
  1. 架构分层和 P0/P1/P2 标注是否正确？
  2. 每个组件的接口校验类型（HTTP/MQ/RPC/NONE）是否准确？
  3. 接口扫描数量是否合理？明显偏少说明有遗漏，偏多可能扫到了测试文件。
```

确认后：更新 `"phasek1_confirmed"` → Phase K2。

---
