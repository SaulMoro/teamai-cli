# Sandbox runtime

The `sandbox` [step runtime](workflow-advanced.md#driver-definitions-and-step-runtimes) runs each attempt of a workflow step in a container of its own, from an image your team builds. The agent works on the step's worktree and cannot touch the rest of your machine. teamai still builds the tool's command, reads the result, meters the budget, and commits and pushes on the host.

This version runs `docker` and `podman`. It ships with teamai as the executable `teamai-runtime-sandbox`.

## Quick start

**1. Build an image that holds the tools.** The checkout is never copied into the image: it is mounted when the step runs.

```dockerfile
# Containerfile in your infra repo
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

**2. Add a driver definition** to the team repo, then push it.

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
description: Run each step in a container from the team image, on the member's Claude subscription.
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: docker                  # or podman
      image: ghcr.io/acme/agent:1
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

**3. Each member creates a token once.** A Claude login kept in the macOS Keychain does not reach a container, and a token does.

```sh
claude setup-token                       # prints a long-lived token for your subscription
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…   # in your shell profile or secret manager
```

Without it, the start stops before any step runs:

```text
{"error":{"code":"credential_missing","message":"Runtime \"sandbox\" of driver definition /home/me/acme/app/.teamai/drivers/containers.yaml declares credential CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN, and CLAUDE_CODE_OAUTH_TOKEN is not set in your environment. Set CLAUDE_CODE_OAUTH_TOKEN, then start again."}}
```

**4. Run a workflow on it.**

```sh
teamai pull
teamai workflow start review --driver containers
```

```text
ℹ Run r7c41d09e2b6a5f13 started. If it stops before it ends, continue it with: teamai workflow resume r7c41d09e2b6a5f13 --driver containers
{"data":{"done":{"run":"r7c41d09e2b6a5f13","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

While a step runs, its container is there to look at:

```sh
docker ps --filter label=teamai.run=r7c41d09e2b6a5f13 --format '{{.Names}}  {{.Image}}  {{.Status}}'
```

```text
teamai-r7c41d09e2b6a5f13-a3e9b0c51  ghcr.io/acme/agent:1  Up 41 seconds
```

When the attempt ends, teamai removes its container. A `teamai workflow cancel` stops the step and removes it too.

## Options

| Key | Example | Meaning |
| --- | --- | --- |
| `provider` | `docker` | `docker` or `podman` |
| `image` | `ghcr.io/acme/agent:1` | The prebuilt image. It needs `/bin/sh` and the tools your steps run: `claude`, `codex` or `codebuddy`. Add `git` for steps that read history. |
| `credentials` | `CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN` | Read by teamai from your environment when the run starts, and given only to the step's tool, never to a command step. See [Credentials from your environment](workflow-advanced.md#credentials-from-your-environment). |

A key it does not take fails before any step runs:

```text
{"error":{"code":"bad_option","message":"Runtime \"sandbox\" of driver definition /home/me/acme/app/.teamai/drivers/containers.yaml refused option \"imgae\": Provider docker takes no option \"imgae\". It takes: provider, image. Fix the option and start again."}}
```

## What the step sees

```text
in the container                                        from the host
/home/me/acme/app/.teamai/workflow-worktrees/…          the step's worktree, read-write
/home/me/acme/app/.git                                  git directories, read-only
~/.teamai/projects/…/attempts/a3e9b0c51/out             where the tool writes its result, read-write
~/.teamai/projects/…/attempts/a3e9b0c51/tool-home/claude   CLAUDE_CONFIG_DIR: the session, read-write
~/.teamai/projects/…/runs/r7c41d09e2b6a5f13/scratch        TEAMAI_RUN_DIR: the run's shared files, read-write
/tmp/teamai-home                                        HOME, private to the container
```

- Every path keeps its host path, so nothing is copied back and `git status` works.
- `git commit` in the container fails, because the git directories are read-only. teamai commits on the host with hooks turned off, so a hook the step plants never runs.
- The step runs as you: `--user <your uid>:<gid>` on Docker, `--userns keep-id` on Podman. Files it writes are yours. On a host with SELinux, mounts get the shared label (`:z`).
- The tool keeps its session in the attempt's tool home, so the pass's `teamai-score` run judges it from its transcript, and a later step with `session: { from: … }` resumes it.
- Command steps run in the container too, also in a definition that lists `local` after the sandbox. Only teamai's own bookkeeping, such as a `teamai-score` run's evidence and label steps, runs on this machine.

Only the names a step is given cross into the container: its `requires.env` keys, the workflow's `env`, teamai's attempt marker, the tool home variable, and, for the step's tool only, the `credentials`. Nothing else of your environment reaches it, so `GH_TOKEN`, `SSH_AUTH_SOCK` and the like stay out. Values never appear in a command line: the container is created with no credential, and each `docker exec -e NAME` reads the value from the engine CLI's own environment. Nor are they written to disk: the runtime keeps what it remembers of each exec with any credential the tool printed masked.

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e CLAUDE_CONFIG_DIR -e TEAMAI_WORKFLOW_RESULT -e CLAUDE_CODE_OAUTH_TOKEN teamai-r7c41d09e2b6a5f13-a3e9b0c51 claude -p …
```

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
podman machine start                     # macOS and Windows
teamai workflow start review --driver containers-podman
```

## Limits and budgets

A step's `timeout`, `max_turns` and `budget` hold in a container as on the host. At a limit, teamai stops the tool: the runtime restarts the attempt's container, which ends every process in it.

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

The step's record in the run then reads `"status": "succeeded"`, `"limit": "budget"`, with the tokens Claude reported.

## Killed and resumed

When teamai is killed while a step runs, the runtime keeps running that step's process until it ends and records how it ended. `teamai workflow resume <run> --driver containers` then follows the [step runtime rules](workflow-advanced.md#driver-definitions-and-step-runtimes): an exec that already finished is read back, and one still running is stopped and its step fails `runtime_interrupted`, keeping its work. The container is removed when the attempt closes.

```sh
teamai workflow resume r7c41d09e2b6a5f13 --driver containers
teamai workflow retry r7c41d09e2b6a5f13 review      # goes on from the work the stopped pass kept
```

## Errors

| Error | What happened | Next step |
| --- | --- | --- |
| `sandbox_unavailable` | `docker` or `podman` is not installed, its daemon or machine is not running, or the image cannot be pulled. Nothing runs on the host instead. | Install or start it: Docker Desktop, `sudo systemctl start docker`, or `podman machine start`. For an image, check its name and `docker login <registry>`. |
| `credential_missing` | A credential's variable is not set where teamai runs | `claude setup-token`, then export `CLAUDE_CODE_OAUTH_TOKEN` |
| `bad_option` | A key or value in `options` is wrong | Fix the definition and push it |
| `sandbox_failed` | The engine could not create the attempt's container | Read the engine's message in the step failure; `docker ps -a --filter label=teamai.run=<run>` lists what is left |
| **Not closed** in run details | The engine could not remove the attempt's container, so what ran there may still run. The run ends as it would. | `docker rm --force <container>`, as the message says |
| `runtime_interrupted` | teamai restarted while the step ran | `teamai workflow retry <run> <step>` |

## Not in this version

- `sbx` (Docker Sandboxes), `bwrap`, `seatbelt` and hosted sandboxes. The definition fails `bad_option` on `provider` until they ship.
- A warm image with dependencies installed, and the workflow's `setup` inside the container. Setup still runs on the host.
- Codex on a login dedicated to teamai.
- Network rules. `requires.network: false` is listed in `unenforced`, and a strict one waits for a driver that declares it.
