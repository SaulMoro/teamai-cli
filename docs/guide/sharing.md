# Core Harness

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

## Skills

```bash
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: Deploy a service for the team
---
# Deploy Helper
When the user requests a deployment, follow these steps:
1. Check that the current branch is master
2. Run tests `npm test`
3. Build `npm run build`
4. Deploy `./deploy.sh`
EOF

teamai push
teamai push --role pm
```

`push` fills in `name` and `description` when the frontmatter is missing. A new skill goes to `skills/<ns>/<name>/`, where `<ns>` comes from your role or the active projects. Several choices ask which one. `--role` picks one.

## Rules

```bash
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# Code Review Guidelines
- All functions must have JSDoc comments
- `any` type is not allowed
EOF

teamai push
```

A rule members cannot delete goes in `teamai.yaml`:

```yaml
sharing:
  rules:
    enforced: [code-review-guide]
```

A rule you wrote yourself stays. `push` writes back only the body of a rule the team already has.

## Agents

`agents/<name>.yaml`. `name` matches the filename. Commit it, or run `teamai push` after editing the copy in a tool.

```yaml
# agents/code-reviewer.yaml
name: code-reviewer
description: Review a change before it is pushed
instructions: |
  Read the diff and comment on correctness, tests, and risks.
tools: [Read, Grep]
targets: [claude, cursor]
```

Leave `targets` out to send the agent to every installed tool. An agent for one role goes in `agents/<namespace>/`, declared under `resources.agents`.

```bash
teamai push
teamai push --role frontend
teamai remove agents code-reviewer
```

`pull` writes each tool's own format into that tool's agents directory: `<name>.toml` for the Codex family, `<name>.agent.md` for Copilot, `<name>.json` for Kiro, and `<name>.md` for the rest.

### Model aliases

A name such as `model: strong` is mapped per tool in `models/aliases.yaml`:

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
  fast:
    claude: haiku
```

An alias starts with a lowercase letter, then lowercase letters, digits, or `-`. A namespace that needs its own mapping uses `models/<ns>/aliases.yaml`.

## Env, hooks and MCP servers by namespace

The root file reaches everyone. A namespace declared under `resources:` reaches only members who have it active, and replaces the root entry of the same name.

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

## Env (environment variables)

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add API_ENDPOINT https://checkout.internal --project checkout
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai push
```

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint
```

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
    url: https://github.com/settings/tokens
```

Secret values stay off the repo. On each machine:

```bash
teamai env set GITHUB_TOKEN
teamai env exec -- gh pr create
```

### Shell environment by directory

Team env reaches a shell by directory: a shell started in a directory gets the env of the scope that governs it, so several projects open at once each get their own. The shell profile carries one teamai block, the same for every scope, which sources `~/.teamai/env-loader.sh`. Each project pull records its scope and machine-data partition in `~/.teamai/env-scopes`, keyed by the git directory a checkout shares with its worktrees (or the directory itself outside git), and the loader looks the shell's directory up there:

