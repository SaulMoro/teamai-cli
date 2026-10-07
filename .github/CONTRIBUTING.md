# Contributing to TeamAI CLI

Thanks for your interest in improving TeamAI! This document explains how to get a dev environment running, how to structure changes, and how to get your PR merged.

## Development Setup

```bash
git clone https://github.com/Tencent/teamai-cli.git
cd teamai-cli
npm install
```

### Common commands

```bash
npm run build          # Build with tsup → dist/
npx tsc --noEmit       # Type check
npm run lint           # oxlint; CI fails on any warning
npx vitest run         # Run unit tests
npx vitest run --coverage
npm run test:e2e       # Build and run E2E tests; remote cases require credentials
```

`npm run lint` needs Node ^20.19 or >=22.12 (oxlint's requirement); the CLI itself still supports Node 20.

### Running your local build

```bash
npm run build && npm link
teamai --version
```

### Dogfood against a public team repo

All contributors should exercise pull, hooks, and recall while developing the CLI. Create a **regular** (not template) public team repo under [teamai-hub](https://github.com/teamai-hub), e.g. `https://github.com/teamai-hub/teamai-cli-dev`, with `main` branch protection (PR + review). Put only public-safe skills / rules / docs there.

In the **CLI clone** (not as `teamai init .`):

```bash
npm run build && npm link
teamai init https://github.com/teamai-hub/teamai-cli-dev --scope project --role dev
teamai pull
git status   # nothing under .teamai/ or tool dirs should be staged for this repo
```

Pitfalls:

- Init the **canonical hub URL**, not a personal fork. `teamai init <url>` treats that URL as the team repo; a fork diverges immediately, and GitHub push/PR today targets the configured remote (no fork-to-upstream flow).
- Do **not** run `teamai init .`. That is single-repo mode: it turns the CLI source tree into the team repo and writes scaffolding at the repo root (easy to commit by mistake).
- `Push failed (you can push manually later)` on member registration is **expected** without write access. Local config is still saved; `teamai pull` still works.

#### Write access and team stats

`digest` / `dashboard` read `stats/`, `sessions/`, and `members/` from the team repo. Those files are written via git, so **no write ⇒ not in team stats**.

Giving every internet contributor write on the hub repo is not acceptable.

| Who | Hub repo access | Required setup | In team digest |
|-----|-----------------|----------------|----------------|
| Contributors | read | `init` + `pull` | no |
| Collaborators (after a few PRs) | write, `main` protected | full, including reports | yes |

## Project Layout

```
src/
  providers/         # git hosting provider abstraction
    github/          # GitHub (gh CLI or GITHUB_TOKEN)
    tgit/            # Tencent TGit (gf CLI)
  resources/         # per-resource-type handlers (skills, rules, docs, env, ...)
  utils/             # shared helpers (git, fs, logger, prompt, ...)
  *.ts               # top-level command entry points (init, push, pull, ...)
```

See [docs/providers.md](../docs/providers.md) for how to add a new git provider.

## Making a Change

1. Fork the repo and create a feature branch from the latest `origin/main`. Prefer a git worktree for code changes when practical.
2. Write tests for your change (we target 80%+ coverage).
3. Run `npx vitest run`, `npx tsc --noEmit` and `npm run lint` — all must pass.
4. Use conventional commits where possible: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
5. Open a PR with a clear description: what's the problem, what's the fix, anything reviewers should pay attention to.

Your PR also gets an informational `Code Erosion` report (SlopCodeBench verbosity/erosion metrics) posted as a comment — it never blocks the merge and is just there to flag creeping complexity. See [docs/ci-code-erosion.md](../docs/ci-code-erosion.md).

## Coding Style

- TypeScript strict mode is on; avoid `any` unless genuinely needed.
- Prefer async/await over callbacks.
- Keep commands in `src/*.ts` thin — heavy lifting lives in `src/resources/` or `src/utils/`.
- Avoid narrating comments ("// increment counter"). Comments should explain _why_, not _what_.

## Testing Guidelines

- Unit tests go in `src/__tests__/`. Mirror the source file name (`init.ts` → `init.test.ts`).
- Mock external I/O (git, fetch, child_process) at the module boundary.
- Avoid relying on real network access unless guarded by an env variable (like `TEAMAI_TEST_TOKEN`).

For local iterations, run the E2E files covering the changed behavior:

```bash
npm run test:e2e -- src/__tests__/e2e/git-hook-new-worktree.test.ts
# Select a case within the affected file:
npm run test:e2e -- <test-file> -t "<test-name>"
```

`npm run test:e2e` builds once before starting Vitest. Test files run with up to four workers locally and two in CI. On a resource-constrained machine, pass `--maxWorkers=2` after `--`. E2E tests must use the prepared build rather than rebuild it while other files use the CLI.

Most cases use local fixtures. Cases requiring remote credentials skip when those credentials are absent; see [CI E2E setup](../docs/ci-e2e-setup.md) for the live fixture configuration.

Run the full local suite with `npm run test:e2e` when changing the E2E runner, shared fixtures, or test isolation. CI runs the full suite. A PR changing CLI runtime behavior needs a representative real-CLI verification of the affected behavior, which can be a focused E2E run. Include the exact command and result in the PR. Docs-only and tests-only changes do not require a real-CLI verification record.

## Bug Reports & Feature Requests

Please file issues at [github.com/Tencent/teamai-cli/issues](https://github.com/Tencent/teamai-cli/issues). Include:

- What you tried to do
- What happened (error output, stack trace)
- What you expected
- Your OS, Node.js version, and `teamai --version`

## Security

For security issues, please do **not** open a public issue. Email the maintainers or use GitHub's private vulnerability reporting.

## License

By contributing, you agree your contribution will be licensed under the [MIT License](../LICENSE).
