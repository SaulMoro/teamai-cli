# Paseo 运行时

> 本文是 [工作流](workflow.md) 的一部分。

`teamai-runtime-paseo` 把每个提示词步骤作为 [Paseo](https://github.com/getpaseo/paseo) 守护进程的智能体运行，放在一个 Paseo 工作区里，该工作区就是 teamai 为这个步骤准备的 worktree。你在 Paseo 应用里查看智能体、回答它的权限请求。读取结果、提交、交付、评分和恢复仍由 teamai 负责。

它只运行提示词步骤。命令和 `setup` 交给定义里的下一个运行时，或留在本机。需要 `permissions: unattended` 或 `role` 的提示词步骤，交给下一个能运行它的运行时。它也以 best-effort 评判被评分的轮次，见[评判被评分的轮次](#评判被评分的轮次)。

## 快速开始

Paseo 是前置条件：teamai 不附带它的任何代码。在运行工作流的机器上安装 Paseo（0.14.0 或更高版本），并启动它的守护进程：

```sh
npm install -g @getpaseo/cli
paseo start
paseo status    # listen: 127.0.0.1:6767
```

运行时启动时从这次安装加载 Paseo 的客户端：它顺着 `PATH` 上的 `paseo` 找到其所在的包，所以客户端始终与你的守护进程一致。teamai 运行时的 `PATH` 里没有 `paseo` 时，自己指定客户端。安装在单独前缀下时：

```sh
npm install -g --prefix ~/.paseo-cli @getpaseo/cli
export PASEO_CLIENT_PATH=~/.paseo-cli/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/client
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

## 评判被评分的轮次

带 `scorers` 的步骤由 `teamai-score` 工作流评判：它的记账命令在本机运行，评判则是一个受限提示词，只读一个证据目录，别的都不读。Paseo 回答这个提示词，所以只有 `paseo` 的定义在没有任何智能体 CLI 的机器上也能运行并评判被评分的步骤：

```yaml
# drivers/paseo-only.yaml
schemaVersion: v1alpha1
name: paseo-only
tool: claude
runtimes:
  - use: paseo
```

该步骤由 [`review-quality`](scorers.md) 评判，每个轮次都评判：

```yaml
# workflows/fix-add.yaml
schemaVersion: v1alpha1
name: fix-add
description: Fix add in math.js, and judge the change.
steps:
  - id: fix
    workspace: new
    prompt: |
      add in math.js returns a - b. Make it return a + b, and add math.test.js that checks add(2, 3) is 5 with node:test.
      Edit the files only, and run no command.
    scorers: { names: [review-quality], sampling: all }
    output:
      fixed: boolean
```

```text
$ command -v claude codex opencode
$ teamai workflow start fix-add --driver paseo-only
ℹ Run rd573bcff8eef4e10 started. If it stops before it ends, continue it with: teamai workflow resume rd573bcff8eef4e10
ℹ run:rd573bcff8eef4e10:fix:1: review-quality good (teamai-score run re02e01c9b0e36c69).
{"data":{"done":{"run":"rd573bcff8eef4e10","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

在这次有人值守的运行里，fix 智能体在两次编辑前各询问一次，用 `paseo permit allow <agent> --all` 回答。评判什么都没问：它只用 `Read` 读了那个目录。

两个智能体都在 Paseo 里运行。评判智能体的 cwd 是 teamai 写好的证据目录：

```text
$ paseo ls --all
NAME                                       PROVIDER                STATUS  CWD
teamai score[0].judge · re02e01c9b0e36c69  claude/claude-opus-5-5  closed  ~/.teamai/projects/…/runs/re02e01c9b0e36c69/scratch/a47d92bbe
teamai fix · rd573bcff8eef4e10             claude/claude-opus-5-5  closed  /repo/.teamai/workflow-worktrees/teamai-rd573bcff8eef4e10-fix-p1-a04485788cc1
```

评判步骤记录运行时保持的级别：

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The step asked for two things: change add in math.js from a - b to a + b, and add math.test.js that uses node:test to check add(2, 3) is 5… The diff does both…" } }, "confined": { "tool": "claude", "isolation": "best-effort", "access": "read" } }
```

评判以 `best-effort` 运行，从不是 `verified`：

| 内容 | 是否强制 |
| --- | --- |
| 一个全新的智能体，cwd 是证据目录，并被告知只读这个目录 | 是 |
| 不编辑，也不运行工具自身规则未允许的命令：评判所用模式会先询问，而任何权限请求都会结束评判，无论有无人值守 | 是 |
| 它的回答是最后一条消息，按 JSON 解析；它什么都不写 | 是 |
| 不读目录之外的文件 | 否：没有什么能阻止智能体读取别处的文件 |
| 不访问网络 | 否 |

`confined.json` 要求 `verified` 的受限步骤从不交给 Paseo，因为 Paseo 提供的是 `best-effort`。Codex 从不在 Paseo 上评判，因为 Codex 的每种模式都会不经询问就写入。评判的位置在其智能体启动前，在运行详情里显示为 `Paseo confined prompt, best-effort`。

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

守护进程提供 `claude`、`codex`、`opencode` 时，运行时就提供它们。智能体以该工具在 Paseo 中的默认模式启动，从不使用绕过权限的模式。评判以一个在编辑或运行任何东西前先询问的模式启动：

| 工具 | 步骤模式 | 评判模式 |
| --- | --- | --- |
| `claude` | `default`（执行未允许的操作前先询问） | `default` |
| `codex` | `auto` | 无：Codex 的每种模式都不经询问就写入 |
| `opencode` | `build` | `plan` |

步骤的 `model` 必须是守护进程提供的模型，`effort` 必须是该模型支持的。不写 `model` 时，智能体使用守护进程的默认模型。守护进程没有的模型会在任何智能体启动前失败：

```text
✖ Step "classify" failed with model_unavailable: The Paseo daemon at ws://127.0.0.1:6767/ws has no claude model claude-opus-0-1. It offers: claude-opus-5-5, claude-opus-5, claude-fable-5-1, claude-fable-5, claude-opus-4-8[1m], claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-opus-4-7[1m], claude-opus-4-7, claude-opus-4-6[1m], claude-opus-4-6, claude-sonnet-4-6[1m], claude-sonnet-4-6, claude-haiku-5-5, claude-haiku-4-5.
```

智能体拿到步骤的提示词。步骤的后续轮次会启动一个新的智能体，不会延续前一轮的会话。Paseo 不报告完整的 token 数，所以有 token 预算的步骤交给下一个运行时。

## 凭据

Paseo 以明文把智能体的环境变量存在它的 home 下，所以这个运行时不接受 `credentials`，给它凭据的定义会被 teamai 拒绝：

```text
{"error":{"code":"bad_option","message":"Runtime \"paseo\" of driver definition ~/.teamai/drivers/paseo.yaml refused option \"credentials\": paseo does not offer can.env, so it cannot keep a credential to the processes it is for. Fix the option and start again."}}
```

删掉这一项，改为在守护进程所在的机器上给工具它需要的东西：在那里登录该工具，或者把变量设在守护进程启动时的环境里，然后 `paseo restart`。智能体拿到的是守护进程的环境。

## 权限

Claude 智能体可以不经询问写两样东西：teamai 的结果文件，以及运行的临时目录，即运行的命令中 `$TEAMAI_RUN_DIR` 所指的目录。运行时允许 `Edit(/<结果文件>)` 和 `Edit(/<运行目录>/**)`，模式仍是 `default`。Codex 和 OpenCode 没有这项授权。步骤的环境变量里，智能体只拿到 `TEAMAI_RUN_DIR`，所以提示词写明 `$TEAMAI_RUN_DIR` 所指目录中的某个文件时，它的效果与在本机相同。

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
| `client_missing` | 找不到 Paseo 客户端：`PATH` 上没有 `paseo`，或 `PASEO_CLIENT_PATH` 指向的不是 `@getpaseo/client` 包。安装 Paseo，或设置 `PASEO_CLIENT_PATH`。 |
| `daemon_unreachable` | `url` 上没有守护进程应答。用 `paseo start` 启动它。 |
| `daemon_version` | 守护进程早于 0.14.0。升级 Paseo 并重启它。 |
| `tool_unavailable` | 守护进程在默认模式下没有 `claude`、`codex`、`opencode` 中的任何一个。守护进程没有步骤所需工具时，该步骤交给下一个运行时。 |
| `bad_option` | `url` 以外的选项。 |