- in a project, the project's `env.sh`, and nothing of the user scope's unless the project sets `inheritUserScope: true`: then the user scope's variables load first and a key the project declares, as a variable or a secret, is the project's (a project secret without a value stays unset rather than take the user scope's value); the user scope's secrets never load;
- in a linked worktree, its project's, before the worktree has pulled;
- in a project no pull has registered yet, none, once teamai has set it up, migrated it or started a pull there;
- anywhere else, the user scope's;
- in a directory with a `.git` in it or above whose repository git cannot read (git not installed, a broken `.git`, unreadable metadata, `safe.directory`), none: which scope governs it is unknown. `env exec` applies no team env there either and says why; without git installed, directories outside any repository still get the user scope's.

The user scope's `env.sh` loads nowhere when its team sets `injectShellProfile: false`, under a project that inherits it included.

While `~/.teamai/env-scopes` exists but cannot be read (its permissions, say), the loader cannot tell which scope governs a directory, so it loads no team env anywhere. A pull then fails, names the file and leaves it as it is, and uninstall keeps it, the loader and every project's data under `~/.teamai/projects`; fix the file's permissions and run the command again.

A project whose team sets `injectShellProfile: false` loads neither its own `env.sh` nor an inherited user scope's.

Opting out also takes out, on the next pull, any block an earlier version wrote that sources that scope's `env.sh`, from every candidate file; for the user scope, that includes the oldest block that exported the variables inline. Another scope's block stays until that scope pulls.

An interactive shell switches env on `cd` and puts back a value you had set before entering the project. The loader routes before your Bash `PROMPT_COMMAND` and zsh `chpwd_functions` hooks, so they see the env for the current directory, including commands you add to `PROMPT_COMMAND` after the loader; Bash prompt hooks retain the preceding command's `$?` and `PIPESTATUS`. zsh reads the block from `.zshenv`, which every zsh reads, so the `zsh -c` a tool runs a command with gets the env of its own directory. bash reads no startup file for `bash -c`, so the loader points `BASH_ENV` at itself, sources your existing `BASH_ENV` (with `BASH_ENV` naming your file while it runs), then loads the team env, so a team value wins a key both set. Each bash runs your file once. A `bash` that `teamai env exec` starts sources your `BASH_ENV` the same way, before the team values. Team env files cannot set `BASH_ENV`, `ENV`, `ZDOTDIR`, `HOME`, `PWD`, `PROMPT_COMMAND`, the zsh hook arrays, `BASH_VERSION`, `BASH_VERSINFO`, `ZSH_VERSION`, `PIPESTATUS`, `IFS`, the Bash read-only `SHELLOPTS`, `BASHOPTS`, `UID`, `EUID`, and `PPID`, names beginning `__TEAMAI_` or `__teamai_`, or the `TEAMAI_ENV_SH_<64 hex digits>` markers `env.sh` exports; these names control shell startup, hooks, or loader state, or Bash refuses to set them. Pull, `env set`, and `env exec` warn when a team declares them because TeamAI ignores those values. Other shells (fish, PowerShell) run no loader, and with neither bash nor zsh installed pull writes no profile block: run the commands that need team env through `teamai env exec --`, which resolves the same way.

A pull no longer rewrites the profile to switch projects. The first pull with a version that has the loader, also in a project without env, takes out the per-scope blocks earlier versions wrote, from every candidate file, together with writing the loader block (if any of those writes fails, the pull puts back every file it changed and reports the failure; a file reached by two names, such as a `.zshrc` linked to `.zshenv` or into a dotfiles repo, is rewritten once, through the link, which stays a link, also when it points at a file or directory not there yet; putting back removes only the file the pull created and any directory it made for it, never the link; a profile file that exists but can't be read stops the pull, rather than being overwritten), and says so once when a project loses the user scope's variables it used to get.

On `pull`, when `injectShellProfile` is enabled (default), the env block goes into `~/.zshenv` (`$ZDOTDIR/.zshenv` when `ZDOTDIR` is set) if `$SHELL` is zsh, otherwise `~/.bashrc` — except on Windows: `$SHELL` is normally unset there, and Git Bash starts as a *login* shell that never reads `.bashrc`, so teamai instead prefers an existing `~/.bash_profile`, then `~/.bash_login`, then `~/.profile`, falling back to `~/.bashrc` only when none of them exist (a zsh installed via MSYS2/Cygwin, which does set `$SHELL`, still resolves to `.zshenv`).


This matches Git for Windows' own fallback in `/etc/profile.d/bash_profile.sh`, whose guard is `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]` — it only synthesizes a `.bash_profile` that sources `.bashrc` in that same one case, which is why a stray `~/.profile` (even one that just sources something else, e.g. `~/.local/bin/env`) is enough to make `.bashrc` alone go unread. Override the target file for bash with `sharing.env.shellProfilePath` in `teamai.yaml`; outside Windows it picks the file for the startup mode that reads it, and bash's other mode still gets the block by the rules below unless its file already sources the override. For zsh, teamai always installs the block in `.zshenv` (under `$ZDOTDIR` when set), because `zsh -c` never reads `.zshrc`; an override naming another zsh startup file is ignored with a warning, and an older block there is moved to `.zshenv` on pull. The other shell's file (the bash target above for a zsh `$SHELL`, `.zshenv` for a bash one) gets the block too, so a bash started from zsh, or a zsh from bash, also follows each directory: outside Windows, teamai creates it when that shell is installed (on `PATH`); otherwise, and on Windows, only a file that already exists gets the block. `teamai uninstall` and `teamai doctor` cover it with the first. Outside Windows, a login bash (`bash -l`, or the macOS Terminal) reads the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile` that exists instead of `.bashrc`, so that file gets the block too unless it already sources the bash file above. With an override naming a login file, an interactive bash still reads `.bashrc`, which gets the block (created when bash is `$SHELL` or installed) unless it already sources the override. When none of the three exists and bash is `$SHELL` or installed, teamai creates `~/.profile`: it is last in bash's order, so a `~/.bash_profile` you add later still takes over, and a POSIX `sh` that reads `.profile` skips the block. teamai never creates `.bash_profile` or `.bash_login`.

Every pull re-runs this order to find the file the current environment actually reads, then follows every reference from it to one of the other four candidate filenames — transitively, through as many hops as it takes — looking for a candidate that already carries the block, rather than duplicating it. A chain through a file outside that fixed set of five (e.g. a custom `~/.config/shell/profile` some setups source instead) is not followed.

This is what keeps the Git-for-Windows bootstrap above from moving the target out from under it: that same guard condition means a first pull into `.bashrc` leaves the exact state that makes the next login shell auto-generate a `~/.bash_profile` sourcing it, and without following that forwarding relationship the next pull would prefer the newly-created file and inject a second block there, leaving the original — still working, just loaded further away — reported as a dead leftover. The same reasoning covers a plain `.profile` that flat-guards a source of `.bashrc` for interactive shells (`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`), two hops from whatever a login shell reads first.

Only two literal line shapes count as a real reference, though: a bare `source X` / `. X` on a line by itself, or the exact self-referential existence guard Git for Windows itself generates, `test -f X && . X` / `[ -f X ] && . X` (tested and sourced path the same file), also on a line by itself — in both cases `X` must be an unquoted `~/name` or an unquoted-or-double-quoted `$HOME/name` (never a quoted `~`, never a single-quoted `$HOME`: a shell does not expand either, so a reference that looks right there would source a literal, nonexistent path).

Anything else — a trailing redirection or extra argument on the source itself, an `||` fallback, an unrelated `&&`-chained command, a condition this can't independently verify — is not recognized, and falls back to the order-based pick rather than being guessed at. This is a deliberately narrow, closed set of two forms rather than an attempt to parse arbitrary shell conditionals: matching everything a real shell script could do to make a line conditional (or to disguise one as inert text) needs an actual shell parser, and no fixed-size grammar ever finishes that job.

Nothing inside an `if`, `for`/`while`/`until`, `case`, `select`, a function body, or a `(...)`/`{...}` group counts, however it's guarded — none of those are guaranteed to run (a subshell or brace group's body may always run, but its exports never reach the caller either way) — which also means the standard Debian/Ubuntu `.profile` template (the same source, but nested two `if`s deep, checking `$BASH_VERSION` on the way) is not recognized and falls back to the order-based pick. Nothing textually after an unconditional, top-level `return` or `exit` counts either, since control never reaches it.

Anything this can't resolve one way or the other, and a block sitting in a candidate nothing in the chain actually reaches, is never preferred over the order-based pick — otherwise a stale block left by a pre-#682 install would outrank the correct file forever, silently reintroducing #682 on upgrade.

`doctor` (and the check `pull` runs automatically afterward) also flags a per-scope env block an earlier version left behind in a candidate file — e.g. a block a pre-#682 install wrote to `.bashrc` before this file-selection logic changed — even if that block is broken and was never functional. The next pull or `teamai uninstall` removes it. `This directory resolves its team env` starts your `$SHELL` in the directory, runs the loader there, and checks that it loads this scope's `env.sh`; a project a pull has not registered yet fails it until you pull there. With a shell that runs no loader, the check passes and a doctor note names the gap.
## Hooks

`teamai init` installs these built-in hooks:

| Event | What it does |
|-------|----------------|
| `SessionStart` | Pull team resources and record the session start |
| `PostToolUse` | Record skill use |
| `UserPromptSubmit` | Record the prompt |
| `Stop` | Check for a CLI update and record the session end |

```bash
teamai hooks list
teamai hooks inject --dry-run
teamai hooks inject
teamai hooks remove
```

Only tools that are already installed are touched.

Commit the team's own hooks in `hooks/hooks.yaml`. `id` is lowercase letters, digits, and `-`. `builtin` belongs only in the root file. Use it to turn a built-in hook off, or to change its timeout.

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before a commit
    event: PreToolUse
    matcher: Bash
    command: bash ~/.teamai/team-scripts/scan-secret.sh
    timeout: 15
    tools: [claude, cursor]
```

A hook for one project goes in `hooks/<ns>/hooks.yaml`.

```yaml
sharing:
  hooks:
    autoApply: false          # pull only prints a hint; run teamai hooks inject
    requireTeamScripts: true  # command must live under ~/.teamai/team-scripts/
```

Turn team hooks off on this machine with `TEAMAI_HOOKS_DISABLED=1`.

## MCP servers

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    description: GPU inventory and pricing
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

Write secrets as `${VAR}` and declare the key in `env/secrets.yaml`. A server for one project goes in `mcp/<ns>/mcp.yaml`.

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

## Models

Commit `models/models.yaml` yourself. The key stays on each machine. A catalog for one project goes in `models/<ns>/models.yaml`.

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

## Packages

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

After pull, run `teamai packages`.

## Docs

Put files in the team repo's `docs/`. Members receive them on `pull`. To limit a directory, declare it under `resources.docs`:

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```
