# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。它按顺序运行命令步骤和只读提示词步骤。

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    command: npm test
    output:
      ok: boolean
  - id: review
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，并且必须且只能使用 `command`、`prompt`、`prompt_file` 之一。提示词步骤可选填 `agent`。`output` 沿用已有简写：`string`、`number`、`boolean`、字面量联合、对象，或只含一种元素类型的数组。TeamAI 会用它校验成功命令的 stdout 或提示词工具返回的 `output`。

`teamai pull` 和 `teamai push` 分别检查每个文件。`prompt_file` 必须是团队仓库 `prompts/` 下的普通文件，不能是符号链接。校验时会把文件内容和工作流一起缓存，因此已经开始的运行会继续使用对应修订版，即使源文件后来被修改或删除。新修订版无效时，仍保留上一份有效缓存。这一版 teamai 不认识的字段除外：该工作流没有可运行版本，需要先更新 teamai。

在本地配置中按机器选择无界面工具：

```yaml
workflows:
  tools:
    default: claude
    implementer: codex
```

有 agent 专用配置时优先于 `default`。支持 `claude`、`codex` 和 `opencode`。CI 可以在单次启动时用 `--tools default=claude,implementer=codex` 覆盖。命名 agent 从 `teamai pull` 已经部署到该工具、该 scope 目录里的文件读取。

```text
teamai workflow start build --driver local
```

`--driver local` 在当前目录里一次运行一个步骤。每次 attempt 的 `result.json` 位于当前 scope 的 TeamAI 数据目录中，不在产品检出目录内。提示词步骤只读；如果工具修改了仓库，步骤会失败，同时保留文件供检查。驱动调用的 `next` 和 `report` 与下面相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。

运行状态保存在当前 scope 的 TeamAI 数据目录里。命令结束后进程就退出。本地运行以 `failed` 结束时，退出码是 1。不会留下常驻的工作流进程。

## 运行记录

每次运行都会向团队的 `teamai-reports` 分支发布一条保护隐私的记录：开始时一次，结束时一次。记录存放在 `workflows/runs/<run id>.json`，以 run id 为键，重试的发布会更新同一条记录而不是产生副本。

记录只包含：run id、工作流名、阶段（`start` 或 `end`）、驱动的 kind、状态、开始和结束时间、时长、逐步条目（step、agent、tool、model、outcome、tokens——混合 agent 的运行会分别记录每步自己的字段）、步骤汇总计数、累计已结算 attempt 数，以及发布者用户名。提示词、命令文本、输出、diff、秘密值、本地工作区路径、会话 id 和主机名没有可落地的字段——记录由白名单构建，而不是从运行状态里过滤。

发布失败时——没有远端、reports 锁被占用、push 被拒——记录会进入当前 scope 数据目录的本地队列，在下一次 `teamai pull` 时重试。此时 `start`、`next`、`report` 的返回会带 `record: pending` 而不是 `record: published`。运行本身不受影响：一台机器在运行开始后崩溃，该运行会以"已开始未结束"的状态保持可见。

Run id 是 `r` 加 16 位十六进制。此方案之前创建的运行用 8 位十六进制，仍然可以解析。

工作流总量（runs、succeeded、failed、累计时长）在发布时折入 reports 分支的 `stats/<username>.yaml`，由 `teamai digest` 展示。
