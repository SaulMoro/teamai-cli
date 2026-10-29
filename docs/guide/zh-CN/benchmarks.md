# Benchmark

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

```text
teamai workflow start fix-auth --benchmark --driver local --sandbox
```

benchmark 套件用团队自己的任务比较工具或模型。一次运行把每个任务交给每个 arm 各做几次，检查每个结果，然后打印表格。trial 只在声明为 sandbox 的机器上运行，例如 CI runner 或容器。

## 编写套件

套件是团队仓库里的一个目录：`benchmarks/<suite>/suite.yaml`，以及 `tasks/` 里每个任务一个文件。

```yaml
# benchmarks/fix-auth/suite.yaml
schemaVersion: v1alpha1
name: fix-auth
description: Fix bugs in the auth service.
repo: https://github.com/acme/auth-service.git
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
  - name: strong
    model: strong
repetitions: 3
timeout: 45m
setup:
  command: npm ci
```

| 键 | 值 |
| --- | --- |
| `repo` | 任务所基于的项目：不带凭据的 https、ssh 或 git URL。 |
| `defaults` | 其他 arm 用来对比的那个 arm：`tool`，以及可选的 `model` 和 `team`。它不是工作流的 `defaults`。 |
| `arms` | 1 到 6 个。每个最多改变一个 `defaults` 键，最多只有一个什么都不改。 |
| `matrix` | 代替 `arms`：teamai 把这些值列表交叉组合成 arm。见[用 matrix 交叉工具和团队资产](#用-matrix-交叉工具和团队资产)。 |
| `team` | arm 运行时使用的团队资产。见[使用其他团队资产的 arm](#使用其他团队资产的-arm)。 |
| `model` | `models/aliases.yaml` 里的模型别名（运行启动时按每个 arm 的工具解析），或一个模型名。 |
| `repetitions` | 1 到 10，默认 3。 |
| `timeout` | 必填：整个运行的超时。 |
| `trial` | 可选：每个 trial 的 prompt 的限制。见 [trial 限制](#trial-限制)。 |
| `setup` | 可选，即[工作流的 `setup`](workflow-advanced.md#要求和限制)。在每个全新克隆中、工具或 check 之前运行。 |
| `scorers` | 可选，评判每个 trial 的[评分器](scorers.md)。没有有效 `scorers/<name>.md` 的名字会让 `teamai review --branch` 失败，`teamai pull` 会警告，start 会拒绝该套件。 |

### 使用其他团队资产的 arm

arm 默认使用本检出目录 pull 到的团队修订，除非它设置了 `team`。可以用它衡量团队资产带来了多少提升、合并前的某个分支，或某一个 skill：

```yaml
defaults:
  tool: claude
arms:
  - name: pulled              # 你 pull 到的修订
  - name: bare
    team: none                # 完全不带团队资产
  - name: next
    team: next                # 团队仓库的 next 分支
  - name: no-auth-tokens
    team:
      without: [auth-tokens]  # pull 到的修订，去掉这个 skill
```

| `team` | arm 运行时使用 |
| --- | --- |
| `pulled`，或不写 `team` | 本检出目录 pull 到的团队修订。 |
| `none` | 不带团队资产。如果本机 user 范围的 teamai 安装会把资产交付给该 arm 的工具，start 会拒绝它，因为它的 trial 会读到你 home 目录里的这些资产。 |
| 分支、tag 或提交 | 团队仓库的该修订，在运行启动时解析。分支按团队仓库里的名字写，例如 `next`，而不是 `origin/next`。 |
| `without: [<skill>, ...]` | pull 到的修订，去掉这些 skill。每个都必须是该修订中的 skill。 |

### 用 matrix 交叉工具和团队资产

`matrix` 为其值的每种组合生成一个 arm，因此任意两个只差一个值的 arm 只比较这一个值。下面这个例子同时回答：团队资产对每个工具帮助多大，以及带上资产后哪个工具更好：

```yaml
defaults:
  tool: claude
matrix:
  tool: [claude, codex]
  team: [pulled, none]
```

| Arm | 工具 | 团队 |
| --- | --- | --- |
| `claude-pulled` | claude | pulled |
| `claude-none` | claude | none |
| `codex-pulled` | codex | pulled |
| `codex-none` | codex | none |

matrix 可以变化 `tool`、`model` 或 `team`，其中至少一个要有两个或更多值，并生成 2 到 12 个 arm。它没写的键取自 `defaults`。每个 arm 的名字由各个变化键的值拼接而成：ref 原样使用，字母、数字、`-`、`_` 以外的字符写成 `-`，`without: [auth-tokens]` 写成 `without-auth-tokens`。一个套件只能有 `arms` 或 `matrix` 之一。

任务从 `repo` 的一个完整提交开始，并且恰好由 `check` 和 `successCriteria` 之一判定：

```yaml
# benchmarks/fix-auth/tasks/expired-token.yaml
schemaVersion: v1alpha1
title: Reject expired refresh tokens
prompt: |
  Refresh tokens past their expiry are still accepted. Fix it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add: [test/auth/refresh.test.ts]
source: { platform: claude-code, sessionId: 7c1e2b9a, fix: 9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e }
```

```yaml
# benchmarks/fix-auth/tasks/login-copy.yaml
schemaVersion: v1alpha1
title: Clearer login error
prompt: Make the login error say which field is wrong.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
successCriteria: The error names the wrong field and still reveals nothing about which accounts exist.
```

| 键 | 值 |
| --- | --- |
| `startingCommit` | 任务开始时 `repo` 的完整提交。 |
| `check` | `run`：任务完成后以 0 退出的命令；`protect`：agent 不能提供的路径。 |
| `check.add` | 可选：check 之前写入、agent 永远拿不到的文件：按 `source.fix` 中的样子写入的文件，例如修复的测试；或者 `{ from, to }`，套件目录中的一个文件或目录。目录会加入其下的所有文件，但不包括以点开头的条目，例如 `.DS_Store`；要加入点文件，在 `from` 中直接指明它。见[修复带来的测试](#修复带来的测试)和[套件目录中的测试](#套件目录中的测试)。 |
| `successCriteria` | 代替 `check`：由评判器按这些标准判定。 |
| `source` | 可选：任务来自的会话，`platform` 和 `sessionId`，以及 `fix`，即在那里修复它的完整提交，[`--try`](#试运行任务) 会检查它。 |

`teamai pull` 和 `teamai review --branch` 检查每个文件，并带文件和行号报告每个问题。`benchmarks/<namespace>/<suite>/` 下的套件只发给该角色或项目的成员，见[角色和项目](distribution.md#角色和项目)。

### `protect` 要覆盖什么

agent 完成工作后 check 以 0 退出，trial 就通过。check 之前，teamai 把每个 `protect` 路径恢复成起始提交里的样子：

```text
the agent left                       the check sees
src/auth/refresh.ts       edited     edited
test/auth/session.test.ts edited     as 3f2c9a7 has it
test/helpers/skip.js      added      deleted
vitest.config.ts          edited     as 3f2c9a7 has it
```

所以 `protect` 要列出 check 读取、而 agent 不能提供的一切：测试、测试配置、它们加载的脚本和辅助文件，以及包清单和锁文件。

| 不要保护 | 原因 |
| --- | --- |
| `setup` 写入的路径，例如构建目录 | 恢复会删除 setup 写在那里的内容。 |
| git 检出时会转换的文件：Git LFS 文件、带 `eol=crlf` 属性的文件 | 每个受保护文件都必须与起始提交存储的字节完全一致，所以 trial 的结果是 `error`。 |
| 子模块内部或其下的路径 | teamai 无法恢复子模块里的文件，所以 trial 的结果是 `error`。 |

check 读取的内容无法一一列出的任务，应改用 `successCriteria`。

### 修复带来的测试

如果证明修复的测试是修复本身带来的，把这个测试文件列进 `check.add`；修复只是在起始提交已有的文件里加了一个用例时也一样。check 读到的是 `source.fix` 中的版本，agent 永远看不到：

```text
step                          test/auth/refresh.test.ts
the agent's clone             absent
trial check                   protect restored, then written from 9a1d4e7
baseline at 3f2c9a7           written from 9a1d4e7 before setup: the check must fail
--try at 3f2c9a7              written from 9a1d4e7: the check must fail
--try at 9a1d4e7              protect restored, then written from 9a1d4e7: the check must pass
```

| `teamai pull` 和 `teamai review --branch` 拒绝 | 原因 |
| --- | --- |
| 没有 `source.fix` 的 `check.add` | 这些文件来自 `source.fix`。 |
| 没有任何 `protect` 条目匹配的 `check.add` 路径 | agent 可以自己提供它。 |
| `check.add` 里的通配符 | 每一项都只指明一个文件。 |

### 套件目录中的测试

任务的提交里没有的测试，例如你专门为任务写的测试，可以放在套件目录中。`check.add` 的 `{ from, to }` 条目把它写到 check 读取的位置，写入的时机和修复的测试相同；agent 永远拿不到它：

```text
benchmarks/fix-auth/
  suite.yaml
  tasks/expired-token.yaml
  check-files/expired-token/refresh.test.ts
```

```yaml
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add:
    - from: check-files/expired-token/refresh.test.ts
      to: test/auth/refresh.test.ts
```

`from` 是套件目录中的一个文件或目录；目录会把其下的每个文件写到 `to` 之下。每个文件按字节写入，保留可执行位。`teamai pull` 把这些文件和套件一起保存，运行写入的是它启动时的版本，所以运行期间 pull 不会改变任何 check。修改其中一个文件会改变任务的 `sourceHash`。这种条目不需要 `source.fix`。

| `teamai pull` 和 `teamai review --branch` 拒绝 | 原因 |
| --- | --- |
| `from` 在套件目录中找不到、指向套件目录之外，或者是符号链接 | 只读取套件目录自己的文件。 |
| 带 `..` 或通配符的 `to` | 它只指明克隆中的一个路径。 |
| 没有任何 `protect` 条目匹配的 `to` 或其下的文件 | agent 可以自己提供它。 |
| 两个条目写同一个路径 | 每个路径只写一次。 |

### 基线

在任务的第一个 trial 之前，teamai 在起始提交的全新克隆上运行一次 setup 和 check：

| check 在起始提交上 | 任务 |
| --- | --- |
| 失败 | 有效：它的 trial 会运行。 |
| 通过 | `invalid: check passes without changes`，不运行 trial。 |
| 无法运行 | `check could not run`，不运行 trial。 |

| check 无法运行的情况 | 记为 |
| --- | --- |
| 以 127 退出 | `not_found` |
| 以 126 退出 | `not_executable` |
| 在 Windows 以外以 129 到 192 退出 | `signal`：shell 把被信号杀死的命令报告为 128 加上信号编号。不要把它们用作 check 自己的失败退出码。 |
| 运行超过超时时间 | `timeout` |

prompt 之后无法运行的 check 让 trial 得到 `error`，而不是 `failed`。

### trial 限制

`trial` 限制每个 trial 的 prompt。达到限制会结束智能体的这一轮，teamai 随后在智能体留下的结果上运行 trial 的 check 或评判，所以用完时间的工具算作任务失败，而不是测试框架出错：

```yaml
timeout: 45m
trial:
  timeout: 8m
  budget: { tokens: 300000 }
  max_turns: 60
```

| 键 | 限制 | 在本地驱动上 |
| --- | --- | --- |
| `timeout` | 从工具启动起的时间。要短于套件的 `timeout`，后者仍然结束整个运行。 | 停止工具及其启动的每个进程。 |
| `budget.tokens` | 输入加输出 token，按 [工作流预算](workflow-advanced.md#要求和限制)的方式计算。 | 在工具运行时从其输出中计数，超过预算后停止工具，所以 trial 可能多出最后一次模型调用。Codex 只在结束时给出 token，CodeBuddy 的 token 不会在运行时计数：两者都会运行到结束，并在 `unenforced` 中列出 `budget`。不报告 token 的工具会让其 trial 以 `error` 结束，除非另一个限制先停止了它：这时该 trial 会在 `unenforced` 中列出 `budget`。 |
| `max_turns` | 智能体轮数，按工具自己的计数。 | 传给 Claude。其他工具在 `unenforced` 中列出 `max_turns`。 |

被限制停止的 trial 在记录中带 `limit`，并计入 “Stopped by a limit”。在 `unenforced` 中列出套件限制的 trial 算作偏差，所以有上限的 arm 不会被悄悄地与没有上限的 arm 比较。运行保持它启动时的限制。

## 试运行任务

新任务文件加入套件之前，可以先试运行。在套件 `repo` 的检出目录中运行，团队仓库检出在旁边：

```console
$ teamai workflow start fix-auth --benchmark --try ../team/benchmarks/fix-auth/tasks/expired-token.yaml --driver local --sandbox
ℹ Task expired-token: trying the check at 3f2c9a7
ℹ Task expired-token: trying the check at the fix 9a1d4e7, with the protected paths as 3f2c9a7 has them
{"data":{"try":{"task":"expired-token","message":"Task \"expired-token\": the check fails at 3f2c9a7 and passes at the fix 9a1d4e7, with the protected paths as 3f2c9a7 has them."}}}
```

```text
task           at startingCommit      at source.fix (protect restored)   exit
pod-startup    check fails            check passes                       0
old-bug        check passes           not tried                          1: "check passes without changes at 3f2c9a7"
bad-fix        check fails            check fails                        1: "check fails at the fix 9a1d4e7"
test-in-fix    check fails            check fails (fix's test restored)  1: "The fix changes test/startup.test.ts, which protect puts back as 3f2c9a7 has them: list a test the fix brought in check.add"
changed-test   check fails            check passes (check.add written)   0
add-missing    not tried              not tried                          1: "test/missing.test.ts is not a file at the fix 9a1d4e7"
no-fix         check fails            not tried                          0: "the check was not tried on a fix"
criteria-only  no check               no check                           0: "there is no check to try"
missing-tool   could not run          not tried                          1: names the command and 3f2c9a7
setup-error    setup failed           not tried                          1: names setup and 3f2c9a7
```

`--try` 按原样读取任务文件及其上两级目录中的 `suite.yaml`，像 `teamai pull` 一样校验两者（连同其 `check.add` 条目从该套件目录指明的文件），并检查 `<suite>` 就是该套件的 `name`。它不需要 `teamai init`。检出目录缺少的提交会像运行时一样，按 SHA 从套件的 `repo` 获取。每个提交都有一个全新克隆、套件的 `setup`、trial 得到的环境（见[运行套件](#运行套件)），以及套件的 `timeout`。它不创建运行，也不写记录；因为 check 会运行项目代码，它需要 `--sandbox`。

## 运行套件

```console
$ teamai workflow start fix-auth --benchmark --driver local --sandbox
ℹ Run r38302f8e6a18c377 started. If it stops before it ends, continue it with: teamai workflow resume r38302f8e6a18c377 --sandbox
ℹ Baseline expired-token: check fails on the starting commit, as the task expects
ℹ Trial 1/9 expired-token claude: preparing
ℹ Trial 1/9 expired-token claude: running claude
```

| 选项或配置 | 效果 |
| --- | --- |
| `--sandbox` | 只为当前这个进程把本机声明为 sandbox。只在可以丢弃的机器上使用。 |
| 配置里的 `workflows.sandbox: true` | 为每个进程声明它，见[要求和限制](workflow-advanced.md#要求和限制)。 |
| 两者都没有 | 每个 trial 都是 `not_run`，运行会说明原因。 |
| `--member-aliases` | 你自己的 `~/.teamai/models/aliases.yaml` 优先于团队的 `models/aliases.yaml`，表格会把由你的文件决定的模型的来源显示为 `member`。 |

| trial 得到 | |
| --- | --- |
| 起始提交的全新克隆 | 没有远程仓库。你的检出目录从不被改动。 |
| 团队资产和套件 | 来自本检出目录上次 pull 到的团队修订（该修订必须已推送），或来自 arm 的 `team`。启动时冻结：运行期间 pull 不会改变它运行的任何内容。 |
| 环境 | 去掉 `GITHUB_TOKEN`、`GH_TOKEN`、`GITLAB_TOKEN`、`GL_TOKEN`、`CI_JOB_TOKEN`、`SSH_AUTH_SOCK`、`GIT_ASKPASS` 和 `SSH_ASKPASS`。 |
| 你的主目录 | 保持原样：teamai 去不掉其中的登录信息、MCP 服务器和插件。 |
| 本机上的团队仓库 | 保持原样：你的团队检出目录，以及每个 trial 克隆旁边用来安装其团队资产的那份团队修订副本，都包含 `benchmarks/`，check 文件也在其中。在本机上搜索的 agent 能找到它们。 |

本地驱动一次运行一个 trial：全新克隆、团队资产、setup、用 prompt 启动 arm 的工具，然后运行 check。

| | |
| --- | --- |
| 工具 | 它能运行 `claude`、`codex` 和 `opencode`。安装 arm 用到的每个工具并登录。找不到工具的 arm，它的 trial 为 `not_run`，其他 arm 照常运行。 |
| 超时 | 套件的 `timeout` 是整个运行的超时。setup、工具和 check 到时都会停止：它们所属的 trial 记为 `error`，仍未完成的 trial 结算为 `not_run`。让它低于 CI 任务的时限，否则任务会在打印表格之前被杀掉。 |
| 卡住的 trial | 没有 [`trial.timeout`](#trial-限制) 时，一个永不返回的工具会一直运行到套件超时，它之后的每个 trial 结算为 `not_run`。 |
| 评判 | 带 `successCriteria` 的任务和套件的评分器在运行结束前评判，评判在运行了 trial 的那个安装上进行。机器无法评判时，需要评判的套件在启动时被拒绝。 |
| 控制命令 | trial 的步骤要等每个任务的基线都结算后才存在。在此之前，对 trial 步骤执行 `teamai workflow cancel <run> <step>` 会返回 `step_not_found`。`workflow retry`、`publish` 和 `--claim` 拒绝 benchmark 运行。 |
| 停下 | 用 `teamai workflow resume <run> --sandbox` 继续。 |

无法运行的启动会被拒绝，消息说明该怎么做，并且不会创建运行。

## 结果

运行结束时，本地驱动把结果打印到 stderr。stdout 上的 JSON 返回在 `data.done.benchmark.text` 中带同样的文本，在 `data.done.benchmark.table` 中带数字。对这个套件，再加一个 check 本来就通过的第三个任务 `old-bug`：

```text
| Arm | Tool | Model (source) | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | claude | tool default (team) | 9 | 4 | 2 | 0 | 0 | 3 | 0 | 0 | 0 | 44% (4/9) |
| codex | codex | tool default (team) | 9 | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 33% (3/9) |
| strong | claude | claude-opus-5-5 high (team) | 9 | 6 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 67% (6/9) |

| Arm | Median tokens (input + output) | Median duration | Cost |
| --- | --- | --- | --- |
| claude | 41200 (6) | 84.0 s (6) | 1.82 USD (6) |
| codex | 38900 (6) | 97.5 s (6) | unknown (0) |
| strong | 52300 (6) | 121.0 s (6) | 4.1 USD (6) |

| Task | claude | codex | strong |
| --- | --- | --- | --- |
| expired-token | 33% (1/3) | 33% (1/3) | 100% (3/3) |
| login-copy | 100% (3/3) | 67% (2/3) | 100% (3/3) |
| old-bug | 0% (0/3) | 0% (0/3) | 0% (0/3) |

| Task | Baseline |
| --- | --- |
| old-bug | invalid: check passes without changes |

These results hold for these tasks, this run and this machine.
```

| 表格 | 内容 |
| --- | --- |
| Arm | 按结果统计每个 arm 的 trial，以及被 [trial 限制](#trial-限制)停止的数量。偏差是 prompt 运行时的工具、团队修订或模型与其 arm 不同的 trial，或者其 driver 无法执行某个 trial 限制的 trial。记录缺少其中某个值的 trial 为未验证。有 arm 使用 pull 到的修订以外的团队资产时，Team 列显示每个 arm 的团队资产，例如 `pulled 3f9c2ab`、`next 81d0e4c`、`3f9c2ab without auth-tokens` 或 `none`。 |
| 用量 | 每个 arm 的中位数和成本合计，并注明各自用了多少个 trial。token 和成本只按工具自己声明的显示，所以不声明的工具显示 `unknown (0)`。 |
| 任务 | 每个任务在每个 arm 上的通过率。 |
| 基线 | 没有运行的任务及原因。 |

结果不是运行的状态：所有 trial 都失败的运行仍然成功。运行只在超时或被取消时失败。

只有要发布结果时才需要[使用统计上报](reporting.md)。开启时，运行的结束记录连同 `benchmark` 字段会写到团队仓库的 `teamai-reports` 分支，所以任务的 token 还需要团队仓库的推送权限。[运行记录](workflow.md#运行记录)列出记录的字段，并给出只从记录算出每个 arm 通过率的 `jq` 命令。关闭时，表格仍在返回中。Dashboard 的[基准测试页面](dashboard.md#基准测试benchmarks)按时间画出已发布的运行和本机的运行。

## 在 CI 中运行

GitHub Actions 任务：

```yaml
on: workflow_dispatch
jobs:
  benchmark:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ secrets.TEAM_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @anthropic-ai/claude-code
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
      - run: npx teamai-cli pull
      - run: npx teamai-cli workflow start fix-auth --benchmark --driver local --sandbox > done.json
      - if: always()
        run: jq -r '.data.done.benchmark.text // empty' done.json >> "$GITHUB_STEP_SUMMARY"
```

- `TEAM_TOKEN` 读取团队仓库，并在使用统计上报开启时推送到团队仓库。
- `--agent claude` 为 Claude Code 设置 teamai，全新的 runner 还从未运行过它。
- 套件 `repo` 的检出带完整历史，所以每个任务的起始提交都在。
- 最后一步把结果写进任务摘要，运行失败时也会写。

GitLab CI 任务：

```yaml
benchmark:
  image: node:22
  timeout: 1h
  when: manual
  script:
    - npm install -g @anthropic-ai/claude-code
    - npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
    - npx teamai-cli pull
    - npx teamai-cli workflow start fix-auth --benchmark --driver local --sandbox > done.json
  artifacts:
    when: always
    paths: [done.json]
```

把 `TEAM_REPO`、`GITLAB_TOKEN`（读取团队仓库）和 `ANTHROPIC_API_KEY` 设为 masked CI/CD 变量。任务日志会显示结果，`done.json` 会保存结果。换成别的工具时，同样安装它并设置它的密钥：每个 arm 的工具都必须在 runner 上。

## 在自己的驱动里运行

任何驱动都通过 `workflow next` 和 `workflow report` 运行 trial，见[在自己的驱动里运行 benchmark trial](workflow-advanced.md#在自己的驱动里运行-benchmark-trial)：

```text
teamai workflow next <run> --prepare --json '{"driver":{..., "can":{"isolation":"sandbox","trials":["claude"]}}}'
  -> { data: { lease: { cwd, trial: { tool, model, effort, limits }, envScope: { withhold }, env, ... } } }
launch trial.tool in cwd, on the prompt, with that model and effort, without the withheld variables, with env
teamai workflow report <run> --json '{..., "tool":"claude", "durationMs":84000, "cost":{"amount":0.31,"unit":"USD"}}'
```

| | |
| --- | --- |
| `driver.can` | 每次 `next` 都带：`isolation: "sandbox"`，并在 `trials` 中列出它启动的工具。 |
| `--prepare` | teamai 创建克隆、安装团队资产并运行 setup，然后返回带 `cwd` 的租约。 |
| `report` | `tool`、只围绕工具启动测得的 `durationMs`，以及仅在工具给出时才带的 `cost`。 |
| 限制 | 让工具遵守 `trial.limits`。某个限制停止了工具时，报告 `outcome: "success"` 并带 `limit`：`timeout`、`budget` 或 `max_turns`；无法让工具遵守的 `budget` 或 `max_turns` 列在 `unenforced` 中。 |
| 阻塞 | 第一次 `next --prepare` 会运行每个任务的基线，之后的调用会先运行一个 trial 的 check 再返回，所以一次调用可能要几分钟。如果你的宿主会给 CLI 调用设超时，要留出套件 setup 和 check 的时间。 |
| 中断 | 被中断的 `next --prepare` 会让该步骤仍租给这个驱动：再次调用，teamai 会重新准备。 |
| 评判 | 所有 trial 都结算后，`next` 返回带 `judging` 的 `wait`，直到评判完成：在运行了 trial 的那个安装上运行 `teamai score --next`。 |
