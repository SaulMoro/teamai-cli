# 基础 Harness

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

## Skills

```bash
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: 帮助团队部署服务
---
# Deploy Helper
当用户请求部署时，按以下步骤执行：
1. 检查当前分支是否为 master
2. 运行测试 `npm test`
3. 构建 `npm run build`
4. 部署 `./deploy.sh`
EOF

teamai push
teamai push --role pm
```

没有 frontmatter 时，`push` 会补上 `name` 和 `description`。新 skill 写到你的角色或当前项目给出的 `skills/<ns>/<name>/`。有多个时会问。`--role` 指定一个。

## Rules

```bash
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# 代码审查规范
- 所有函数必须有 JSDoc 注释
- 禁止使用 `any` 类型
EOF

teamai push
```

成员不能删的 rule，写在 `teamai.yaml`：

```yaml
sharing:
  rules:
    enforced: [code-review-guide]
```

你自己的 rule 会留下。`push` 只把已有团队 rule 的正文写回仓库。

## Agents

`agents/<name>.yaml`。`name` 与文件名一致。自己 commit，或在工具里改完后 `teamai push`。

```yaml
# agents/code-reviewer.yaml
name: code-reviewer
description: Review a change before it is pushed
instructions: |
  Read the diff and comment on correctness, tests, and risks.
tools: [Read, Grep]
targets: [claude, cursor]
```

`targets` 不写就发给所有已安装的工具。只给一个角色时放到 `agents/<namespace>/`，并在 `resources.agents` 里声明。

```bash
teamai push
teamai push --role frontend
teamai remove agents code-reviewer
```

`pull` 按工具自己的格式写入它的 agents 目录：Codex 系列是 `<name>.toml`，Copilot 是 `<name>.agent.md`，Kiro 是 `<name>.json`，其余是 `<name>.md`。

### 模型别名

`model: strong` 这类名字在 `models/aliases.yaml` 里按工具对应到具体模型：

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
  fast:
    claude: haiku
```

别名以小写字母开头，后面可以是小写字母、数字或 `-`。某个 namespace 要换一套时，写 `models/<ns>/aliases.yaml`。

## Env、hooks 与 MCP server 按 namespace 划分

根目录的文件给所有人。`resources:` 里声明的 namespace 只给激活了它的成员，并替换根目录里的同名条目。

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml
```

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env: [checkout]
      hooks: [checkout]
      mcp: [checkout]
```

## Env（环境变量）

```bash
teamai env add API_ENDPOINT https://api.example.com --description "团队 API 地址"
teamai env add API_ENDPOINT https://checkout.internal --project checkout
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai push
```

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: 团队 API 地址
```

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
    url: https://github.com/settings/tokens
