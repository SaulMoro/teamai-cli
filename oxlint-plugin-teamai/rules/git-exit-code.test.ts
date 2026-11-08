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
rule.valid('allows the exit-code git', `const { code } = await git(root, ['merge-base', '--is-ancestor', a, b]);`);
rule.valid('leaves tests alone', `await git.raw(['merge-base', '--is-ancestor', a, b]);`, { filename: 'src/__tests__/x.test.ts' });
