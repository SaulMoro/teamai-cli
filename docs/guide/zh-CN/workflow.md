# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。它运行命令步骤和只读提示词步骤，每个步骤在它依赖的步骤之后运行。

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    needs: [compile]
    command: npm test
    output:
      ok: boolean
  - id: review
    needs: []
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，并且必须且只能使用 `command`、`prompt`、`prompt_file` 之一。提示词步骤可选填 `agent`。`output` 沿用已有简写：`string`、`number`、`boolean`、字面量联合、对象，或只含一种元素类型的数组。TeamAI 会用它校验成功命令的 stdout 或提示词工具返回的 `output`。

第一个步骤之后的每个步骤都要用 `needs` 列出它等待的步骤。`needs: []` 表示另起一个没有依赖的分支。每次只运行一个步骤：文件中第一个依赖都已完成的步骤。某个依赖失败，或所有依赖都被跳过时，该步骤会被跳过。被跳过的步骤不会运行。一个步骤失败不会停止其他分支。没有可运行的步骤时，只要有步骤失败，运行结果就是 `failed`，否则是 `succeeded`。缺少 `needs`、`needs` 中的 id 不是本工作流的步骤，或依赖成环，都会让该文件无效。缺少 `needs` 时，即使之前有有效版本，该工作流也没有可运行版本。

`teamai pull` 和 `teamai push` 分别检查每个文件。`prompt_file` 必须是团队仓库 `prompts/` 下的普通文件，不能是符号链接。校验时会把文件内容和工作流一起缓存，因此已经开始的运行会继续使用对应修订版，即使源文件后来被修改或删除。新修订版无效时，仍保留上一份有效缓存。这一版 teamai 不认识的字段除外：该工作流没有可运行版本，需要先更新 teamai。

工作流可以声明具名的 `ends`，每个结局是 `succeeded` 或 `failed`，例如 `ends: { dropped: succeeded, stuck: failed }`。带 `end: <name>` 的步骤成功后，工作流以该结局结束。只有 `id`、`needs` 和 `end` 的步骤不运行任何内容：它的依赖完成时就结束工作流。到达结局后，所有尚未运行的步骤都会被跳过，运行结果取该结局声明的结果，即使有其他步骤失败。此时 `done` 会带上结局：`{"done":{"run":"<run>","outcome":"succeeded","end":"dropped"}}`。`end` 不在 `ends` 中、有 `end` 但没有 `ends`、声明的结局没有步骤使用，或某个步骤依赖只用于结束工作流的步骤，都会让该文件无效。

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
