# Sandbox runtime

The `sandbox` [step runtime](workflow-advanced.md#driver-definitions-and-step-runtimes) runs each attempt of a workflow step in a sandbox of its own: a Docker Sandboxes microVM, or a container from an image your team builds. The agent works on the step's worktree and cannot touch the rest of your machine. teamai still builds the tool's command, reads the result, meters the budget, and commits and pushes on the host.

This version runs `sbx` ([Docker Sandboxes](#sbx-docker-sandboxes)), `docker` and `podman`. It ships with teamai as the executable `teamai-runtime-sandbox`.

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
| `provider` | `docker` | `sbx`, `docker`, `podman`, `seatbelt`, `bwrap` or `vercel` |
| `agent` | `claude` | `sbx` only: the agent template each sandbox starts from, `claude` or `codex`, or a kit reference that brings the tools. Leave it out to start each attempt from its own tool's template: a Claude step from `claude`, a Codex step from `codex`, a command step from the bare `shell`. `agent: shell` is refused, since that template holds no agent. |
| `image` | `ghcr.io/acme/agent:1` | `docker` and `podman` only: the prebuilt image. It needs `/bin/sh` and the tools your steps run: `claude`, `codex` or `codebuddy`. Add `git` for steps that read history. |
| `credentials` | `CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN` | Read by teamai from your environment when the run starts, and given only to the step's tool, never to a command step. See [Credentials from your environment](workflow-advanced.md#credentials-from-your-environment). |
| `warm` | `prepare: npm ci --ignore-scripts` | An image with your package manager's store filled, made once and used by every attempt. See [A warm image](#a-warm-image). |

A key it does not take fails before any step runs:

```text
{"error":{"code":"bad_option","message":"Runtime \"sandbox\" of driver definition /home/me/acme/app/.teamai/drivers/containers.yaml refused option \"imgae\": Provider docker takes no option \"imgae\". It takes: provider, image, warm. Fix the option and start again."}}
```

## A warm image

With `warm`, each attempt starts from an image whose package manager's store is already filled, so the workflow's setup installs from it instead of downloading every package in every step:

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

The first step that opens makes it: teamai copies the `cache` files to a scratch directory outside the checkout, runs `prepare` there in a container of `image` with no credential, and saves the result as `teamai-warm:<key>`. The key comes from the image as it is on this machine (its id, so pulling a new push of its tag counts), the recipe and the bytes of the `cache` files, so a change to the lockfile makes a new image and an unchanged one reuses it, in this run and later runs. A `cache` file that is a link to a file outside the checkout is refused. Steps that open at the same time wait for one build. The image keeps only what `prepare` leaves outside that directory, such as the store in its home (`~/.npm`) or tools it installs: the directory, with any `node_modules` made there, is not in it, and neither is any file of the checkout. Install in the workflow's setup as usual (`npm ci --prefer-offline`), which takes the packages from the store. List and remove the images with `docker image ls teamai-warm` and `docker image rm`.

On `docker` and `podman`, `containerfile: ci/deps.Containerfile` builds that file instead of running `prepare`, with only the `cache` files in its context; the image holds what the file copies of them. On `sbx`, `warm` takes `prepare` only and saves a template (`sbx template ls`), keyed by the template and sbx's version. A `prepare` that fails stops the step with `sandbox_failed` and its last lines; no step runs until you fix it.

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

- Every path keeps its host path, so nothing is copied back and `git status` works. That holds for every `workspace`: `new`, `continue`, `read-only`, and the `clone` or team-repo copy teamai prepares, whose own `.git` is the read-only git directory.
- `git commit` in the container fails, because the git directories are read-only. teamai commits on the host with hooks turned off, so a hook the step plants never runs.
- The step runs as you: `--user <your uid>:<gid>` on Docker, `--userns keep-id` on Podman. Files it writes are yours. On a host with SELinux, mounts get the shared label (`:z`).
- The tool keeps its session in the attempt's tool home, so the pass's `teamai-score` run judges it from its transcript, and a later step with `session: { from: … }` resumes it.
- Command steps run in the container too, also in a definition that lists `local` after the sandbox. Only teamai's own bookkeeping, such as a `teamai-score` run's evidence and label steps, runs on this machine.

**A tool runs only where it can sign in.** A Claude login in the macOS Keychain or in `~/.claude`, or your daily `~/.codex`, never crosses into a container. So the sandbox offers a tool only when `credentials` names one of its sign-in keys (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude; `OPENAI_API_KEY`, `CODEX_API_KEY` or `codex: login` for Codex), or, on sbx, when sbx keeps a login for it. A step on a tool it cannot sign in fails before it starts, with how to sign that tool in, instead of at Claude's own "Not logged in":

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on claude, which the driver of this run cannot launch here: sandbox: claude cannot sign in inside this docker sandbox, so a step there would stop at its "Not logged in": a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a container; run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN to the sandbox's credentials (or an API key, ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY). Then start again. Or remove tool from the step.
```

Command steps still run in the sandbox: they need no sign-in. A `local` listed after the sandbox does not take such a prompt step either: it fails as above, so a step never runs on this machine's tool because its tool could not sign in in the sandbox. `local` still takes the judge and interactive steps.

On sbx, a tool sbx keeps a login for signs in on that login, even when your shell sets one of its variables, such as `ANTHROPIC_BASE_URL` for a gateway. A variable the definition names in `credentials` still goes to the step's tool.

When your shell sets `ANTHROPIC_BASE_URL`, the first Claude step each teamai command runs in the sandbox says so, once:

```text
⚠ Step runtime "sandbox", operation op-3c1e9a7f2b40: claude signs in here on the login sbx keeps (anthropic in `sbx secret ls`), so the gateway ANTHROPIC_BASE_URL names in your shell is not used in this sandbox. To use it there, add ANTHROPIC_BASE_URL: env:ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN: env:ANTHROPIC_AUTH_TOKEN to the sandbox's credentials.
```

**Your team's tool instances run here too.** An instance such as `tools/acme-claude.yaml` (`extends: claude`, `command: acme-claude`) is offered when its tool signs in in the sandbox and the sandbox holds its command, even without the `claude` executable itself: the image, or on sbx a kit (`agent: ./kits/acme`). teamai then runs `acme-claude` in the sandbox, with the instance's home variable at the attempt's tool home. An instance with no `command` of its own, or whose command is its tool's, runs wherever its tool does. sbx's own templates hold only their agent, so on `teamai-sandbox` such a step stops before it starts, rather than running `acme-claude` on this machine through `local`:

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: sandbox: acme-claude runs acme-claude, which is not in sbx's claude template: set agent to a kit that brings it, or run the step with --driver local. Or remove tool from the step.
```

Only the names a step is given cross into the container: its `requires.env` keys, the workflow's `env`, teamai's attempt marker, the tool home variable, and, for the step's tool only, the `credentials`. Nothing else of your environment reaches it, so `GH_TOKEN`, `SSH_AUTH_SOCK` and the like stay out. Values never appear in a command line: the container is created with no credential, and each `docker exec -e NAME` reads the value from the engine CLI's own environment. Nor are they written to disk: the runtime keeps what it remembers of each exec with any credential the tool printed masked.

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e CLAUDE_CONFIG_DIR -e TEAMAI_WORKFLOW_RESULT -e CLAUDE_CODE_OAUTH_TOKEN teamai-r7c41d09e2b6a5f13-a3e9b0c51 claude -p …
```

**The workflow's `setup` runs in the step's container too**, before the step, with setup's own `requires.env` keys and none of the step's: the step's keys are unset, and `credentials` go only to the tool.

```yaml
# workflows/review.yaml
setup:
  command: npm ci
  requires: { env: [NPM_TOKEN] }
```

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e NPM_TOKEN -e TEAMAI_WORKFLOW_ATTEMPT -e TEAMAI_MODE -e TEAMAI_RUN_DIR teamai-r7c41d09e2b6a5f13-a3e9b0c51 env -u SIGNING_KEY -- /bin/sh -c 'npm ci'
```

teamai then checks on the host what setup left in the worktree, as it does on `local`. A failing setup, a tracked file it changed, or a key's value it wrote to a file stops the step before the tool starts:

```text
✖ Step "review" failed with setup_failed: Setup "npm ci" exited with code 1, so the step did not run. It printed: npm error 401 Unauthorized - GET https://npm.acme.internal/@acme%2fui Fix setup, then retry the step.
✖ Step "review" failed with setup_secret: Setup "npm ci" left the value of NPM_TOKEN in .npmrc, where the step could read it, so the step did not run. Make setup remove the files it writes NPM_TOKEN to, then retry the step.
```

## Judging in the sandbox

A scored pass is judged by its `teamai-score` run, whose judge step reads only the evidence teamai gathered. The sandbox runs that judge too, so a definition with only `sandbox` judges with no agent CLI on your machine. Each judge gets a fresh container:

```text
judge container teamai-<run>-<attempt>                  from the host
/evidence                                               the evidence, read-only: nothing else
network <name>-net, internal                            no route out but the filter
filter <name>-proxy                                     lets through only the model provider: api.anthropic.com:443
```

- Claude runs with only `Read`, `Grep` and `Glob`, so it can read the evidence and nothing else (`access: read`). Codex runs with the container as its sandbox, so it can run commands inside it (`access: full`), but still reaches only `dir` and the provider.
- The evidence is mounted at `/evidence`, and the judge's prompt and working directory name it there, so the judge's mounts and prompt carry no path of your home, user name or project. The evidence files themselves, such as a transcript, still hold what the session wrote.
- The judge gets only the env credentials its own tool reads, never your environment, your SSH agent or the run's directory. It counts in the sandbox's `max_parallel`.
- The run records the level the runtime kept, `verified`, and what the tool could do there.

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

While the judge runs, its container and filter are there to look at:

```sh
docker ps --filter label=teamai.run=rabebd844f8554e81 --format '{{.Names}}  {{.Networks}}'
```

```text
teamai-rabebd844f8554e81-a6ee9e5b2         teamai-rabebd844f8554e81-a6ee9e5b2-net
teamai-rabebd844f8554e81-a6ee9e5b2-proxy   bridge,teamai-rabebd844f8554e81-a6ee9e5b2-net
```

**A judge signs in with an API key.** A judge container has no tool home, so a `codex: login` never reaches it. Give the sandbox an env credential its judge tool reads: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude, `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex. The steps' token from the quick start judges too. A judge also gets the model variables its tool reads, such as `ANTHROPIC_MODEL`, when the entry names them, but never your proxy or CA file: its one way out is the filter. Through a gateway, the filter lets through its base URL in place of the public API, over `https` or plain `http`:

```yaml
# drivers/gateway.yaml: Claude steps, a Codex judge through your gateway
schemaVersion: v1alpha1
name: gateway
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: docker
      image: ghcr.io/acme/agent:1
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN   # the steps
        OPENAI_API_KEY: env:OPENAI_API_KEY                     # a Codex judge
        OPENAI_BASE_URL: env:OPENAI_BASE_URL                   # https://llm.acme.internal:8443/v1 is let through
```

**The sandbox offers a judge only on the tools whose key the definition names.** With only a login, a later runtime of the definition judges instead. This definition scores sessions with `teamai-share-session`, which runs no step in the sandbox: its judge runs on your machine's Claude, through `local`:

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
        codex: login                                          # a login: no judge in a container
  - use: local                                                # takes the judge
```

**A gateway on this machine works as it is.** `localhost`, `127.0.0.1` or `::1` in a credential would be the container's own loopback, so teamai points it at the name your machine has in the container, keeping scheme, port and path. A judge's filter then lets through only that port of your machine.

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4000/anthropic   (your shell)
ANTHROPIC_BASE_URL=http://host.docker.internal:4000/anthropic       (the step, on Docker Desktop)
ANTHROPIC_BASE_URL=http://host.containers.internal:4000/anthropic   (the step, on Podman)
```

Docker Engine on Linux gives your machine no such name, so there the attempt fails `bad_option` before anything is created, naming the variable but never its value. Use an address of your machine the container reaches.

**The image needs `node`** for the filter, and Docker needs to keep DNS inside an internal network: 26.0.0 or later, 25.0.5 or 23.0.11 (older versions forward a container's lookups out, CVE-2024-29018). Otherwise the sandbox offers no judge, and a definition with only the sandbox stops `confined_pending` at the judge. The quick start's image has `node`. Podman offers no judge in this version: its rootless network cannot connect the filter to the judge's network.

What the judge does not enforce:

- The filter sees host names, not requests: a judge can reach any account or path on the provider's host, and on a gateway you let through.
- The judge reads the evidence as the step that wrote it left it. teamai's own hash checks, not the container, catch a step that tampered with it.

## sbx (Docker Sandboxes)

With `provider: sbx`, each attempt runs in a microVM with its own kernel, from the template of the step's tool (or of the `agent` you name). No image to build.

**1. Once per machine:** install Docker Sandboxes, sign in, set a network policy, and sign your tools in with sbx. sbx creates no sandbox without a policy, and teamai never sets one for you.

```sh
sbx login
sbx policy init balanced                 # or deny-all, then allow your model provider:
# sbx policy allow network api.anthropic.com:443
sbx run claude ~/scratch                 # then /login in Claude Code, with your subscription, and exit
sbx rm <that sandbox>                    # its name is in sbx ls; the login stays, kept for every sandbox
sbx secret set openai --oauth            # Codex: your ChatGPT login
sbx secret ls
```

```text
SCOPE      TYPE      NAME        SECRET
(global)   service   anthropic   (oauth configured)
(global)   service   openai      (stored)
```

The login stays in sbx's proxy on your machine, which adds it to the tool's requests, and every new sandbox reuses it: no token in your environment, and no `auth.json` in the attempt's tool home. An API key works the same way: `sbx secret set anthropic`.

**2. Run a workflow with `--driver sandbox`.** teamai ships this definition, so you need none:

```yaml
# drivers/teamai-sandbox.yaml, shipped with teamai
schemaVersion: v1alpha1
name: teamai-sandbox
description: Run each step in a Docker Sandboxes (sbx) microVM of its own, from the template of the step's tool, signed in on the login sbx keeps; this machine takes the judge and interactive steps.
runtimes:
  - use: sandbox
    options: { provider: sbx, max_parallel: 4 }   # no agent: each attempt starts from its own tool's template
  - use: local                                     # takes the judge, which sbx does not offer
```

```sh
teamai workflow start fix --driver sandbox
sbx ls                                   # while it runs: a command step, then a Claude step
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

Write your own definition to pin the template, keep every step in the sandbox, or name credentials:

```yaml
# drivers/sbx-codex.yaml: Codex steps on the login sbx keeps for you, nothing on this machine
schemaVersion: v1alpha1
name: sbx-codex
tool: codex
runtimes:
  - use: sandbox
    options:
      provider: sbx
      agent: codex                       # no credentials: sbx's proxy signs Codex in
```

A step on a tool you signed in neither way gets the sbx command, and the run's command steps still run:

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on codex, which the driver of this run cannot launch here: sandbox: codex cannot sign in inside this sbx sandbox, so a step there would stop at its "Not logged in": sign Codex in once with sbx, `sbx secret set openai --oauth` (or store an API key with `sbx secret set openai`), or add OPENAI_API_KEY: env:OPENAI_API_KEY to the sandbox's credentials. Then start again. Or remove tool from the step.
```

**3. Score what it did.** sbx offers no judge, so a scored step's judge runs on `local`, on your machine's tool:

```sh
teamai workflow start review --driver sandbox
```

```text
ℹ run:rb2152f12cb75a939:review:1: review-quality good (teamai-score run refcf49f79792650e).
{"data":{"done":{"run":"rb2152f12cb75a939","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

What differs from a container:

- The worktree is the sandbox's workspace. The git directories, the result directory, the run directory and the tool home are extra workspaces at their host paths, the git ones read-only (`/home/me/acme/app/.git:ro`). sbx does not follow a linked worktree's `.git` to the main checkout by itself, so teamai names those paths. `git status` works, and `git commit` fails.
- The step runs as sbx's `agent` user. Files it writes on your disk are still yours.
- Each `sbx exec` gets the step's names with `-e NAME`, never a value in the command line. A strict step's withheld names, such as `GH_TOKEN`, which sbx sets for its proxy, are unset in the step's process. A step's own `HOME`, `XDG_*`, `SBX_*` or `DOCKER_*` is not passed: the sbx CLI reads those itself, and the sandbox keeps its own.
- A cancel or a limit runs `sbx stop`; the next exec starts the sandbox again. When the attempt ends, teamai runs `sbx rm --force`. sbx also stops an idle sandbox on its own, and that is fine.

**A gateway on your machine** works as it is: teamai points `http://127.0.0.1:4000` at `host.docker.internal:4000`, which sbx's proxy sends to `localhost`. Your sbx policy decides whether a sandbox reaches it, and teamai asks it (`sbx policy check`, read-only) before the attempt opens. When it does not, the step fails with the rule to add, and teamai never edits the policy:

```text
✖ Step "fix" failed with runtime_failed: Step runtime "sandbox" could not open attempt a2695fde5 (sandbox_unavailable): ANTHROPIC_BASE_URL points at port 4000 of this machine, which your sbx network policy does not let a sandbox reach. Allow it once with `sbx policy allow network localhost:4000`, and start again.
```

**sbx offers no judge.** A confined judge must reach its model provider only, and an sbx sandbox reaches every host your sbx policy allows: a balanced policy allows package registries and code hosts, through which a judge could send what it reads. A per-sandbox rule can only deny hosts it names, and policy profiles come from your organization's sbx governance, so teamai has no way to narrow one sandbox to one host. List `local`, or a `docker` sandbox, after the sbx one to take the judge:

```yaml
# drivers/sbx-judged.yaml: steps in sbx, judges in a docker sandbox
schemaVersion: v1alpha1
name: sbx-judged
tool: claude
runtimes:
  - use: sandbox
    options: { provider: sbx }
  - use: sandbox
    options: { provider: docker, image: ghcr.io/acme/agent:1, credentials: { ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY } }
```

What sbx itself does not hide from a step: sbx forwards your SSH agent unless you turn it off in sbx, and its proxy adds a stored global forge secret (`sbx secret set github`) to every sandbox's requests to that forge. To keep them from steps, turn forwarding off and scope or remove that secret.

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

## seatbelt and bwrap

`seatbelt` (macOS 14 or later) and `bwrap` (Linux, [bubblewrap](https://github.com/containers/bubblewrap)) run each step as a sandboxed process on this machine, with this machine's own tools: no image and no daemon. They take only `provider` and `credentials`.

```yaml
# drivers/native.yaml
schemaVersion: v1alpha1
name: native
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: seatbelt                 # bwrap on Linux
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

- The step writes its worktree, its result and its tool home, and reads the git directories and the directories on your `PATH` (under your home, only the `bin` directory itself). It cannot read your home or your temp directory, so your SSH keys, logins and the repositories there are out of reach: its `HOME` and `TMPDIR` are empty directories of its own. On `bwrap` it sees nothing else of this machine but its system directories. On `seatbelt` a repository outside your home, such as under `/opt` or `/Volumes`, stays readable.
- Its environment holds `PATH`, `USER`, `SHELL`, `LANG` and `TERM`, plus what teamai gives the step. None of your other variables reaches it.
- It shares this machine's network, so a base URL on `localhost` or `127.0.0.1` reaches it as is.
- A Claude login in the macOS Keychain or in `~/.claude` is not read there: name a key in `credentials`, as for a container.
- `seatbelt` confines files only, through `sandbox-exec`. A step with `requires: { isolation: sandbox }` or `permissions: unattended` is not offered to it, and a process the step starts in a session of its own (`setsid`) outlives the step. `bwrap` also gives each step its own process, IPC and user namespaces, and takes both.

When `bwrap` is missing, or AppArmor on Ubuntu 24.04 or later keeps it from creating a namespace, `init` fails `sandbox_unavailable` with the fix, and nothing runs on the host:

```sh
sudo apt install bubblewrap
```

## Vercel

`vercel` runs each attempt in its own [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), a microVM on Vercel. Its image ships Claude, so it offers Claude steps.

```yaml
# drivers/hosted.yaml
schemaVersion: v1alpha1
name: hosted
tool: claude
runtimes:
  - use: sandbox
    options:
      provider: vercel
      timeout: 2h                        # optional: the sandbox's lifetime, 1m to 5h
      runtime: node24                    # optional: Vercel's image
      provider_auth:                     # optional: where teamai reads the Vercel sign-in
        VERCEL_TOKEN: file:~/.config/vercel-token
      credentials:
        ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY
```

- teamai signs in to Vercel from `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or from `VERCEL_OIDC_TOKEN` (`vercel link`, then `vercel env pull`). `provider_auth` names another variable or a file for any of them. They are read on this machine and never reach the step.
- teamai copies the worktree, the git directories (read-only), the run's files and the tool home in at their host paths. At the end of the step it copies the worktree, the result and the tool home back, changes and deletions alike. The git directories and the run's files are not copied back. A link the step planted comes back as a link, and nothing is written outside the place.
- Each sandbox is created with persistence off and deleted when the attempt closes. Unset, `timeout` lasts until 5 minutes past the step's time limit, or 45 minutes for a step with none. A sandbox must last those 5 minutes past the time limit, to copy the step's work back: a `timeout` that ends sooner, or a time limit more than 5 hours away, fails the step `bad_option` on `timeout` before any sandbox exists.
- A sandbox on Vercel cannot reach this machine, so a credential such as `ANTHROPIC_BASE_URL` on `localhost` or `127.0.0.1` fails `bad_option`.
- A sandbox left behind shows in the Vercel dashboard (Sandboxes) as `teamai-<home id>-<run>-<attempt>`. The next attempt that opens deletes it, or its timeout ends it.

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

When teamai is killed while a step runs, the runtime keeps running that step's process until it ends and records how it ended. On `sbx`, the resumed run finds the sandbox again by its name (`sbx ls`). `teamai workflow resume <run> --driver containers` then follows the [step runtime rules](workflow-advanced.md#driver-definitions-and-step-runtimes): an exec that already finished is read back, and one still running is stopped and its step fails `runtime_interrupted`, keeping its work. The container is removed when the attempt closes.

```sh
teamai workflow resume r7c41d09e2b6a5f13 --driver containers
teamai workflow retry r7c41d09e2b6a5f13 review      # goes on from the work the stopped pass kept
```

A runtime killed while `docker run`, `podman run` or `sbx create` creates a sandbox can leave it behind with no attempt that still owns it. Each container carries a `teamai.owner` label naming the teamai home that created it; sbx takes no labels, so each sbx sandbox's name starts with that id instead (`teamai-<home id>-<run>-<attempt>`). Once the next step that opens a sandbox on that provider is accepted, teamai removes, with `--force`, every container or sandbox of this home whose attempt is no longer recorded, and a judge's filter and network with it. That cleanup runs in the background: no step, cancel or close waits for it. Containers of another member or another home, containers with no `teamai.owner` label, and sbx sandboxes whose name does not start with this home's id are never touched. When a list or removal fails, it prints one warning on stderr and the step goes on.

```sh
docker ps -a --filter label=teamai.owner --format '{{.Names}} {{.Label "teamai.owner"}}'
# teamai-r7c41d09e2b6a5f13-a3b90c2f 5f0c2a9e1d7b4c38    its attempt closed before it landed: the next step on docker removes it
sbx ls -q
# teamai-5f0c2a9e1d7b4c38-r7c41d09e2b6a5f13-a3b90c2f   the same, on sbx: the next step on sbx removes it
# teamai-r7c41d09e2b6a5f13-a3b90c2f                    named by an older teamai: kept; remove it with sbx rm --force
```

## Errors

| Error | What happened | Next step |
| --- | --- | --- |
| `sandbox_unavailable` | `sbx`, `docker` or `podman` is not installed, its daemon or machine is not running, sbx has no network policy yet, the image cannot be pulled, or your sbx policy does not let a sandbox reach the port of this machine a base URL names. Nothing runs on the host instead. | Install or start it: `sbx daemon start`, Docker Desktop, `sudo systemctl start docker`, or `podman machine start`. For sbx, `sbx policy init balanced`, or the `sbx policy allow network localhost:<port>` the message names. For an image, check its name and `docker login <registry>`. |
| `tool_unavailable` | The step's tool cannot sign in inside the sandbox | The command the message names: on sbx, `sbx run claude <any dir>` then `/login`, or `sbx secret set openai --oauth`; in a container, `claude setup-token`, then export `CLAUDE_CODE_OAUTH_TOKEN` and name it in `credentials` |
| `credential_missing` | A credential's variable is not set where teamai runs, or a judge got no env credential its tool reads | Set the variable the message names, or add the key it names to `credentials` |
| `confined_pending` | No runtime of the definition offers the judge's tool: the image lacks `node` or that tool, the definition names no key for it, Docker is older than 26.0.0, or the provider is `podman` or `sbx` | Add `node` and the tool to the image, add the tool's key to `credentials`, update Docker, or list `local` in the definition |
| `bad_option` | A key or value in `options` is wrong (for `sbx`, `agent: shell`), or, on Docker Engine on Linux, a credential such as `ANTHROPIC_BASE_URL` points at `localhost` or `127.0.0.1`, which a container there cannot reach | Fix the definition and push it; for a base URL on Linux, use an address of your machine the container reaches |
| `sandbox_failed` | The engine could not create or find the attempt's container or sandbox, for example because Docker Desktop quit mid-run. A container it could not find is kept as the attempt's, never taken as gone. | Read the message in the step failure. Start the engine again, then remove what is left: `docker ps -a --filter label=teamai.run=<run>` or `sbx ls` lists it, and the message names the `docker rm --force` or `sbx rm --force` command |
| `cancel_failed` | A cancel or a limit could not confirm the step stopped: the engine refused the stop, or the stop (a judge's removal included) and the end of the step's process took over 10 s. What ran there may still run, so teamai keeps the container, the work and the login. Example: `docker could not stop the processes in container teamai-r0123abcd-a0123abcd: Cannot connect to the Docker daemon. They may still run; remove the container with docker rm --force teamai-r0123abcd-a0123abcd.` | Start the engine again, then run `teamai workflow cancel <run>` again: the runtime stops the step and closes its place. Or remove it with the `docker rm --force` or `sbx rm --force` command the message names |
| **Not closed** in run details | The engine could not remove the attempt's container or sandbox, or the removal and the end of what ran there took over 10 s, so what ran there may still run. The run ends as it would. | `docker rm --force <container>` or `sbx rm --force <sandbox>`, as the message says. Once nothing of it runs, `teamai workflow cancel <run> --release <attempt>` lets the attempt go: the runtime forgets the place even when it cannot remove it, and its message still names the `rm --force` command |
| `runtime_interrupted` | teamai restarted while the step ran | `teamai workflow retry <run> <step>` |

## Not in this version

- Codex on a login dedicated to teamai in a container. On `sbx`, Codex signs in with `sbx secret set openai --oauth`.
- Network rules for steps. `requires.network: false` is listed in `unenforced`, and a strict one waits for a driver that declares it. Only a judge's network is filtered.
- A judge on a tool login. A judge signs in with an env credential.
