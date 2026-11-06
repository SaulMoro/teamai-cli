# Paseo 运行时

> 本文是 [工作流](workflow.md) 的一部分。

`teamai-runtime-paseo` 把每个提示词步骤作为 [Paseo](https://github.com/getpaseo/paseo) 守护进程的智能体运行，放在 teamai 交给该步骤的目录上的一个 Paseo 工作区里：只读步骤用你的检出目录，其余步骤用 teamai 准备的 worktree、克隆或团队仓库克隆。你在 Paseo 应用里查看智能体、回答它的权限请求。读取结果、提交、交付、评分和恢复仍由 teamai 负责。

它只运行提示词步骤。命令和 `setup` 交给定义里的下一个运行时，或留在本机。需要 `permissions: unattended` 的提示词步骤，交给下一个能运行它的运行时。带 `role` 的步骤在这里运行，使用 teamai 交付到其副本中的角色：运行时只在 Paseo 里打开这个副本，而 Paseo 只在它自己创建的 worktree 里运行项目的 worktree setup，所以不会有别的东西把你自己的资产交付进去。它也以 best-effort 评判被评分的轮次，见[评判被评分的轮次](#评判被评分的轮次)。

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

改用 Paseo 桌面应用时，从应用里安装它的命令行工具，它会把 `paseo` 链接到 `~/.local/bin`。即使 teamai 的 `PATH` 里没有 `~/.local/bin`，运行时也会在那里找到它。应用把客户端放在自己的归档文件里，所以运行时按应用构建把客户端解包一次到 `~/.teamai/runtime-state/paseo-client`，并按应用记录的 SHA-256 校验每个文件。

teamai 自带一个定义，把提示词步骤交给本机的守护进程，其余步骤留在本机。`--driver paseo` 用的就是它：

```yaml
# drivers/teamai-paseo.yaml，随 teamai 提供
schemaVersion: v1alpha1
name: teamai-paseo
description: Run each prompt step as an agent of the Paseo daemon on this machine, in a worktree teamai prepares, and every other step on this machine.
runtimes:
  - use: paseo
    options: { max_parallel: 4 }
  - use: local
```

它连接你的 Paseo 配置所指的守护进程，读法与 `paseo start` 相同：`$PASEO_HOME/config.json`（默认 `~/.paseo/config.json`）中的 `daemon.listen`，没有时为 `127.0.0.1:6767`。守护进程在其他地址，或需要其他选项时，在团队仓库或 `~/.teamai/drivers/` 里添加你自己的定义，如下面的示例所示。

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
Mode      auto
Cwd       /repo/.teamai/workflow-worktrees/teamai-r0769801107010602-classify-p1-4e57d9b3cff1
```

每个智能体都带有 `teamai-run` 和 `teamai-step` 标签，可以这样列出一次运行的智能体：

```sh
paseo ls --all --label teamai-run=r0769801107010602
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

`confined.json` 要求 `verified` 的受限步骤从不交给 Paseo，因为 Paseo 提供的是 `best-effort`。评判的位置在其智能体启动前，在运行详情里显示为 `Paseo confined prompt, best-effort`。

Codex 评判以 `auto` 模式启动，并把 Codex 的沙箱设为 `read-only`，因为 Paseo 列出的每种 Codex 模式都会不经询问就写入。Codex 用 shell 命令读文件，所以它的说明要求只用只读命令；沙箱不经询问就运行这些命令，其他任何操作都会询问并结束评判。`tool` 为 `codex` 的定义会让步骤和它的评判都在 Codex 上运行：

```yaml
# drivers/paseo-codex.yaml
schemaVersion: v1alpha1
name: paseo-codex
tool: codex
runtimes:
  - use: paseo
```

下面是 Codex 评判在产生这一轮的同一次运行中为它打标签：

```text
$ teamai workflow start fix-add --driver paseo-codex
ℹ run:r0cec7811f0b8ad80:fix:1: review-quality good (teamai-score run r6f8bb28e533b1c3b).
$ paseo logs 94f534b --filter tools
[Shell] ls -la
[Shell] ls -la transcripts
[Shell] cat 'transcripts/fix#1.md'
[Shell] cat 'diff.patch'
[Shell] cat 'evidence.json'
```

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The diff changes add to return a + b and adds a node:test assertion that add(2, 3) equals 5. The session shows no commands were run, as requested; the test was added but not executed." } }, "confined": { "tool": "codex", "isolation": "best-effort", "access": "read" } }
```

评分从守护进程的智能体写入会话的地方读取步骤的会话：守护进程所属用户的工具主目录。请让守护进程以运行 teamai 的成员身份、在同一台机器上运行。守护进程以其他用户或其他 `HOME` 运行时，这一轮不会被打标签，评分运行的 `evidence` 步骤会说明原因：

```text
evidence_missing: Pass 1 of step fix in run r080799f10648b1ed cannot be scored: no longer on this machine: claude-code session 346fd0be-1a5a-474b-aedf-24c305d5c1a6 of fix#1. Restore what is missing, or score another pass.
```

Codex 步骤的一轮也以同样方式评分。teamai 从 `teamai init` 时记录的 Codex 根目录（当时的 `$CODEX_HOME`，或 `~/.codex`）读取 Codex 会话，包括已归档的会话：teamai 关闭尝试时，Paseo 归档该智能体，Codex 把它的会话移到该根目录下的 `archived_sessions/`，teamai 仍能在那里找到它。所以请用 `teamai init` 时的 `CODEX_HOME` 启动守护进程。守护进程的 Codex 写入其他根目录时，这一轮不会被打标签：

```text
evidence_missing: Pass 1 of step fix in run ra429df3ad473c7b3 cannot be scored: no longer on this machine: codex session 01a1a731-9053-7cf2-9884-68058745044a of fix#1. Restore what is missing, or score another pass.
```

## 选项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `url` | `$PASEO_HOME/config.json` 中 `daemon.listen` 所指的地址，没有时为 `ws://127.0.0.1:6767/ws` | Paseo 守护进程的 WebSocket 地址：`ws://`、`wss://`，Unix 套接字则为 `ws+unix://<套接字路径>:/ws`。 |

`max_parallel` 是 teamai 自己的键，见 [运行时选项](workflow-advanced.md#运行时选项)。Paseo 本身没有并发上限。

```yaml
# drivers/paseo-7070.yaml
schemaVersion: v1alpha1
name: paseo-7070
description: Run prompt steps as agents of the Paseo daemon on port 7070, and the rest here.
runtimes:
  - use: paseo
    options:
      url: ws://127.0.0.1:7070/ws
  - use: local
```

## 工具、模型和模式

只要工具的可执行文件在守护进程的 `PATH` 上，Paseo 就称它可用，不论是否已登录。运行时只在 Paseo 表明工具能在那里运行时才提供它；否则，使用该工具的步骤交给下一个运行时。步骤的智能体以 Paseo 为该工具设定的默认模式启动（`paseo provider ls` 中的 `DEFAULT MODE`），从不使用从不询问的绕过权限模式：默认模式是这种模式时，智能体改用 Paseo 列表中排在它前面、最接近它的模式。Paseo 设定的默认模式不在它为该工具列出的模式中时，不提供该工具。评判以一个在编辑或运行任何东西前先询问的模式启动：

| 工具 | 何时提供 | 步骤模式 | 评判模式 |
| --- | --- | --- | --- |
| `claude` | 守护进程主机上的 `claude auth status` 显示 `"loggedIn": true`：账号登录或 API key 均可 | Paseo 的默认模式：Paseo 0.14.0 上为 `auto` | `default` |
| `codex` | 守护进程在本机运行（`url` 是回环地址，如 `127.0.0.1` 或 `localhost`，或是 Unix 套接字），且 `codex login status` 显示 `Logged in` | Paseo 的默认模式：Paseo 0.14.0 上为 `auto-review` | `auto`，沙箱为 `read-only` |
| `opencode` | Paseo 为它列出了模型：OpenCode 连上了模型提供方，包括它的免费模型 | OpenCode 自己的默认模式 `build`：Paseo 没有为它设定 | `plan` |

Paseo 不报告 Codex 是否已登录，所以运行时自己用你的环境（`CODEX_HOME` 或 `~/.codex`）运行 `codex login status`。它运行的是 Paseo 诊断中 `Resolved path` 所指的 `codex`，即守护进程在它自己的 `PATH` 上找到的那个，而不是 teamai 的 `PATH` 上的。守护进程在其他任何地址上时（例如在另一台机器上），从不提供 Codex。这项检查看不到守护进程自己的环境，回环地址一律算作本机：请用你平时的 `CODEX_HOME` 启动守护进程，也不要让 `url` 指向通往另一台机器的隧道（`ssh -L`）。

守护进程一个工具都运行不了时，运行在任何步骤之前停止，消息说明要在守护进程主机上做什么：

```text
$ teamai workflow start fix-add --driver paseo-signed-out
{"error":{"code":"runtime_failed","message":"Runtime \"paseo\" of driver \"paseo-signed-out\" did not start: The Paseo daemon at ws://127.0.0.1:6799/ws runs no tool teamai-runtime-paseo can use. claude: signed out; run `claude auth login` on the daemon's host. codex: signed out; run `codex login` on the daemon's host."}}
```

守护进程能运行另一个工具时，运行照常开始，使用定义的 `tool` 的步骤不启动智能体就失败：

```text
$ teamai workflow start fix-add --driver paseo-codex
✖ Step "fix" failed with tool_unavailable: teamai-runtime-paseo did not offer codex: signed out; run `codex login` on the daemon's host.
```

想自己检查某个工具，就问守护进程或 Codex，看 `Auth` 和 `Resolved path` 这两行：

```text
$ paseo provider diagnostic claude | grep -A2 Auth
  Auth: {
  "loggedIn": true,
  "authMethod": "oauth_token",
$ paseo provider diagnostic codex | grep 'Resolved path'
  Resolved path: ~/.nvm/versions/node/v24.21.0/bin/codex
$ ~/.nvm/versions/node/v24.21.0/bin/codex login status
Logged in using ChatGPT
```

步骤的 `model` 必须是守护进程提供的模型，`effort` 必须是该模型支持的。不写 `model` 时，智能体使用守护进程的默认模型。

对 OpenCode 来说，这个默认模型可能是 OpenCode 的免费模型之一，它们不需要登录。OpenCode 没有标出默认模型时，智能体使用守护进程列出的第一个模型：

```text
$ paseo provider models opencode
ID                                    MODEL
opencode/crouton-alpha-free           Crouton Alpha Free
opencode/pulse-alpha-free             Pulse Alpha Free
github-copilot/gpt-6.1-terra          GPT-6.1 Terra
…
github-copilot/claude-sonnet-5.5      Claude Sonnet 5.5
```

这样，不写 `model` 的步骤或评判会把它的提示词，或它要评判的证据，发给 OpenCode 的免费提供方。固定模型，让它们留在你选定的提供方：

```yaml
# workflows/review-opencode.yaml
schemaVersion: v1alpha1
name: review-opencode
description: Review the branch on OpenCode, on a model the team chose.
steps:
  - id: review
    tool: opencode
    model: { name: github-copilot/claude-sonnet-5.5 }
    prompt: Review the change on this branch, and list what it gets wrong.
```

```markdown
<!-- scorers/review-quality.md -->
---
model: github-copilot/claude-sonnet-5.5
labels:
  - value: good
    score: 1
    description: The change does what the step asked, with tests.
  - value: bad
    score: 0
    description: The change does not do what the step asked.
passingScore: 1
---
Judge whether the change does what the step asked. Read the diff and the session.
```

守护进程没有的模型会在任何智能体启动前失败：

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

Claude 智能体可以不经询问写两样东西：teamai 的结果文件，以及运行的临时目录，即运行的命令中 `$TEAMAI_RUN_DIR` 所指的目录。运行时允许 `Edit(/<结果文件>)` 和 `Edit(/<运行目录>/**)`，模式是 Paseo 启动它时的模式。Codex 智能体可以写同样两处：它在 `auto-review` 下的沙箱可写工作树，运行时再把结果文件所在目录和运行的临时目录加为可写根目录：

```json
{ "provider": "codex", "modeId": "auto-review", "providerOptions": { "sandbox_workspace_write": { "writable_roots": ["~/.teamai/workflows/runs/ra429df3ad473c7b3/attempts/a21ff251b/out", "~/.teamai/workflows/runs/ra429df3ad473c7b3/scratch"] } } }
```

OpenCode 智能体也可以写这两处：运行时通过 OpenCode 的 `external_directory` 权限放行它们，所以它只在碰工作树之外的其他东西前询问：

```json
{ "provider": "opencode", "providerOptions": { "permission": { "external_directory": { "~/.teamai/workflows/runs/ra429df3ad473c7b3/attempts/a21ff251b/out/*": "allow", "~/.teamai/workflows/runs/ra429df3ad473c7b3/scratch/*": "allow" } } } }
```

步骤的环境变量里，智能体只拿到 `TEAMAI_RUN_DIR`，所以提示词写明 `$TEAMAI_RUN_DIR` 所指目录中的某个文件时，它的效果与在本机相同。

有人值守的运行里，其他权限请求在 Paseo 应用里等你回答，也可以在命令行回答：

```sh
paseo permit ls
paseo permit allow 7c483fce --all
```

无人值守的运行（`TEAMAI_MODE=unattended` 或 `CI`）里没人能回答，所以步骤失败，智能体停止。下面是一个提示词步骤 `count`，它让智能体运行 `ls -1 | wc -l`：

```text
✖ Step "count" failed with tool_failed: The claude agent asked for permission (Bash) in Paseo mode auto, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.
```

## 交互式步骤

在有人值守的运行中，`interactive: true` 的步骤作为一个 Paseo 智能体运行，你在 Paseo 应用里与它一起完成。它的提示词开头告诉智能体与你一起完成这个步骤，并且只在你说步骤完成后才写 teamai 的结果。智能体在你两次发言之间空闲时，步骤一直等待；结果写入后步骤结束。无人值守的运行中没有人可以协作，所以该步骤交给提供 HITL 的运行时，见 [HITL](workflow-advanced.md#hitl人在回路中)。

## 取消、崩溃和重启

`teamai workflow cancel` 会停止智能体，步骤以 `cancelled` 结束：

```sh
teamai workflow cancel r144a3913136e7b62
```

Paseo 可能在智能体的这一轮结束之前就答复取消，所以只有当 Paseo 报告智能体不再运行时，步骤才以 `cancelled` 结束。取消 10 秒后仍在运行的智能体，或者 Paseo 在这段时间内没有答复的取消，会让步骤以 `cancel_failed` 失败，teamai 会保留这次尝试和登录：

```text
Paseo cancelled the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f, but it still ran 10 s later. It may still change the worktree; stop it in the Paseo app.
```

等智能体能够停止后，再运行一次 `teamai workflow cancel`：运行时会重新尝试停止，步骤以 `cancelled` 结束。

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

只有当 Paseo 报告这次尝试的每个智能体都不再运行时，这个位置才算关闭。归档 10 秒后仍在运行的智能体会让它保持打开：

```text
Paseo archived workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79), but agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f still ran 10 s later. It may still change the worktree; stop it in the Paseo app.
```

Paseo 以错误回答的创建请求（例如连接中断时）仍可能启动它的智能体。在 Paseo 显示这个智能体之前，这次尝试保持打开。智能体出现后，下一次 `teamai workflow cancel` 会停止它。teamai 无法判断 Paseo 是否拒绝了这个创建请求，所以如果智能体一直没有出现，请删除消息里给出的记录文件，然后再次取消：

```text
Paseo does not show the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f yet, though its create was sent, so it may still start in the worktree. Once it appears, run teamai workflow cancel r3ad62eacc3c191eb again, which stops it. If it never appears in Paseo, the create was refused: delete ~/.teamai/runtime-state/paseo/ops/op-3f9c2a7b1d4e6f80.json and run teamai workflow cancel r3ad62eacc3c191eb again.
```

同一个 worktree 上的两次尝试共用它的 Paseo 工作区，只有最后关闭的那次尝试会归档它。先关闭的尝试改为取消它自己的智能体（包括失败步骤的智能体），另一次尝试的智能体继续运行。Paseo 不肯取消的智能体会让这次尝试保持打开，teamai 可以再次关闭它：

```text
Paseo did not cancel the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f: Agent is busy. It may still run in the worktree; stop it in the Paseo app.
```

你在 Paseo 里已经打开的、同一目录上的工作区（例如只读步骤在你的检出目录中运行时）从不被归档：这次尝试改为取消它自己的智能体，你的工作区保持打开。

运行时在步骤中途被杀掉就无法归档；步骤以 `runtime_lost` 失败，它的工作区会留在 Paseo 里，直到你归档它（`paseo workspace archive <id>`）。

崩溃后的 `teamai workflow cancel` 会以 recover 模式打开运行时。它不检查登录，所以之后退出登录的工具不会妨碍它停止智能体；它只为取消智能体和关闭这次尝试而连接守护进程。守护进程停着时，取消会保留这次尝试和登录，并说明原因：

```text
No Paseo daemon answered at ws://127.0.0.1:6767/ws within 10 s. Start it with `paseo start`, or set the runtime's url option to the daemon's address. Until then teamai-runtime-paseo cannot cancel the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f, which may still run in the worktree; cancel the run again.
```

启动守护进程，然后再运行一次 `teamai workflow cancel`。

## 启动时的错误

| 代码 | 何时出现 |
| --- | --- |
| `client_missing` | 找不到 Paseo 客户端：`PATH` 上和 `~/.local/bin` 里都没有 `paseo`，或 `PASEO_CLIENT_PATH` 指向的不是 `@getpaseo/client` 包。从 Paseo 桌面应用的设置中或用 `npm install -g @getpaseo/cli` 安装 Paseo CLI，或设置 `PASEO_CLIENT_PATH`。Paseo 应用的客户端中有文件与应用记录的 SHA-256 不符时也是此错误：重新安装应用。 |
| `client_version` | 找到的 Paseo 客户端早于 0.14.0。升级 Paseo，或把 `PASEO_CLIENT_PATH` 指向更新的 `@getpaseo/client` 包。 |
| `daemon_unreachable` | `url` 上没有守护进程应答。用 `paseo start` 启动它。 |
| `daemon_version` | 守护进程早于 0.14.0。升级 Paseo 并重启它。 |
| `tool_unavailable` | 守护进程 `claude`、`codex` 和 `opencode` 都运行不了：要么没装、要么未登录、要么缺少默认模式；守护进程不在回环地址上时，Codex 也算在内。消息逐个列出已安装的工具及其修复方法；一个都没装时，消息让你安装一个。步骤写明的工具守护进程运行不了时，该步骤交给下一个运行时；使用定义的 `tool` 的步骤则以 `tool_unavailable` 失败，原因相同。 |
| `paseo_config` | 没有 `url` 时，无法从 Paseo 的配置读出守护进程地址：`$PASEO_HOME/config.json` 不是 JSON，它的 `daemon` 部分不是 Paseo 写出的样子，或 `daemon.listen` 指向 Windows 命名管道。修好该文件，或设置 `url`。 |
| `bad_option` | `url` 以外的选项。 |
