# Sandbox 运行时

`sandbox` [步骤运行时](workflow-advanced.md#驱动定义和步骤运行时)把工作流步骤的每次尝试放进一个独立的沙箱里运行：Docker Sandboxes 的微型虚拟机，或者来自团队构建的镜像的容器。Agent 只能处理该步骤的工作树，碰不到你机器上的其他内容。工具命令的构建、结果的读取、预算的计量，以及提交和推送，仍然由 teamai 在主机上完成。

这个版本支持 `sbx`（[Docker Sandboxes](#sbxdocker-sandboxes)）、`docker` 和 `podman`。它随 teamai 一起发布，可执行文件名为 `teamai-runtime-sandbox`。

## 快速开始

**1. 构建一个装好工具的镜像。** 检出的代码不会被复制进镜像：步骤运行时才挂载进去。

```dockerfile
# 放在你的基础设施仓库里的 Containerfile
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2
```

```sh
docker build -t ghcr.io/acme/agent:1 -f Containerfile .
docker push ghcr.io/acme/agent:1
```

**2. 在团队仓库里添加驱动定义**，然后推送。

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
description: Run each step in a container from the team image, on the member's Claude subscription.
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: docker                  # 或 podman
      image: ghcr.io/acme/agent:1
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

**3. 每位成员生成一次令牌。** 保存在 macOS 钥匙串里的 Claude 登录进不了容器，令牌可以。

```sh
claude setup-token                       # 为你的订阅打印一个长期有效的令牌
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…   # 写进 shell 配置文件或密钥管理工具
```

没有设置时，启动会在任何步骤运行之前停止：

```text
{"error":{"code":"credential_missing","message":"Runtime \"sandbox\" of driver definition /home/me/acme/app/.teamai/drivers/containers.yaml declares credential CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN, and CLAUDE_CODE_OAUTH_TOKEN is not set in your environment. Set CLAUDE_CODE_OAUTH_TOKEN, then start again."}}
```

**4. 用它运行工作流。**

```sh
teamai pull
teamai workflow start review --driver containers
```

```text
ℹ Run r7c41d09e2b6a5f13 started. If it stops before it ends, continue it with: teamai workflow resume r7c41d09e2b6a5f13 --driver containers
{"data":{"done":{"run":"r7c41d09e2b6a5f13","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

步骤运行期间，可以查看它的容器：

```sh
docker ps --filter label=teamai.run=r7c41d09e2b6a5f13 --format '{{.Names}}  {{.Image}}  {{.Status}}'
```

```text
teamai-r7c41d09e2b6a5f13-a3e9b0c51  ghcr.io/acme/agent:1  Up 41 seconds
```

尝试结束后，teamai 会删除它的容器。`teamai workflow cancel` 会停止步骤，并同样删除容器。

## 选项

| 键 | 示例 | 含义 |
| --- | --- | --- |
| `provider` | `docker` | `sbx`、`docker` 或 `podman` |
| `agent` | `claude` | 仅 `sbx`：每个沙箱从哪个 agent 模板启动，`claude` 或 `codex`，或者一个自带工具的 kit 引用。不写时，每次尝试从它自己工具的模板启动：Claude 步骤用 `claude`，Codex 步骤用 `codex`，命令步骤用裸的 `shell`。`agent: shell` 会被拒绝，因为那个模板里没有 agent。 |
| `image` | `ghcr.io/acme/agent:1` | 仅 `docker` 和 `podman`：预先构建的镜像。它需要 `/bin/sh` 以及步骤要运行的工具：`claude`、`codex` 或 `codebuddy`。需要读取历史的步骤还要装 `git`。 |
| `credentials` | `CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN` | 由 teamai 在运行开始时从你的环境里读取，只交给步骤的工具，从不交给命令步骤。见[来自你环境的凭据](workflow-advanced.md#来自你环境的凭据)。 |
| `warm` | `prepare: npm ci --ignore-scripts` | 包管理器缓存已填好的镜像，只做一次，每次尝试都用它。见[预热镜像](#预热镜像)。 |

不支持的键会在任何步骤运行之前失败：

```text
{"error":{"code":"bad_option","message":"Runtime \"sandbox\" of driver definition /home/me/acme/app/.teamai/drivers/containers.yaml refused option \"imgae\": Provider docker takes no option \"imgae\". It takes: provider, image, warm. Fix the option and start again."}}
```

## 预热镜像

写了 `warm` 后，每次尝试都从包管理器缓存已经填好的镜像启动，工作流的 setup 从缓存安装，不必在每个步骤里重新下载所有包：

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
description: Run each step in a container from the team image, with the package store filled once.
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: docker
      image: ghcr.io/acme/agent:1
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
      warm:
        prepare: npm ci --ignore-scripts
        cache: [package.json, package-lock.json]
```

第一个打开的步骤会制作它：teamai 把 `cache` 里的文件复制到检出目录之外的临时目录，在一个不带任何凭据的 `image` 容器里于该目录运行 `prepare`，再把结果保存为 `teamai-warm:<key>`。key 由镜像在本机的状态（它的 id，所以拉取了同一标签的新推送也算变化）、配方和 `cache` 文件的内容算出，所以 lockfile 一变就会做新镜像，不变就复用，本次运行和以后的运行都是如此。指向检出目录之外文件的 `cache` 链接会被拒绝。同时打开的步骤只等一次构建。镜像只保留 `prepare` 在该目录之外留下的东西，比如主目录里的缓存（`~/.npm`）或它安装的工具：该目录本身，连同在其中生成的 `node_modules`，都不在镜像里，检出目录的任何文件也不在。setup 照常安装（`npm ci --prefer-offline`），会从缓存取包。用 `docker image ls teamai-warm` 列出，用 `docker image rm` 删除。

在 `docker` 和 `podman` 上，`containerfile: ci/deps.Containerfile` 会构建这个文件而不是运行 `prepare`，构建上下文里只有 `cache` 文件；镜像里会有该文件复制进去的内容。在 `sbx` 上，`warm` 只接受 `prepare`，并保存为模板（`sbx template ls`），key 由模板和 sbx 的版本算出。`prepare` 失败时，步骤以 `sandbox_failed` 失败并给出最后几行输出；修好之前不会运行任何步骤。

## 步骤能看到什么

```text
容器内                                                  来自主机
/home/me/acme/app/.teamai/workflow-worktrees/…          步骤的工作树，可读写
/home/me/acme/app/.git                                  git 目录，只读
~/.teamai/projects/…/attempts/a3e9b0c51/out             工具写结果的位置，可读写
~/.teamai/projects/…/attempts/a3e9b0c51/tool-home/claude   CLAUDE_CONFIG_DIR：会话，可读写
~/.teamai/projects/…/runs/r7c41d09e2b6a5f13/scratch        TEAMAI_RUN_DIR：运行共享的文件，可读写
/tmp/teamai-home                                        HOME，容器私有
```

- 每个路径都保持主机上的路径，所以不需要复制回来，`git status` 也能用。每种 `workspace` 都是这样：`new`、`continue`、`read-only`，以及 teamai 准备的 `clone` 或团队仓库副本，它们自己的 `.git` 就是只读的 git 目录。
- 在容器里 `git commit` 会失败，因为 git 目录是只读的。teamai 在主机上提交时关闭钩子，所以步骤植入的钩子永远不会运行。
- 步骤以你的身份运行：Docker 上是 `--user <你的 uid>:<gid>`，Podman 上是 `--userns keep-id`。它写的文件归你所有。在启用 SELinux 的主机上，挂载会带上共享标签（`:z`）。
- 工具把会话保存在这次尝试的工具主目录里，所以这一轮的 `teamai-score` 运行能根据它的记录评判它，带 `session: { from: … }` 的后续步骤也能恢复它。
- 命令步骤也在容器里运行，即使驱动定义在 sandbox 之后还列了 `local`。只有 teamai 自己的簿记工作，比如 `teamai-score` 运行收集证据和写标签的步骤，在这台机器上运行。

**工具只在能登录的地方运行。** macOS 钥匙串或 `~/.claude` 里的 Claude 登录、你日常用的 `~/.codex`，都不会进入容器。所以只有当 `credentials` 写了某个工具的登录键（Claude 是 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`；Codex 是 `OPENAI_API_KEY`、`CODEX_API_KEY` 或 `codex: login`），或者在 sbx 上 sbx 替它保存了登录时，sandbox 才提供这个工具。用了登录不了的工具的步骤会在开始之前失败，并说明怎样给这个工具登录，而不是停在 Claude 自己的 "Not logged in"：

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on claude, which the driver of this run cannot launch here: sandbox: claude cannot sign in inside this docker sandbox, so a step there would stop at its "Not logged in": a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a container; run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN to the sandbox's credentials (or an API key, ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY). Then start again. Or remove tool from the step.
```

命令步骤照样在 sandbox 里运行：它们不需要登录。驱动定义在 sandbox 之后列的 `local` 也不会接手这样的提示词步骤：它照上面那样失败，所以步骤不会因为它的工具在 sandbox 里登录不了，就改到这台机器的工具上运行。评判和交互式步骤仍由 `local` 接手。

在 sbx 上，sbx 保存了登录的工具就用那份登录，即使你的 shell 设置了它的某个变量，比如指向网关的 `ANTHROPIC_BASE_URL`。驱动定义在 `credentials` 里写明的变量照常发给步骤的工具。

如果你的 shell 设置了 `ANTHROPIC_BASE_URL`，每个 teamai 命令在沙箱里运行的第一个 Claude 步骤会提示一次：

```text
⚠ Step runtime "sandbox", operation op-3c1e9a7f2b40: claude signs in here on the login sbx keeps (anthropic in `sbx secret ls`), so the gateway ANTHROPIC_BASE_URL names in your shell is not used in this sandbox. To use it there, add ANTHROPIC_BASE_URL: env:ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN: env:ANTHROPIC_AUTH_TOKEN to the sandbox's credentials.
```

**团队的工具实例也在这里运行。** 像 `tools/acme-claude.yaml`（`extends: claude`、`command: acme-claude`）这样的实例，只要它的工具能在沙箱里登录、沙箱里也有它的命令（镜像里有，或在 sbx 上由 kit 提供，`agent: ./kits/acme`），就会被提供，即使沙箱里没有 `claude` 本身。teamai 随后在沙箱里运行 `acme-claude`，并把实例的 home 变量指向这次尝试的工具 home。没有自己 `command` 的实例，或者命令就是它的工具本身的实例，在它的工具能运行的地方都能运行。sbx 自带的模板只包含它的 agent，所以在 `teamai-sandbox` 上这样的步骤会在开始前停下，而不是通过 `local` 在这台机器上运行 `acme-claude`：

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: sandbox: acme-claude runs acme-claude, which is not in sbx's claude template: set agent to a kit that brings it, or run the step with --driver local. Or remove tool from the step.
```

只有分配给步骤的变量名会进入容器：它的 `requires.env` 键、工作流的 `env`、teamai 的尝试标记、工具主目录变量，以及只给步骤工具的 `credentials`。你环境里的其他内容都不会进去，所以 `GH_TOKEN`、`SSH_AUTH_SOCK` 之类会留在外面。变量值从不出现在命令行里：容器创建时不带任何凭据，每次 `docker exec -e NAME` 都从容器引擎 CLI 自己的环境里读取值。变量值也不会写到磁盘上：运行时记下的每次 exec 结果里，工具打印出的凭据都会被遮盖。

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e CLAUDE_CONFIG_DIR -e TEAMAI_WORKFLOW_RESULT -e CLAUDE_CODE_OAUTH_TOKEN teamai-r7c41d09e2b6a5f13-a3e9b0c51 claude -p …
```

**工作流的 `setup` 也在步骤的容器里运行**，在步骤之前，只带 setup 自己的 `requires.env` 键，不带步骤的任何键：步骤的键会被取消设置，`credentials` 只给工具。

```yaml
# workflows/review.yaml
setup:
  command: npm ci
  requires: { env: [NPM_TOKEN] }
```

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e NPM_TOKEN -e TEAMAI_WORKFLOW_ATTEMPT -e TEAMAI_MODE -e TEAMAI_RUN_DIR teamai-r7c41d09e2b6a5f13-a3e9b0c51 env -u SIGNING_KEY -- /bin/sh -c 'npm ci'
```

之后 teamai 和在 `local` 上一样，在主机上检查 setup 在工作树里留下了什么。setup 失败、改动了被跟踪的文件，或者把某个键的值写进了文件，都会让步骤在工具启动前停下：

```text
✖ Step "review" failed with setup_failed: Setup "npm ci" exited with code 1, so the step did not run. It printed: npm error 401 Unauthorized - GET https://npm.acme.internal/@acme%2fui Fix setup, then retry the step.
✖ Step "review" failed with setup_secret: Setup "npm ci" left the value of NPM_TOKEN in .npmrc, where the step could read it, so the step did not run. Make setup remove the files it writes NPM_TOKEN to, then retry the step.
```

## 在 sandbox 里评判

被评分的一轮由它的 `teamai-score` 运行评判，其中的评判步骤只读取 teamai 收集的证据。sandbox 也运行这个评判，所以只有 `sandbox` 的驱动定义不需要你机器上有任何 agent CLI 就能评判。每次评判都有一个全新的容器：

```text
评判容器 teamai-<run>-<attempt>                         来自主机
/evidence                                               证据，只读：别的都没有
网络 <name>-net，internal                               除了过滤器没有出口
过滤器 <name>-proxy                                     只放行模型提供方：api.anthropic.com:443
```

- Claude 只带 `Read`、`Grep` 和 `Glob` 运行，所以只能读证据（`access: read`）。Codex 把容器当作它的沙箱运行，所以能在容器里执行命令（`access: full`），但仍然只能接触到 `dir` 和模型提供方。
- 证据挂载在 `/evidence`，评判的提示词和工作目录也用这个路径指代它，所以评判的挂载和提示词里没有你的主目录、用户名或项目路径。证据文件本身（比如转录）仍然保留会话写下的内容。
- 评判只拿到它自己的工具会读取的环境变量凭据，拿不到你的环境、SSH agent 或运行目录。它计入 sandbox 的 `max_parallel`。
- 运行会记录运行时实际保持的级别 `verified`，以及工具在那里能做什么。

```yaml
# workflows/review.yaml
schemaVersion: v1alpha1
name: review
description: Review a change in the sandbox, and judge each review there.
steps:
  - id: review
    workspace: new
    prompt: Review the change and write review.md.
    scorers: { names: [review-quality], sampling: all }
```

```sh
teamai workflow start review --driver containers
```

```text
ℹ Run ra0a53357b53c5ca7 started. If it stops before it ends, continue it with: teamai workflow resume ra0a53357b53c5ca7
ℹ run:ra0a53357b53c5ca7:review:1: review-quality good (teamai-score run rabebd844f8554e81).
{"data":{"done":{"run":"ra0a53357b53c5ca7","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

评判运行期间，可以查看它的容器和过滤器：

```sh
docker ps --filter label=teamai.run=rabebd844f8554e81 --format '{{.Names}}  {{.Networks}}'
```

```text
teamai-rabebd844f8554e81-a6ee9e5b2         teamai-rabebd844f8554e81-a6ee9e5b2-net
teamai-rabebd844f8554e81-a6ee9e5b2-proxy   bridge,teamai-rabebd844f8554e81-a6ee9e5b2-net
```

**评判用 API 密钥登录。** 评判容器没有工具主目录，所以 `codex: login` 永远到不了它那里。给 sandbox 一个评判工具会读取的环境变量凭据：Claude 用 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，Codex 用 `OPENAI_API_KEY` 或 `CODEX_API_KEY`。快速开始里步骤用的令牌也能用来评判。条目里写了的话，评判也会拿到它的工具读取的模型变量，例如 `ANTHROPIC_MODEL`，但永远拿不到你的代理或 CA 文件：它唯一的出口是过滤器。通过网关时，过滤器放行它的 base URL 而不是公共 API，`https` 和普通 `http` 都可以：

```yaml
# drivers/gateway.yaml：步骤用 Claude，评判用经过你的网关的 Codex
schemaVersion: v1alpha1
name: gateway
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: docker
      image: ghcr.io/acme/agent:1
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN   # 步骤用
        OPENAI_API_KEY: env:OPENAI_API_KEY                     # Codex 评判用
        OPENAI_BASE_URL: env:OPENAI_BASE_URL                   # 放行 https://llm.acme.internal:8443/v1
```

**sandbox 只为驱动定义里给了密钥的工具提供评判。** 只有登录时，由驱动定义里后面的运行时来评判。这个驱动定义用 `teamai-share-session` 给会话打分，不在 sandbox 里运行步骤：评判经由 `local` 在你机器上的 Claude 上运行：

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: docker
      image: ghcr.io/acme/agent:1
      credentials:
        codex: login                                          # 只是登录：容器里不评判
  - use: local                                                # 接手评判
```

**本机上的网关可以直接用。** 凭据里的 `localhost`、`127.0.0.1` 或 `::1` 在容器里会是容器自己的回环地址，所以 teamai 会把它改成你的机器在容器里的名字，协议、端口和路径保持不变。评判的过滤器也只放行你机器上的那个端口。

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4000/anthropic   （你的 shell）
ANTHROPIC_BASE_URL=http://host.docker.internal:4000/anthropic       （步骤，Docker Desktop 上）
ANTHROPIC_BASE_URL=http://host.containers.internal:4000/anthropic   （步骤，Podman 上）
```

Linux 上的 Docker Engine 不给你的机器这样的名字，所以在那里尝试会在创建任何东西之前以 `bad_option` 失败，信息里说出变量名，但从不说出它的值。请改用容器能到达的你的机器的地址。

**镜像里需要 `node`** 来运行过滤器，Docker 也要能把 DNS 限制在 internal 网络里：26.0.0 或更高、25.0.5 或 23.0.11（更旧的版本会把容器的查询转发出去，CVE-2024-29018）。否则 sandbox 不提供评判，只有这个 sandbox 的驱动定义运行到评判时会以 `confined_pending` 停下。快速开始里的镜像带有 `node`。这个版本的 Podman 不提供评判：它的 rootless 网络无法把过滤器接到评判的网络上。

评判不保证的事：

- 过滤器只看主机名，看不到请求内容：评判能访问模型提供方主机上的任何账号或路径，以及你放行的网关。
- 评判读到的证据就是写它的步骤留下的样子。发现步骤篡改证据靠的是 teamai 自己的哈希检查，不是容器。

## sbx（Docker Sandboxes）

使用 `provider: sbx` 时，每次尝试都在一个有自己内核的微型虚拟机里运行，来自步骤工具的模板（或者你指定的 `agent` 的模板）。不需要构建镜像。

**1. 每台机器做一次：** 安装 Docker Sandboxes、登录、设置网络策略，并用 sbx 给你的工具登录。没有网络策略时 sbx 不会创建任何沙箱，teamai 也从不替你设置。

```sh
sbx login
sbx policy init balanced                 # 或者 deny-all，再放行你的模型提供方：
# sbx policy allow network api.anthropic.com:443
sbx run claude ~/scratch                 # 然后在 Claude Code 里用你的订阅执行 /login，再退出
sbx rm <那个沙箱>                         # 名字见 sbx ls；登录保留，供每个沙箱使用
sbx secret set openai --oauth            # Codex：你的 ChatGPT 登录
sbx secret ls
```

```text
SCOPE      TYPE      NAME        SECRET
(global)   service   anthropic   (oauth configured)
(global)   service   openai      (stored)
```

登录留在你机器上 sbx 的代理里，由代理加到工具的请求上，每个新沙箱都会复用它：你的环境里不需要令牌，这次尝试的工具主目录里也没有 `auth.json`。API key 也一样：`sbx secret set anthropic`。

**2. 用 `--driver sandbox` 运行工作流。** teamai 自带这个驱动定义，你不需要自己写：

```yaml
# drivers/teamai-sandbox.yaml，随 teamai 提供
schemaVersion: v1alpha1
name: teamai-sandbox
description: Run each step in a Docker Sandboxes (sbx) microVM of its own, from the template of the step's tool, signed in on the login sbx keeps; this machine takes the judge and interactive steps.
runtimes:
  - use: sandbox
    options: { provider: sbx, max_parallel: 4 }   # 不写 agent：每次尝试从它自己工具的模板启动
  - use: local                                     # 负责评判：sbx 不提供评判
```

```sh
teamai workflow start fix --driver sandbox
sbx ls                                   # 运行时：一个命令步骤，再一个 Claude 步骤
```

```text
SANDBOX                                               AGENT    STATUS      PORTS   WORKSPACE
teamai-5f0c2a9e1d7b4c38-r1742da096cbb2f40-a0206b5e3   shell    ● running           /home/me/acme/app/.teamai/workflow-worktrees/teamai-r1742da096cbb2f40-build-p1-…, …
teamai-5f0c2a9e1d7b4c38-r1742da096cbb2f40-a9953a8d7   claude   ● running           /home/me/acme/app/.teamai/workflow-worktrees/teamai-r1742da096cbb2f40-fix-p1-…, …
```

```text
✔ Archived 1 step session of r1742da096cbb2f40 to teamai-reports (scrubbed)
{"data":{"done":{"run":"r1742da096cbb2f40","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

想固定模板、让每个步骤都留在 sandbox 里，或者写明 credentials 时，再写你自己的驱动定义：

```yaml
# drivers/sbx-codex.yaml：用 sbx 替你保存的登录运行 Codex 步骤，这台机器上什么都不运行
schemaVersion: v1alpha1
name: sbx-codex
tool: codex
runtimes:
  - use: sandbox
    options:
      provider: sbx
      agent: codex                       # 不需要 credentials：sbx 的代理替 Codex 登录
```

两种方式都没给工具登录时，用这个工具的步骤会拿到 sbx 命令，运行里的命令步骤照样运行：

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on codex, which the driver of this run cannot launch here: sandbox: codex cannot sign in inside this sbx sandbox, so a step there would stop at its "Not logged in": sign Codex in once with sbx, `sbx secret set openai --oauth` (or store an API key with `sbx secret set openai`), or add OPENAI_API_KEY: env:OPENAI_API_KEY to the sandbox's credentials. Then start again. Or remove tool from the step.
```

**3. 给它做的事评分。** sbx 不提供评判，所以评分步骤的评判在 `local` 上、用你机器上的工具运行：

```sh
teamai workflow start review --driver sandbox
```

```text
ℹ run:rb2152f12cb75a939:review:1: review-quality good (teamai-score run refcf49f79792650e).
{"data":{"done":{"run":"rb2152f12cb75a939","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

和容器不同的地方：

- 工作树是沙箱的工作区。git 目录、结果目录、运行目录和工具主目录是额外的工作区，都在主机上的路径，git 的那些是只读的（`/home/me/acme/app/.git:ro`）。sbx 自己不会顺着链接工作树的 `.git` 找到主检出，所以由 teamai 列出这些路径。`git status` 能用，`git commit` 会失败。
- 步骤以 sbx 的 `agent` 用户运行。它写到你磁盘上的文件仍然归你所有。
- 每次 `sbx exec` 都用 `-e NAME` 拿到步骤的变量名，命令行里从不出现值。严格步骤要扣下的变量，比如 sbx 为它的代理设置的 `GH_TOKEN`，会在步骤进程里被取消设置。步骤自己的 `HOME`、`XDG_*`、`SBX_*` 或 `DOCKER_*` 不会传进去：sbx CLI 自己读取它们，沙箱保留它自己的。
- 取消或到达限制时执行 `sbx stop`，下一次 exec 会重新启动沙箱。尝试结束时 teamai 执行 `sbx rm --force`。sbx 也会自己停掉空闲的沙箱，这没有问题。

**你机器上的网关**可以直接用：teamai 把 `http://127.0.0.1:4000` 改成 `host.docker.internal:4000`，sbx 的代理会把它转到 `localhost`。沙箱能不能访问它由你的 sbx 策略决定，teamai 在打开尝试之前会问它（`sbx policy check`，只读）。不允许时，步骤失败并给出要添加的规则，teamai 从不修改策略：

```text
✖ Step "fix" failed with runtime_failed: Step runtime "sandbox" could not open attempt a2695fde5 (sandbox_unavailable): ANTHROPIC_BASE_URL points at port 4000 of this machine, which your sbx network policy does not let a sandbox reach. Allow it once with `sbx policy allow network localhost:4000`, and start again.
```

**sbx 不提供评判。** 受限的评判只能访问它的模型提供方，而 sbx 沙箱能访问你的 sbx 策略放行的所有主机：balanced 策略放行包仓库和代码托管站点，评判可以借它们把读到的内容发出去。单个沙箱的规则只能拒绝它点名的主机，策略 profile 来自你所在组织的 sbx 治理设置，所以 teamai 没有办法把一个沙箱收窄到只能访问一个主机。在 sbx 之后列上 `local` 或一个 `docker` sandbox 来负责评判：

```yaml
# drivers/sbx-judged.yaml：步骤在 sbx 里，评判在 docker sandbox 里
schemaVersion: v1alpha1
name: sbx-judged
tool: claude
runtimes:
  - use: sandbox
    options: { provider: sbx }
  - use: sandbox
    options: { provider: docker, image: ghcr.io/acme/agent:1, credentials: { ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY } }
```

sbx 本身不会对步骤隐藏的东西：除非你在 sbx 里关掉，sbx 会转发你的 SSH agent；它的代理会把保存的全局代码托管密钥（`sbx secret set github`）加到每个沙箱发往该站点的请求上。要让步骤拿不到它们，就关掉转发，并限定或删除那个密钥。

## Podman

```yaml
# drivers/containers-podman.yaml
schemaVersion: v1alpha1
name: containers-podman
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: podman
      image: ghcr.io/acme/agent:1
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

```sh
podman machine start                     # macOS 和 Windows
teamai workflow start review --driver containers-podman
```

## 限制和预算

步骤的 `timeout`、`max_turns` 和 `budget` 在容器里和在主机上一样生效。到达限制时，teamai 停止工具：运行时重启这次尝试的容器，容器里的所有进程随之结束。

```yaml
# workflows/explore.yaml
schemaVersion: v1alpha1
name: explore
description: Map a module within a token budget.
steps:
  - id: explore
    workspace: new
    budget: { tokens: 200000 }
    on_limit: end_turn
    prompt: Map the payment module and list its risks.
```

之后运行记录里这个步骤是 `"status": "succeeded"`、`"limit": "budget"`，并带上 Claude 报告的 token 数。

## 被终止后恢复

如果 teamai 在步骤运行时被终止，运行时会让该步骤的进程继续运行到结束，并记录它是怎么结束的。在 `sbx` 上，恢复的运行会按名字（`sbx ls`）重新找到沙箱。之后 `teamai workflow resume <run> --driver containers` 按[步骤运行时的规则](workflow-advanced.md#驱动定义和步骤运行时)处理：已经结束的 exec 会被读回；仍在运行的会被停止，步骤以 `runtime_interrupted` 失败，但保留它的工作。尝试关闭时容器被删除。

```sh
teamai workflow resume r7c41d09e2b6a5f13 --driver containers
teamai workflow retry r7c41d09e2b6a5f13 review      # 从被停止的那一轮保留下来的工作继续
```

如果运行时在 `docker run`、`podman run` 或 `sbx create` 创建沙箱时被终止，可能会留下一个已经不属于任何尝试的沙箱。每个容器都带有 `teamai.owner` 标签，标明创建它的 teamai 主目录；sbx 不支持标签，所以每个 sbx 沙箱的名字以这个 id 开头（`teamai-<home id>-<run>-<attempt>`）。在同一提供方上打开沙箱的下一个步骤被接受之后，teamai 会用 `--force` 删除这个主目录下所有已经没有尝试记录的容器或沙箱，评判容器的过滤器和网络也一起删除。这个清理在后台进行：步骤、取消和关闭都不会等它。其他成员或其他主目录的容器、没有 `teamai.owner` 标签的容器，以及名字不以这个主目录 id 开头的 sbx 沙箱，都不会被动到。列出或删除失败时，会在 stderr 输出一条警告，步骤照常继续。

```sh
docker ps -a --filter label=teamai.owner --format '{{.Names}} {{.Label "teamai.owner"}}'
# teamai-r7c41d09e2b6a5f13-a3b90c2f 5f0c2a9e1d7b4c38    它落地前尝试已经关闭：docker 上的下一个步骤会删除它
sbx ls -q
# teamai-5f0c2a9e1d7b4c38-r7c41d09e2b6a5f13-a3b90c2f   sbx 上的同样情况：sbx 上的下一个步骤会删除它
# teamai-r7c41d09e2b6a5f13-a3b90c2f                    旧版 teamai 起的名字：保留；用 sbx rm --force 删除
```

## 错误

| 错误 | 发生了什么 | 下一步 |
| --- | --- | --- |
| `sandbox_unavailable` | 没有安装 `sbx`、`docker` 或 `podman`，它的守护进程或虚拟机没有运行，sbx 还没有网络策略，拉取不到镜像，或者你的 sbx 策略不允许沙箱访问 base URL 指向的本机端口。不会改为在主机上运行。 | 安装或启动它：`sbx daemon start`、Docker Desktop、`sudo systemctl start docker`，或 `podman machine start`。sbx 执行 `sbx policy init balanced`，或信息里给出的 `sbx policy allow network localhost:<port>`。镜像问题请检查名称，并执行 `docker login <registry>`。 |
| `tool_unavailable` | 步骤的工具在 sandbox 里登录不了 | 执行信息里点名的命令：sbx 上执行 `sbx run claude <任意目录>` 再 `/login`，或 `sbx secret set openai --oauth`；容器里执行 `claude setup-token`，再导出 `CLAUDE_CODE_OAUTH_TOKEN` 并写进 `credentials` |
| `credential_missing` | 凭据对应的变量在 teamai 运行的地方没有设置，或者评判没有拿到它的工具会读取的环境变量凭据 | 设置信息里点名的变量，或者把它点名的密钥加到 `credentials` |
| `confined_pending` | 驱动定义里没有运行时提供评判用的工具：镜像缺少 `node` 或那个工具，驱动定义没给它密钥，Docker 早于 26.0.0，或者 provider 是 `podman` 或 `sbx` | 把 `node` 和工具装进镜像、在 `credentials` 里加上工具的密钥、升级 Docker，或者在驱动定义里列上 `local` |
| `bad_option` | `options` 里有键或值写错了（`sbx` 写了 `agent: shell`），或者在 Linux 上的 Docker Engine 里，`ANTHROPIC_BASE_URL` 这类凭据指向那里的容器到不了的 `localhost` 或 `127.0.0.1` | 修正驱动定义并推送；Linux 上的 base URL 改用容器能到达的你的机器的地址 |
| `sandbox_failed` | 无法创建或查找这次尝试的容器或沙箱，例如运行中途退出了 Docker Desktop。查找失败的容器仍算作这次尝试的，不会当作已经不存在。 | 查看步骤失败里给出的信息。先重新启动引擎，再删除剩下的：`docker ps -a --filter label=teamai.run=<run>` 或 `sbx ls` 会列出它，信息里给出了要执行的 `docker rm --force` 或 `sbx rm --force` 命令 |
| `cancel_failed` | 取消或达到限制时，无法确认步骤已经停止：引擎拒绝了停止，或者停止（包括删除评判的容器）加上步骤进程的结束超过了 10 秒。那里运行的内容可能仍在运行，所以 teamai 保留容器、工作和登录。例如：`docker could not stop the processes in container teamai-r0123abcd-a0123abcd: Cannot connect to the Docker daemon. They may still run; remove the container with docker rm --force teamai-r0123abcd-a0123abcd.` | 先重新启动引擎，再运行一次 `teamai workflow cancel <run>`：运行时会停止步骤并关闭它的位置。也可以用信息里给出的 `docker rm --force` 或 `sbx rm --force` 命令删除它 |
| 运行详情里的 **未关闭**（Not closed） | 无法删除这次尝试的容器或沙箱，或者删除和其中运行内容的结束超过了 10 秒，里面运行的东西可能还在运行。运行本身照常结束。 | 按信息里给出的命令执行 `docker rm --force <container>` 或 `sbx rm --force <sandbox>`。确认其中已没有任何东西在运行后，`teamai workflow cancel <run> --release <attempt>` 会放开这次尝试：即使运行时无法删除这个位置，也会忘掉它，信息里仍会给出 `rm --force` 命令 |
| `runtime_interrupted` | 步骤运行时 teamai 重启了 | `teamai workflow retry <run> <step>` |

## 这个版本还不支持

- `bwrap`、`seatbelt` 和托管沙箱。在它们发布之前，驱动定义会在 `provider` 上以 `bad_option` 失败。
- 在容器里使用 teamai 专用登录的 Codex。在 `sbx` 上，Codex 用 `sbx secret set openai --oauth` 登录。
- 步骤的网络规则。`requires.network: false` 会列在 `unenforced` 里，严格要求它的步骤会等待一个声明了它的驱动。只有评判的网络会被过滤。
- 用工具登录的评判。评判用环境变量凭据登录。
