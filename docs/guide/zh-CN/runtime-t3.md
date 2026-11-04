# T3 运行时

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

`t3` [步骤运行时](workflow-advanced.md#驱动定义和步骤运行时)把工作流的每个提示词步骤作为一个独立的 [T3 Code](https://t3.codes) 线程运行。你可以在应用里看 agent 工作，回应它的审批请求，发消息引导它，或者停止它。teamai 仍然在你的机器上准备步骤的 worktree、读取结果、提交并推送。命令步骤和带 `setup` 的步骤在 `local` 上运行，和 `--driver local` 一样。

它作为可执行文件 `teamai-runtime-t3` 随 teamai 一起发布。`--driver t3` 使用 teamai 自带的定义：

```yaml
# drivers/teamai-t3.yaml, shipped with teamai
schemaVersion: v1alpha1
name: teamai-t3
description: Run each prompt step as a T3 Code thread of its own, in a worktree teamai prepares, and every other step on this machine.
runtimes:
  - use: t3
    options:
      environment: local
      max_parallel: 4
  - use: local
```

## 快速开始

**1. 在这台机器上打开 T3 Code，把仓库添加为项目**，在应用里（Add project）或在终端里：

```sh
t3 project add ~/src/acme-app
```

**2. 写一个 `workspace: new` 的提示词步骤，并在提示词里写清结果的样子。** agent 读的是提示词，不是 `output` 块：只说“把数量放进 output.sections”时，Claude 写成了 `markdown_sections`，步骤以 `invalid_output` 失败。

```yaml
# workflows/readme-review.yaml
schemaVersion: v1alpha1
name: readme-review
description: Count the README's sections and suggest one improvement
steps:
  - id: inventory
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('node:fs').readdirSync('.').length}))"
    output:
      files: number
  - id: review
    needs: [inventory]
    workspace: new
    tool: claude
    model: { name: claude-haiku-5-5 }
    prompt: >-
      Read README.md. Count its markdown sections (lines that start with "#") and suggest one short improvement.
      Do not change any file. The result file must be exactly
      {"output": {"sections": <the count>, "suggestion": "<the improvement>"}}, with those two key names.
    output:
      sections: number
      suggestion: string
```

**3. 启动它**，在这台机器的终端里或在一个 T3 线程里：

```sh
teamai pull
teamai workflow start readme-review --driver t3
```

第一次运行会在浏览器里打开 T3 的登录页面。在那里用 **Auto** 权限批准 teamai。你选的权限是步骤线程能运行的最宽模式；除非你[收紧它](#步骤线程会问你多少)，线程都以 Auto 运行。teamai 把凭据保存在 `~/.teamai/runtime-state/t3/credentials.json`（权限 0600），所以之后的运行不再打开页面，直到 T3 的凭据过期。

**4. 在 T3 里看步骤运行。** `inventory` 在你的机器上运行。`review` 以 `review · teamai r928e2fc23ab9bd62` 出现在项目的线程列表里。它的第一条消息说明它属于哪个运行：

```text
This thread runs step "review" of teamai workflow run r928e2fc23ab9bd62 (attempt a96c8bc03). It was started from
the T3 thread t3-thread://v2/88e28b29-…/thread-… . Work only in this worktree. Do not run teamai workflow commands:
teamai commits, pushes and reports the step itself.

Read README.md. Count its markdown sections …

Write the workflow result as JSON to ~/.teamai/projects/…/attempts/a96c8bc03/out/result.json. …
```

在这次运行里，Claude 读了 README，运行了 `grep -c '^#' README.md`，创建了结果目录并写入结果文件，全程没有询问。大约 20 秒后步骤结束：

```text
{"data":{"done":{"run":"r928e2fc23ab9bd62","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

步骤运行时，`teamai dashboard` 的运行详情会链接它的线程（`t3-thread://…`），并显示线程 id 和模型。步骤的结果收集完成后，teamai 会把线程标记为已处理（settle），它就离开你的活动线程列表。步骤失败的线程会留在活动列表里，让你看到它。

## 步骤线程会问你多少

步骤线程是独立的线程，所以只有你能回应它的请求。它总是以下表中的某个模式运行，从不沿用你启动运行时所在线程的模式，也从不使用 Full access：

| 模式 | 你在线程里看到什么 |
| --- | --- |
| Auto（默认） | 提供方自己的审查会批准常规操作，比如读文件、在 worktree 里编辑和普通命令；其余的会问你。没有自动审查的提供方什么都会问，和 Supervised 一样。 |
| Auto-accept edits | worktree 内的编辑直接通过。每条命令都等你批准，写结果文件也是。 |
| Supervised | 每条命令和每次编辑都等你批准，包括写结果文件。 |

在你的机器上，teamai 允许 Claude 不经询问写入步骤的结果文件。T3 线程得不到这样的授权，因为 T3 没有办法传递它。结果文件在 worktree 之外，所以在 Auto-accept edits 和 Supervised 下，线程会为写入它询问一次（"Path is outside allowed working directories"）。批准这次写入，步骤就会结束。

同一个 README 评审在 Auto 下什么都没问。在 Supervised 下问了两次，一次是创建结果目录，一次是写结果文件，步骤用了 9 分钟，因为请求一直在等人批准。

要让这台机器上的每个步骤线程问得更多，设置 `runtime_mode`：

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          runtime_mode: approval-required   # or auto-accept-edits
```

`runtime_mode` 只能收紧模式。其他值在调用 T3 之前就会失败：

```text
{"error":{"code":"bad_option","message":"Runtime \"t3\" of driver definition …/drivers/teamai-t3.yaml refused option \"runtime_mode\": runtime_mode \"full-access\" is not one runtime t3 takes. A step thread runs in auto, T3's Auto mode; runtime_mode only tightens it, to auto-accept-edits or approval-required. Remove it, or set one of those two. Fix the option and start again."}}
```

如果你批准 teamai 时选的权限比模式窄，比如 Supervised，T3 会拒绝创建线程，步骤失败：

```text
✖ Step "review" failed with runtime_failed: The step runtime could not run the prompt (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode, because teamai's sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json, start the workflow again, and approve teamai with Auto access or broader. Or set runtime_mode to a mode the sign-in allows.
```

## 选择提供方实例和模型

可用的工具是此刻能运行的 T3 提供方实例：Claude 在 `claudeAgent` 实例上，Codex 在 `codex` 上。要让所有提示词都在某一个实例上运行，比如第二个 Claude 账号，在你机器的配置里写上它：

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          instance: claude-work      # the id in T3 Settings → Providers
          max_parallel: 2
```

步骤的 `model: { name, effort }` 选择模型，`effort` 会变成该实例对应的选项（Claude 是 `effort`，Codex 是 `reasoningEffort`）。没有写模型的步骤使用实例列出的第一个模型。实例无法运行的内容会在任何线程启动之前失败：

```text
✖ Step "review" failed with model_unavailable: T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.
```

## 只用 T3 为一次 pass 评分

T3 也能当评审。机器上只有 T3、没有任何 agent CLI 的成员，也能运行带[评分器](scorers.md#为步骤评分)的工作流并给每次 pass 打标签，只要驱动定义里只列出 `t3`：

```yaml
# .teamai/drivers/t3only.yaml
schemaVersion: v1alpha1
name: t3only
tool: claude
runtimes:
  - use: t3
    options: { environment: local }
```

```yaml
# .teamai/workflows/readme-test-section.yaml
schemaVersion: v1alpha1
name: readme-test-section
description: Add a Test section to the README.
steps:
  - id: write
    workspace: new
    model: claude-haiku-5-5
    prompt: Add a "## Test" section to README.md that says to run `npm test` before opening a pull request. Change no other file.
    scorers: { names: [review-quality], sampling: all }
```

`review-quality` 是[评分器](scorers.md)页面里的评分器。`sampling: all` 会评审每次 pass，不管它的 `samplingRate` 是多少。

```text
$ command -v claude codex codebuddy opencode
[exit 1: none found]
$ teamai workflow start readme-test-section --driver t3only
ℹ run:r943880abc4705751:write:1: review-quality good (teamai-score run rdecc208adbba4b79).
{"data":{"done":{"run":"r943880abc4705751","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`write` 和上文一样作为项目里的线程运行。teamai 自己的评分命令（evidence、label、write）在这台机器上运行，不需要 agent。评审作为第二个线程 `score[0].judge · teamai rdecc208adbba4b79` 运行，出现在 T3 的 **No project** 下：

- 它是一个独立的新线程，在一个新的 scratch 文件夹（`~/.t3/scratch/…`）里。teamai 把评审要读的证据（会话记录、diff、`evidence.json`）复制进这个文件夹，并把副本设为只读。
- 它的第一条消息要求它只读这个文件夹，给出回复的 JSON Schema，并把 teamai 提示词里每处提到证据目录的地方都指向副本。
- 它的最后一条消息就是回复：`{"answer":{"label":"good","reasoning":"The step asked for a \"## Test\" section … diff.patch adds exactly that …"}}`。
- 它和步骤线程一样以 Auto 运行，或者以你收紧的 `runtime_mode` 运行。读到回复后 teamai 会把线程标为已处理（settle），并在评审的位置关闭时删除副本。

T3 评审的[隔离级别](scorers.md#隔离)是 **best-effort**：

| 它能保证的 | 它不能保证的 |
| --- | --- |
| agent 在副本里工作，所以改不了 teamai 用来打标签的证据。 | agent 的工具仍然在你的机器上、用你的文件运行。只有第一条消息的要求让它不去读文件夹之外的内容，而 Auto 会批准常规的读取。 |
| 副本是只读的，也不包含可能指向外部的符号链接。 | 它不切断网络。 |
| teamai 会在标签的运行里记录 `best-effort` 和 `read` 访问权限。 | 带 `isolation: verified` 的评分器会等待能达到该级别的运行时（比如 sandbox 运行时），不会在这里被评审。 |

## 无人值守运行

在 CI 中，或在 `TEAMAI_MODE=unattended` 的运行中，没人能批准登录或工具请求。无人值守运行复用有人值守运行保存的凭据，没有凭据时立即失败：

```text
{"error":{"code":"runtime_failed","message":"Runtime \"t3\" of driver \"teamai-t3\" did not start (login_required): teamai has no valid T3 Code sign-in for http://127.0.0.1:3773, and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again."}}
```

无人值守运行的线程仍以 Auto 或你的 `runtime_mode` 运行。agent 仍然请求审批的步骤会被停止，并以 `tool_failed` 失败，消息里写明线程。交互式步骤只在有人值守运行中运行。

## 重启、取消和重试

步骤的线程在 T3 里，不在 teamai 的进程里。如果驱动进程退出，`teamai workflow resume <run> --driver t3` 会重新连接到同一个线程，而不是再启动一个。`teamai workflow cancel <run>` 像线程的 Stop 按钮一样停止线程。线程以 interrupted 结束，留在你的活动线程列表里，它正在等待的请求会被撤回。

```sh
teamai workflow resume r928e2fc23ab9bd62 --driver t3
teamai workflow cancel r70d31098c8884803
```

## 交互式步骤

`interactive: true` 的提示词步骤会打开一个由你在其中工作的线程。线程被告知只有在你说步骤完成后才写结果文件，所以线程在你两次发言之间空闲时，步骤不会结束。在它结束之前，运行中的其他步骤都不会开始。

## 启动不了时

| 你看到的 | 原因 | 怎么做 |
| --- | --- | --- |
| `T3 Code is not running on this machine.` | 这里没有 T3 服务。teamai 读取 `~/.t3/userdata/server-runtime.json`，或 `$T3CODE_HOME/userdata/…` | 打开 T3 Code，然后重新运行。 |
| `… (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode …` | 你批准 teamai 时选的权限比线程运行的模式窄。 | 删除 `~/.teamai/runtime-state/t3/credentials.json`，重新运行，并用 Auto 权限批准。或者设置 `runtime_mode`。 |
| `… is not a project in T3 Code <machine>.` | 这个检出不是 T3 项目。 | 在 T3 Code 里添加它（Add project），或运行 `t3 project add <path>`。 |
| `T3 Code has no provider instance "claude-sandbox".` | `instance` 指向 T3 没有的实例，或一个已禁用的实例。 | 在 T3 Code 的 Settings → Providers 里添加或启用它，或者删掉 `instance`。 |
| `… ended without writing the result file …` | agent 结束了，但没有写结果。 | 用消息里的链接打开线程，然后运行 `teamai workflow retry <run> <step>`。 |
| 运行详情里的 `Not closed: thread_still_runs …` | teamai 关闭步骤的位置时，它的线程仍在运行，而 T3 没有停止这个线程。 | 用链接打开线程，用它的 Stop 按钮停止它。 |
| `… kept no session for …` | 工具没有为这个 worktree 保存会话记录，所以步骤无法评分。 | 检查实例是否使用工具的默认目录（`~/.claude`、`~/.codex`）。 |

## 目前还不支持

- 步骤的线程是独立的线程，不是启动运行的那个线程的子线程。T3 只为在另一个已链接环境上创建的线程保留父线程链接。
- 它不接受 `credentials`。线程的工具在 T3 Code 的环境中、用 T3 Code 自己的登录运行，所以 teamai 会在任何步骤运行之前拒绝为这个运行时配置的凭据：`NAME: env:VAR` 的提示是 `t3 does not offer can.env, so it cannot keep a credential to the processes it is for`，`<tool>: login` 的提示是 `t3 launches agents its own way, in each tool's own home, so it brings no login`。
- 带 `session: continue` 或 `session.from` 的步骤会开始一段新的对话，和 OpenCode 一样：T3 无法在已有会话上启动线程。
- 它支持 `workspace: new` 和 `continue`。只读的提示词步骤，或带 `env` 或 `setup` 的步骤，会交给 `local`。
- T3 不报告 token 用量，所以这里无法检查以 token 计的 `budget`，也无法限制 `max_turns`。
- 不提供 `permissions: unattended` 的步骤。它们需要一个工具在沙箱中运行的线程，后续版本会加入。
