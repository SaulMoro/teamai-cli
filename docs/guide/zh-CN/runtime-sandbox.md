# Sandbox 运行时

`sandbox` [步骤运行时](workflow-advanced.md#驱动定义和步骤运行时)把工作流步骤的每次尝试放进一个独立的容器里运行，容器来自团队构建的镜像。Agent 只能处理该步骤的工作树，碰不到你机器上的其他内容。工具命令的构建、结果的读取、预算的计量，以及提交和推送，仍然由 teamai 在主机上完成。

这个版本支持 `docker` 和 `podman`。它随 teamai 一起发布，可执行文件名为 `teamai-runtime-sandbox`。

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
| `provider` | `docker` | `docker` 或 `podman` |
| `image` | `ghcr.io/acme/agent:1` | 预先构建的镜像。它需要 `/bin/sh` 以及步骤要运行的工具：`claude`、`codex` 或 `codebuddy`。需要读取历史的步骤还要装 `git`。 |
| `credentials` | `CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN` | 由 teamai 在运行开始时从你的环境里读取，只交给步骤的工具，从不交给命令步骤。见[来自你环境的凭据](workflow-advanced.md#来自你环境的凭据)。 |

不支持的键会在任何步骤运行之前失败：

```text
{"error":{"code":"bad_option","message":"Runtime \"sandbox\" of driver definition /home/me/acme/app/.teamai/drivers/containers.yaml refused option \"imgae\": Provider docker takes no option \"imgae\". It takes: provider, image. Fix the option and start again."}}
```

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

- 每个路径都保持主机上的路径，所以不需要复制回来，`git status` 也能用。
- 在容器里 `git commit` 会失败，因为 git 目录是只读的。teamai 在主机上提交时关闭钩子，所以步骤植入的钩子永远不会运行。
- 步骤以你的身份运行：Docker 上是 `--user <你的 uid>:<gid>`，Podman 上是 `--userns keep-id`。它写的文件归你所有。在启用 SELinux 的主机上，挂载会带上共享标签（`:z`）。
- 工具把会话保存在这次尝试的工具主目录里，所以这一轮的 `teamai-score` 运行能根据它的记录评判它，带 `session: { from: … }` 的后续步骤也能恢复它。
- 命令步骤也在容器里运行，即使驱动定义在 sandbox 之后还列了 `local`。只有 teamai 自己的簿记工作，比如 `teamai-score` 运行收集证据和写标签的步骤，在这台机器上运行。

只有分配给步骤的变量名会进入容器：它的 `requires.env` 键、工作流的 `env`、teamai 的尝试标记、工具主目录变量，以及只给步骤工具的 `credentials`。你环境里的其他内容都不会进去，所以 `GH_TOKEN`、`SSH_AUTH_SOCK` 之类会留在外面。变量值从不出现在命令行里：容器创建时不带任何凭据，每次 `docker exec -e NAME` 都从容器引擎 CLI 自己的环境里读取值。变量值也不会写到磁盘上：运行时记下的每次 exec 结果里，工具打印出的凭据都会被遮盖。

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e CLAUDE_CONFIG_DIR -e TEAMAI_WORKFLOW_RESULT -e CLAUDE_CODE_OAUTH_TOKEN teamai-r7c41d09e2b6a5f13-a3e9b0c51 claude -p …
```

## 在 sandbox 里评判

被评分的一轮由它的 `teamai-score` 运行评判，其中的评判步骤只读取 teamai 收集的证据。sandbox 也运行这个评判，所以只有 `sandbox` 的驱动定义不需要你机器上有任何 agent CLI 就能评判。每次评判都有一个全新的容器：

```text
评判容器 teamai-<run>-<attempt>                         来自主机
~/.teamai/projects/…/runs/<score run>/scratch/<attempt>   证据，只读：别的都没有
网络 <name>-net，internal                               除了过滤器没有出口
过滤器 <name>-proxy                                     只放行模型提供方：api.anthropic.com:443
```

- Claude 只带 `Read`、`Grep` 和 `Glob` 运行，所以只能读证据（`access: read`）。Codex 把容器当作它的沙箱运行，所以能在容器里执行命令（`access: full`），但仍然只能接触到 `dir` 和模型提供方。
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

**评判用 API 密钥登录。** 评判容器没有工具主目录，所以 `codex: login` 或 `claude: login` 永远到不了它那里。给 sandbox 一个评判工具会读取的环境变量凭据：Claude 用 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，Codex 用 `OPENAI_API_KEY` 或 `CODEX_API_KEY`。快速开始里步骤用的令牌也能用来评判。通过网关时，过滤器放行它的 base URL 而不是公共 API，`https` 和普通 `http` 都可以：

```yaml
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

**镜像里需要 `node`** 来运行过滤器，Docker 也要能把 DNS 限制在 internal 网络里：26.0.0 或更高、25.0.5 或 23.0.11（更旧的版本会把容器的查询转发出去，CVE-2024-29018）。否则 sandbox 不提供评判，只有这个 sandbox 的驱动定义运行到评判时会以 `confined_pending` 停下。快速开始里的镜像带有 `node`。这个版本的 Podman 不提供评判：它的 rootless 网络无法把过滤器接到评判的网络上。

评判不保证的事：

- 过滤器只看主机名，看不到请求内容：评判能访问模型提供方主机上的任何账号或路径，以及你放行的网关。
- 评判读到的证据就是写它的步骤留下的样子。发现步骤篡改证据靠的是 teamai 自己的哈希检查，不是容器。

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

如果 teamai 在步骤运行时被终止，运行时会让该步骤的进程继续运行到结束，并记录它是怎么结束的。之后 `teamai workflow resume <run> --driver containers` 按[步骤运行时的规则](workflow-advanced.md#驱动定义和步骤运行时)处理：已经结束的 exec 会被读回；仍在运行的会被停止，步骤以 `runtime_interrupted` 失败，但保留它的工作。尝试关闭时容器被删除。

```sh
teamai workflow resume r7c41d09e2b6a5f13 --driver containers
teamai workflow retry r7c41d09e2b6a5f13 review      # 从被停止的那一轮保留下来的工作继续
```

## 错误

| 错误 | 发生了什么 | 下一步 |
| --- | --- | --- |
| `sandbox_unavailable` | 没有安装 `docker` 或 `podman`，它的守护进程或虚拟机没有运行，或者拉取不到镜像。不会改为在主机上运行。 | 安装或启动它：Docker Desktop、`sudo systemctl start docker`，或 `podman machine start`。镜像问题请检查名称，并执行 `docker login <registry>`。 |
| `credential_missing` | 凭据对应的变量在 teamai 运行的地方没有设置，或者评判没有拿到它的工具会读取的环境变量凭据 | 执行 `claude setup-token`，再导出 `CLAUDE_CODE_OAUTH_TOKEN`；评判的情况，把信息里点名的密钥加到 `credentials` |
| `confined_pending` | 驱动定义里没有运行时提供评判用的工具：镜像缺少 `node` 或那个工具，Docker 早于 26.0.0，或者 provider 是 `podman` | 把 `node` 和工具装进镜像、升级 Docker，或者在驱动定义里列上 `local` |
| `bad_option` | `options` 里有键或值写错了 | 修正驱动定义并推送 |
| `sandbox_failed` | 容器引擎无法创建这次尝试的容器 | 查看步骤失败里引擎给出的信息；`docker ps -a --filter label=teamai.run=<run>` 会列出剩下的容器 |
| 运行详情里的 **未关闭**（Not closed） | 容器引擎无法删除这次尝试的容器，里面运行的东西可能还在运行。运行本身照常结束。 | 按信息里给出的命令执行 `docker rm --force <container>` |
| `runtime_interrupted` | 步骤运行时 teamai 重启了 | `teamai workflow retry <run> <step>` |

## 这个版本还不支持

- `sbx`（Docker Sandboxes）、`bwrap`、`seatbelt` 和托管沙箱。在它们发布之前，驱动定义会在 `provider` 上以 `bad_option` 失败。
- 预装依赖的预热镜像，以及在容器里运行工作流的 `setup`。setup 仍在主机上运行。
- 使用 teamai 专用登录的 Codex。
- 步骤的网络规则。`requires.network: false` 会列在 `unenforced` 里，严格要求它的步骤会等待一个声明了它的驱动。只有评判的网络会被过滤。
- 用工具登录的评判。评判用环境变量凭据登录。