```

密钥的值不进仓库。每人在自己机器上：

```bash
teamai env set GITHUB_TOKEN
teamai env exec -- gh pr create
```

### 按目录加载 Shell 环境变量

团队环境变量按目录进入 shell：在某个目录中启动的 shell 获得管辖该目录的 scope 的环境变量，因此同时打开的多个项目各自拿到自己的。shell 配置文件里只有一个 teamai 区块，所有 scope 共用，它 source `~/.teamai/env-loader.sh`。每次项目 pull 都会把该 scope 及其机器数据分区登记到 `~/.teamai/env-scopes`，以检出与其 worktree 共享的 git 目录为键（不在 git 中时以目录本身为键），loader 在其中查找 shell 所在的目录：

- 在项目中，加载该项目的 `env.sh`，不加载用户级 scope 的任何内容，除非项目设置了 `inheritUserScope: true`：此时先加载用户级 scope 的变量，项目声明的键（无论是变量还是密钥）以项目为准（项目密钥没有值时保持未设置，不会取用户级 scope 的值）；用户级 scope 的密钥始终不会加载；
- 在关联的 worktree 中，即使该 worktree 尚未 pull，也加载其所属项目的；
- 尚未被任何 pull 登记的项目，只要 teamai 已在其中完成设置、迁移或开始过 pull，什么都不加载；
- 其他位置，加载用户级 scope 的；
- 目录本身或其上层有 `.git`，但 git 无法读取该仓库（未安装 git、`.git` 损坏、元数据无法读取、`safe.directory` 拒绝）时，什么都不加载：无法判断哪个 scope 管辖它。`env exec` 在这里同样不应用团队环境变量，并说明原因；未安装 git 时，不在任何仓库中的目录仍加载用户级 scope 的。

用户级 scope 的团队设置了 `injectShellProfile: false` 时，它的 `env.sh` 在任何位置都不加载，继承它的项目中也不加载。

`~/.teamai/env-scopes` 存在但无法读取（例如权限问题）时，loader 无法判断哪个 scope 管辖某个目录，因此在任何位置都不加载团队环境变量。此时 pull 会失败、指出该文件并保持其原样；uninstall 会保留它、loader 以及 `~/.teamai/projects` 下每个项目的数据。修好该文件的权限后再次运行命令即可。

项目所属团队设置了 `injectShellProfile: false` 时，项目的 `env.sh` 和继承的用户级 scope 都不会加载。

退出后，下一次 pull 还会从每个候选文件中移除旧版本写入、source 该 scope `env.sh` 的区块；对用户级 scope，也包括最早那种直接 export 变量的区块。其他 scope 的区块保留，直到那个 scope 自己 pull。

交互式 shell 在 `cd` 时切换环境变量，并在离开项目时恢复你进入项目前设置的值。loader 会先于 Bash 的 `PROMPT_COMMAND` 和 zsh 的 `chpwd_functions` 钩子更新环境，因此这些钩子（包括你在 loader 之后追加到 `PROMPT_COMMAND` 的命令）会看到当前目录对应的环境；Bash 提示符钩子仍能读取上一条命令的 `$?` 和 `PIPESTATUS`。zsh 从 `.zshenv` 读取该区块，每个 zsh 都会读取它，因此工具执行命令时用的 `zsh -c` 也能拿到所在目录的环境变量。bash 在 `bash -c` 时不读取任何启动文件，所以 loader 会把 `BASH_ENV` 指向自身，先 source 你原有的 `BASH_ENV`（运行期间 `BASH_ENV` 指向你的文件），再加载团队环境，两者设置同一个键时以团队的值为准；每个 bash 只运行你的文件一次。`teamai env exec` 启动的 `bash` 也同样先 source 你的 `BASH_ENV`，再应用团队的值。团队环境不能设置 `BASH_ENV`、`ENV`、`ZDOTDIR`、`HOME`、`PWD`、`PROMPT_COMMAND`、`BASH_VERSION`、`BASH_VERSINFO`、`ZSH_VERSION`、`PIPESTATUS`、`IFS`、Bash 只读的 `SHELLOPTS`、`BASHOPTS`、`UID`、`EUID` 和 `PPID`、zsh 钩子数组，以 `__TEAMAI_` 或 `__teamai_` 开头的名称，以及 `env.sh` 导出的 `TEAMAI_ENV_SH_<64 位十六进制>` 标记；这些名称控制 shell 启动、钩子或 loader 状态，或者 Bash 不允许设置。团队声明这些名称时，pull、`env set` 和 `env exec` 会警告，因为 TeamAI 会忽略这些值。其他 shell（fish、PowerShell）不运行 loader，未安装 bash 和 zsh 时 pull 也不会写入任何配置文件区块：需要团队环境变量的命令请通过 `teamai env exec --` 运行，它按同样的方式解析。

pull 不再为切换项目而改写 shell 配置文件。第一次用带 loader 的版本 pull 时（在没有环境变量的项目中也是如此），会在写入 loader 区块的同时，从每个候选文件中移除旧版本写入的按 scope 区块（其中任一写入失败时，pull 会把已改动的文件全部恢复原样并报告失败；同一个文件有两个名字时，例如 `.zshrc` 链接到 `.zshenv` 或 dotfiles 仓库中的文件，只改写一次，并通过链接写入，链接保持不变，链接指向的文件或目录尚不存在时也一样；恢复时只删除 pull 新建的文件及为其新建的目录，不会删除链接；已存在但无法读取的配置文件会使 pull 报错停止，而不会被覆盖）；若某个项目因此不再获得以前能拿到的用户级变量，会提示一次。

`pull` 时，若启用了 `injectShellProfile`（默认启用），`$SHELL` 为 zsh 时环境变量块会写入 `~/.zshenv`（设置了 `ZDOTDIR` 时为 `$ZDOTDIR/.zshenv`），否则写入 `~/.bashrc`——但 Windows 上例外：`$SHELL` 通常未设置，而 Git Bash 以*登录 shell*方式启动，从不读取 `.bashrc`，因此 teamai 会优先选择已存在的 `~/.bash_profile`、其次 `~/.bash_login`、再次 `~/.profile`，只有三者都不存在时才回退到 `~/.bashrc`（通过 MSYS2/Cygwin 安装、会设置 `$SHELL` 的 zsh 仍会解析到 `.zshenv`）。这与 Git for Windows 自身在 `/etc/profile.d/bash_profile.sh` 中的回退逻辑一致，其判断条件是 `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]`——只有在这一种情况下它才会生成一个会 source `.bashrc` 的 `.bash_profile`；

这也是为什么哪怕一个只 source 了其他内容（例如 `~/.local/bin/env`）的 `~/.profile` 存在，也足以让 `.bashrc` 单独失效。可通过 `teamai.yaml` 中的 `sharing.env.shellProfilePath` 覆盖 bash 的目标文件；在 Windows 以外，它只决定读取该文件的那种启动模式所用的文件，bash 的另一种模式仍按下文规则写入区块，除非其文件已经 source 了 override。对 zsh，teamai 始终把区块写入 `.zshenv`（若设置了 `$ZDOTDIR`，则写入其下的 `.zshenv`），因为 `zsh -c` 不会读取 `.zshrc`；若 override 指向其他 zsh 启动文件，会忽略并给出警告，pull 时也会把旧区块迁到 `.zshenv`。另一个 shell 的文件（`$SHELL` 为 zsh 时为上文 bash 的目标文件，为 bash 时为 `.zshenv`）也会写入区块，这样从 zsh 启动的 bash（或从 bash 启动的 zsh）同样会随目录切换环境：在 Windows 以外，该 shell 已安装（在 `PATH` 上）时 teamai 会创建该文件；否则，以及在 Windows 上，只有已存在的文件才会写入区块。`teamai uninstall` 和 `teamai doctor` 会与第一个文件一并处理它。在 Windows 以外，登录 bash（`bash -l`，或 macOS 终端）读取的是 `~/.bash_profile`、`~/.bash_login`、`~/.profile` 中第一个存在的文件，而不是 `.bashrc`，因此该文件也会写入区块，除非它已经 source 了上文的 bash 文件。若 override 指向登录文件，交互式 bash 仍读取 `.bashrc`，它也会写入区块（bash 是 `$SHELL` 或已安装时会创建），除非它已经 source 了 override。三者都不存在且 bash 是 `$SHELL` 或已安装时，teamai 会创建 `~/.profile`：它在 bash 的读取顺序中排在最后，因此之后新增的 `~/.bash_profile` 仍会生效，而读取 `.profile` 的 POSIX `sh` 会跳过该区块。teamai 不会创建 `.bash_profile` 或 `.bash_login`。

每次 pull 都会重新走一遍这个优先级判断，找到当前环境实际会读取的那个文件，然后沿着它对另外四个候选文件名的引用一路查下去——无论要经过多少跳

——寻找一个已经带着代码块的候选文件，而不是重复注入。如果链条中间经过的是这五个候选文件名之外的文件（比如某些环境会改用 `~/.config/shell/profile` 这类自定义文件来 source），这条链就不会被继续跟踪。这正是为了不让 Git for Windows 自身的引导逻辑把目标文件从脚下换掉：

上面那条 `/etc/profile.d/bash_profile.sh` 判断条件，在第一次 pull 写入 `.bashrc` 之后同样会成立，于是下一次 Git Bash 登录 shell 启动时就会自动生成一个 source 它的 `~/.bash_profile`；如果不沿着这条转发链去找，下一次 pull 就会转而偏好这个新出现的文件，在那里注入第二个代码块，而原来那个——依旧在正常工作，只是绕得更远了——则会被误报为失效的遗留代码块。同样的道理也适用于一个普通的 `.profile`：它用一条扁平的存在性守卫（`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`）为交互式 shell source `.bashrc`——这时登录 shell 最先读到的文件，离实际代码块有两跳之遥。

不过，只有两种字面写法才算真正的引用：单独一行的裸 `source X` / `. X`，或者单独一行、与 Git for Windows 自己生成的写法完全一致的自引用存在性守卫 `test -f X && . X` / `[ -f X ] && . X`（被测试路径与被 source 路径完全相同）——两种情况下 `X` 都必须是不加引号的 `~/name`，或不加引号/用双引号包裹的 `$HOME/name`（绝不是加了引号的 `~`，也绝不是用单引号包裹的 `$HOME`：shell 不会展开这两种写法，看起来对的引用实际会 source 一个不存在的字面路径）。除此之外的写法——source 本身带了重定向或额外参数、`||` 回退、不相关的 `&&` 连接命令、任何这段逻辑无法独立验证的条件

——一律不识别，直接回退到按优先级选出的文件，而不是去猜。这是刻意收窄到两种固定写法的封闭集合，而不是尝试解析任意的 shell 条件：真要匹配一个真实 shell 脚本能用来让某一行变成有条件执行（或者把可执行内容伪装成惰性文本）的所有手法，需要一个真正的 shell 解析器，任何固定规模的规则集合都不可能穷尽这件事。嵌在 `if`、`for`/`while`/`until`、`case`、`select`、函数体，或者 `(...)`/`{...}` 分组里的内容一律不算数，不管外层条件写的是什么

——这些结构要么不保证一定会执行，要么即使一定会执行（比如子 shell 或大括号分组），它导出的环境变量也传不到调用它的 shell 里，这也意味着 Debian/Ubuntu 标准模板里那种嵌套两层 `if`、沿途还检查 `$BASH_VERSION` 的写法无法被识别，会回退到按优先级选出的文件。位于无条件的顶层 `return` 或 `exit` 之后的内容同样不算数，因为控制流根本不会执行到那里。凡是这套逻辑判断不了的情况，以及当前这条链条根本没触及到的候选文件——哪怕它本身带着代码块——都绝不会因此被优先选中，否则 #682 之前旧版本留下的失效代码块就会永远压过正确的文件，等于在升级后又悄悄把 #682 引入回来。

`doctor`（以及 `pull` 结束后自动运行的检查）还会标记出旧版本遗留在候选文件中的按 scope 环境变量块——例如 #682 之前的旧版本写入 `.bashrc` 的代码块，即便该代码块本身已损坏、从未生效。下一次 pull 或 `teamai uninstall` 会清理它。`This directory resolves its team env` 会在该目录启动你的 `$SHELL`、在其中运行 loader，并检查它加载的是本 scope 的 `env.sh`；尚未被 pull 登记的项目会失败，直到你在那里 pull。若 shell 不运行 loader，该检查判定通过，doctor 会附一条说明指出这一缺口。
## Hooks

`teamai init` 会装上这些内置 hook：

| 事件 | 做什么 |
|------|--------|
| `SessionStart` | 拉取团队资源，并记下会话开始 |
| `PostToolUse` | 记录 skill 使用 |
| `UserPromptSubmit` | 记录输入 |
| `Stop` | 检查 CLI 更新，并记下会话结束 |

```bash
teamai hooks list
teamai hooks inject --dry-run
teamai hooks inject
teamai hooks remove
```

只处理已经安装的工具。

团队自己的 hook 写在 `hooks/hooks.yaml`，自己 commit。`id` 只用小写字母、数字和 `-`。`builtin` 只放在根文件里，用来关掉某条内置 hook，或改它的超时。

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: bash ~/.teamai/team-scripts/scan-secret.sh
    timeout: 15
    tools: [claude, cursor]
```

