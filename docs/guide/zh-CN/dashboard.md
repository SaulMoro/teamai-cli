# Dashboard

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

浏览器打开 `http://localhost:3721`。侧栏是总览、团队执行、团队上下文、资源、团队改进。数据是这台机器上的。

## 资源（Resources）

资源页列出团队仓库里的每条规则在当前工作区的情况：名称、命名空间、描述，以及 `pull` 是否会把它交付到这里。根规则人人都收到；命名空间规则跟随活跃的知识命名空间；同名根规则被活跃命名空间规则取代时会标注「已取代」；被标签订阅排除的规则也会标注。

## 人工干预指标（Human Intervention）

每个会话计三种次数：中途打断（`interrupt`）、拒绝工具调用（`toolReject`）、结束后马上用「不对 / 重来 / wrong」这类词纠正（`correction`）。

团队可以加自己的词：

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, "no era eso"]
```

改完后下次 `pull` 起的新输入才按新词计算。上报到团队的是次数，不是原文。

## 对话量与 Token 用量

会话行上有对话轮数和 token。拿不到用量的工具，token 显示为 0。

## Session Save（会话存档）

```bash
teamai session save
teamai session save --session-id <id>
teamai session save --push
teamai session save --push --force
```

本地写到 `~/.teamai/session-logs/<年-月>.md`。`--push` 把有摩擦或用了至少 3 种工具的会话交到团队的 `teamai-reports` 分支。默认不带 prompt 原文。

## Session 同步与迁移

`teamai session` 在工具之间迁移完整会话，或归档到团队仓库。`session save` 仍是脱敏摘要。

平台：`claude-code`、`codex`、`codebuddy`、`codebuddy-ide`、`cursor`、`workbuddy` 和 `opencode`（通过 2.0 及以上版本的 `opencode` CLI；作为目标时，目标工作区必须已存在）。`teamai session platforms` 查看本机已安装的。在 Windows 上，`cursor` 和 `workbuddy` 不能作为 migrate 或 resume 的目标：它们要等 `sqlite3` CLI 登记后才会列出会话，所以 TeamAI 直接拒绝，而不是写一份它们永远不显示的副本。

```bash
teamai session migrate <sessionId> -s codebuddy-ide -t claude-code
teamai session migrate --all -s codebuddy -t claude-code   # --limit 可限量
teamai session rollback <id> --platform claude-code
teamai session push --source codebuddy                     # --all：该平台全部工作区
teamai session pull
teamai session list                                        # --all：全部项目
teamai session search <query>
teamai session resume <name> --platform claude-code
```

迁移从不覆盖。目标工作区里已有这个会话的副本时（不论是当前还是旧版 TeamAI 写的），`migrate` 输出 `already migrated as <id>`，不写任何东西，你在副本里新加的对话都会保留。要刷新副本，先用 `session rollback <id> --platform <工具> --cwd <工作区>` 删掉它，再迁移一次。`session resume` 遵循同一规则：已恢复到该工作区的会话会输出 `already restored as <id>`，保持原样。

脚本可用 `migrate <sessionId> -s <工具> -t <工具> --json`：stdout 只输出一行，格式与 `teamai workflow` 相同，即 `{ "data": ... }` 或 `{ "error": { "code", "message" } }`；进度信息走 stderr。`data` 包含目标 `sessionId`、`cwd`、`reused` 和 `fidelity` 报告。`error.code` 标明失败原因，如 `no_adapter`（未知工具）、`tool_unavailable`（源工具或目标工具未安装，或其 CLI 无法运行）、`not_found`、`unreadable`，退出码为 1。`--json` 从不询问：缺少会话 id、`-s` 或 `-t` 时以 `prompt_refused` 失败，`--push` 需要 `-y` 或 `--scrub`。

`--dry-run` 只预览。`--scrub` 先脱敏再归档；不加时，交互运行会询问，脚本需要 `-y`。`--all` 超过 10 条要确认（push 为 5 条）。归档在 `sessions/repos/<repo>/<author>/`，按会话自己的 git remote；否则归入 `_unattributed`。
