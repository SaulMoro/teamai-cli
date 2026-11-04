# Paseo 运行时

> 本文是 [工作流](workflow.md) 的一部分。

`teamai-runtime-paseo` 把每个提示词步骤作为 [Paseo](https://github.com/getpaseo/paseo) 守护进程的智能体运行，放在一个 Paseo 工作区里，该工作区就是 teamai 为这个步骤准备的 worktree。你在 Paseo 应用里查看智能体、回答它的权限请求。读取结果、提交、交付、评分和恢复仍由 teamai 负责。

它只运行提示词步骤。命令、`setup`，以及需要 `permissions: unattended` 或 `role` 的步骤，交给定义里的下一个运行时。

## 快速开始

在运行工作流的机器上启动 Paseo 守护进程（0.14.0 或更高版本）：

```sh
paseo start
paseo status    # listen: 127.0.0.1:6767
```

在团队仓库或 `~/.teamai/drivers/` 里添加一个定义，把提示词步骤交给 Paseo，其余步骤留在本机：

```yaml
# drivers/paseo.yaml
schemaVersion: v1alpha1
name: paseo
description: Run prompt steps as agents of the local Paseo daemon, and the rest here.
runtimes:
  - use: paseo
    options:
      max_parallel: 4
  - use: local
```

工作流不需要任何 Paseo 专用字段：

```yaml
# workflows/paseo-review.yaml
schemaVersion: v1alpha1
name: paseo-review
description: Count the files, then ask a Claude agent in Paseo whether the README has a title.
steps:
  - id: count
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('fs').readdirSync('.').length}))"
    output:
      files: number
  - id: classify
    needs: [count]
    workspace: new
    tool: claude
    model: { name: claude-sonnet-5-5 }
    prompt: |
      Read README.md and say whether it starts with a Markdown title.
      Answer with the output {"has_title": true} or {"has_title": false}.
    output:
      has_title: boolean
```

```sh
teamai workflow start paseo-review --driver paseo
```

```text
ℹ Run r0769801107010602 started. If it stops before it ends, continue it with: teamai workflow resume r0769801107010602 --driver paseo
{"data":{"done":{"run":"r0769801107010602","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`count` 在本机运行。`classify` 在 Paseo 里、在 teamai 的 worktree 中运行：

```text
$ paseo inspect 9b38e203
Name      teamai classify · r0769801107010602
Provider  claude
Model     claude-sonnet-5-5
Mode      default
Cwd       /repo/.teamai/workflow-worktrees/teamai-r0769801107010602-classify-p1-4e57d9b3cff1
```

智能体工作时，仪表盘的运行详情会显示它，并附带在 Paseo 中打开它的链接：

```json
{ "label": "teamai classify · r7f54a1690b9ae0ce", "url": "paseo://h/srv_vL5abcnfKUWY/agent/5f95baae-9117-42b7-9e3d-47891dd3e84d", "fields": { "agent": "5f95baae-9117-42b7-9e3d-47891dd3e84d", "workspace": "wks_f55e98406bad64bd", "model": "claude/claude-sonnet-5-5" } }
```

步骤记录里有它的输出和 Claude 的会话 id：

```json
{ "id": "classify", "outcome": "success", "outputs": { "has_title": true }, "tool": "claude", "session": "35ab4949-21d9-40df-9444-652e96607b7b" }
```

## 选项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `url` | `ws://127.0.0.1:6767/ws` | 本机 Paseo 守护进程的 WebSocket 地址。 |

`max_parallel` 是 teamai 自己的键，见 [运行时选项](workflow-advanced.md#运行时选项)。Paseo 本身没有并发上限。

```yaml
runtimes:
  - use: paseo
    options:
      url: ws://127.0.0.1:7070/ws
```

## 工具、模型和模式

守护进程提供 `claude`、`codex`、`opencode` 时，运行时就提供它们。智能体以该工具在 Paseo 中的默认模式启动，从不使用绕过权限的模式：

| 工具 | 模式 |
| --- | --- |
| `claude` | `default`（执行未允许的操作前先询问） |
| `codex` | `auto` |
| `opencode` | `build` |

步骤的 `model` 必须是守护进程提供的模型，`effort` 必须是该模型支持的。不写 `model` 时，智能体使用守护进程的默认模型。守护进程没有的模型会在任何智能体启动前失败：

```text
✖ Step "classify" failed with model_unavailable: The Paseo daemon at ws://127.0.0.1:6767/ws has no claude model claude-opus-0-1. It offers: claude-opus-5-5, claude-opus-5, claude-fable-5-1, claude-fable-5, claude-opus-4-8[1m], claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-opus-4-7[1m], claude-opus-4-7, claude-opus-4-6[1m], claude-opus-4-6, claude-sonnet-4-6[1m], claude-sonnet-4-6, claude-haiku-5-5, claude-haiku-4-5.
```

智能体只拿到步骤的提示词，拿不到运行的任何环境变量。Paseo 不报告完整的 token 数，所以有 token 预算的步骤交给下一个运行时。

## 凭据

Paseo 以明文把智能体的环境变量存在它的 home 下，所以这个运行时不接受 `credentials`，给它凭据的定义会被 teamai 拒绝：

```text
{"error":{"code":"bad_option","message":"Runtime \"paseo\" of driver definition ~/.teamai/drivers/paseo.yaml refused option \"credentials\": paseo does not offer can.env, so it cannot keep a credential to the processes it is for. Fix the option and start again."}}
```

删掉这一项，改为在守护进程所在的机器上给工具它需要的东西：在那里登录该工具，或者把变量设在守护进程启动时的环境里，然后 `paseo restart`。智能体拿到的是守护进程的环境。

## 权限

Claude 智能体可以不经询问写 teamai 的结果文件，且只能写这一个文件：运行时为它允许 `Edit(/<结果文件>)`，模式仍是 `default`。Codex 和 OpenCode 没有这项授权。

有人值守的运行里，其他权限请求在 Paseo 应用里等你回答，也可以在命令行回答：

```sh
paseo permit ls
paseo permit allow 7c483fce --all
```

无人值守的运行（`TEAMAI_MODE=unattended` 或 `CI`）里没人能回答，所以步骤失败，智能体停止。下面是一个提示词步骤 `count`，它让智能体运行 `ls -1 | wc -l`：

```text
✖ Step "count" failed with tool_failed: The claude agent asked for permission (Bash) in Paseo mode default, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.
```

## 取消、崩溃和重启

`teamai workflow cancel` 会停止智能体，步骤以 `cancelled` 结束：

```sh
teamai workflow cancel r144a3913136e7b62
```

智能体工作时 teamai 被杀掉，智能体会继续运行。`resume` 重新连上同一个智能体，不会再启动第二个：

```sh
kill -9 <teamai pid>
teamai workflow resume rffcaabe1e1852479 --driver paseo
```

守护进程在步骤中途重启会关闭它的智能体。它停着的时候，步骤等它恢复；恢复后步骤失败，已做的改动留在 worktree 里：

```text
✖ Step "classify" failed with runtime_failed: The step runtime could not run the prompt (daemon_restarted): The Paseo daemon at ws://127.0.0.1:6767/ws stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree; run `teamai workflow retry` to run the step again.
```

```sh
teamai workflow retry r3ad62eacc3c191eb classify
teamai workflow resume r3ad62eacc3c191eb --driver paseo
```

teamai 关闭这次尝试时，运行时会归档它的 Paseo 工作区，这会停止那里仍在运行的一切。Paseo 只删除它自己创建的 worktree，所以 teamai 的 worktree 和分支会保留。Paseo 拒绝归档时，运行详情会说明这个位置没有关闭，以及原因：

```text
Paseo did not archive workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79): <Paseo's error>. Its agents may still run; archive it in the Paseo app.
```

运行时在步骤中途被杀掉就无法归档；步骤以 `runtime_lost` 失败，它的工作区会留在 Paseo 里，直到你归档它（`paseo workspace archive <id>`）。

## 启动时的错误

| 代码 | 何时出现 |
| --- | --- |
| `daemon_unreachable` | `url` 上没有守护进程应答。用 `paseo start` 启动它。 |
| `daemon_version` | 守护进程早于 0.14.0。升级 Paseo 并重启它。 |
| `tool_unavailable` | 守护进程在默认模式下没有 `claude`、`codex`、`opencode` 中的任何一个。守护进程没有步骤所需工具时，该步骤交给下一个运行时。 |
| `bad_option` | `url` 以外的选项。 |