只给一个项目时写到 `hooks/<ns>/hooks.yaml`。

```yaml
sharing:
  hooks:
    autoApply: false          # pull 只提示，要自己跑 teamai hooks inject
    requireTeamScripts: true  # command 必须在 ~/.teamai/team-scripts/ 下
```

本机全部停用团队 hook：`TEAMAI_HOOKS_DISABLED=1`。

## MCP Server

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    description: GPU 存量与价格查询
    transport: http
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000
  - name: local-formatter
    transport: stdio
    command: npx
    args: ["-y", "@acme/formatter-mcp"]
    env:
      FORMATTER_MODE: strict
    requires: [npx]
    tools: [claude, cursor]
```

密钥写 `${VAR}`，并在 `env/secrets.yaml` 里声明。只给一个项目时，写到 `mcp/<ns>/mcp.yaml`。

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

## 模型

`models/models.yaml` 自己 commit。密钥留在每人自己的机器上。只给一个项目时写 `models/<ns>/models.yaml`。

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3
          - deepseek-v4-flash
```

```bash
teamai models switch tokenhub
```

## 团队包

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

pull 之后跑 `teamai packages`。

## Docs（文档）

把文件放进团队仓库的 `docs/`，提交后成员 `pull` 时同步。某个目录只给一部分人时，在 `resources.docs` 里声明：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```
