import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/git-exit-code', { filename: 'src/workflow/cache.ts' });

rule.invalid('rejects a reachability check through raw', `const reached = await createGit(root).raw(['merge-base', '--is-ancestor', ancestor, tip]).then(() => true, () => false);`,
  (output) => { if (!output.includes('worktree.ts')) throw new Error(output); });
rule.invalid('rejects a quiet existence check through raw', `await git.raw(['cat-file', '-e', revision]);`);
rule.invalid('rejects a quiet diff through raw', `await git.raw(['diff', '--quiet', 'HEAD']);`);
rule.invalid('rejects an exit-code diff through raw', `await git.raw(['diff-index', '--exit-code', 'HEAD']);`);
rule.invalid('rejects a quiet ref check through raw', `await git.raw(['show-ref', '--verify', '--quiet', 'refs/heads/main']);`);
rule.invalid('rejects a quiet check-ignore through raw', `await git.raw(['check-ignore', '-q', file]);`);
rule.invalid('applies in packages too', `await git.raw(['merge-base', '--is-ancestor', a, b]);`, undefined, { filename: 'packages/runtime-t3/src/runtime.ts' });
rule.valid('allows a raw call that fails loudly', `await git.raw(['rev-parse', '--verify', \`\${rev}^{commit}\`]);`);
rule.valid('allows a quiet rev-parse, whose output names the commit', `const sha = (await git.raw(['rev-parse', '-q', '--verify', name])).trim() || null;`);
rule.valid('allows a raw call that reads output', `const out = await git.raw(['symbolic-ref', '--short', 'HEAD']);`);
rule.invalid('rejects an exit-code question read by its code alone, where a git that did not start reads as a no', `const { code } = await git(root, ['merge-base', '--is-ancestor', a, b]);\nconst reached = code === 0;`,
  (output) => { if (!output.includes('gitAnswer')) throw new Error(output); });
rule.invalid('rejects an exit-code question through any git the caller was handed', `const shown = await runGit(dir, ['show-ref', '--verify', '--quiet', ref]);`);
rule.invalid('rejects an exit-code question whose result is read later', `const asked = git(dir, ['check-ignore', '-q', file]);\nconst ignored = (await asked).code === 0;`);
rule.invalid('rejects a quiet rev-parse read by its code, which answers a missing ref with an exit code alone', `const local = await git(main, ['rev-parse', '--verify', '--quiet', ref]);\nif (local.code !== 0) return undefined;`);
rule.invalid('rejects a quiet rev-parse read by its output', `const tip = (await git(repo, ['rev-parse', '--verify', '-q', \`\${ref}^{commit}\`])).stdout.trim();`);
rule.invalid('rejects a quiet symbolic-ref read by its output, where a git that did not start reads as detached', `const head = (await runGit(dir, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();`);
rule.valid('allows a quiet rev-parse read through gitAnswer', `const tip = yesOutput(gitAnswer(await git(repo, ['rev-parse', '--verify', '-q', ref])), 'the tip');`);
rule.invalid('rejects an exit-code question settled by a then that reads its code', `const head = await execCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD']).then((ran) => ran.code === 0, () => false);`);
rule.valid('allows an exit-code question settled through then(gitAnswer)', `const [branch] = await Promise.all([run(dir, ['symbolic-ref', '--quiet', 'HEAD']).then(gitAnswer)]);`);
rule.valid('allows a symbolic-ref that fails loudly', `const head = (await git(dir, ['symbolic-ref', 'HEAD'])).stdout.trim();`);
rule.valid('allows an exit-code question read through gitAnswer', `const reached = gitAnswer(await git(root, ['merge-base', '--is-ancestor', a, b]));`);
rule.valid('allows an exit-code question read through gitAnswer without await', `const reached = gitAnswer(result(['cat-file', '-e', sha]));`);
rule.valid('allows a git call that is not an exit-code question', `const { code, stderr } = await git(root, ['merge', '--no-edit', sha]);`);
rule.valid('leaves tests alone', `await git.raw(['merge-base', '--is-ancestor', a, b]);`, { filename: 'src/__tests__/x.test.ts' });
