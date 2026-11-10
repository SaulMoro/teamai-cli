import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = path.join(ROOT, 'scripts/check-docs.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
// Each run of the check is a new process that compiles and loads about 320 TypeScript modules: about 1 s of one core
// when the machine is idle. A run without --only also pulls every workflow example of the guide pages into a temporary
// team repo and runs the lease examples through the engine, with about 120 short git processes: about 4 s of one core
// when the machine is idle, and several times that while the full suite keeps every core busy. A case gets 30 s per run.
// Cases run one at a time: run concurrently on a CI runner busy with the full suite, they split the same cores and every
// full run passed 30 s.
const RUN_MS = 30_000;
vi.setConfig({ testTimeout: RUN_MS });
/** The shipped tool ids check-docs generates for teamai/tool-facts. */
const TOOL_IDS = 'oxlint-plugin-teamai/tool-ids.generated.json';
/** The source that declares DriverCan. */
const DRIVER_CAN = 'src/workflow/requirements.ts';

function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-docs-command-'));
  dirs.push(root);
  // The shipped driver definitions are checked against the guide blocks that show them.
  // package.json's `bin` lists the runtimes teamai ships, whose options the guide examples are checked against.
  // workflow-engine.md names the keys DriverCan declares in requirements.ts.
  for (const name of ['docs', 'skill-data', 'skills', 'drivers', 'package.json', 'AGENTS.md', '.github', TOOL_IDS, DRIVER_CAN, ...fs.readdirSync(ROOT).filter((file) => /^README.*\.md$/.test(file))]) {
    fs.cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  return root;
}
function run(root: string, ...args: string[]) {
  const child = spawnSync(process.execPath, [command, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  expect(child.error).toBeUndefined();
  return { status: child.status, output: child.stdout + child.stderr };
}

it('check refuses a stale command reference without rewriting it', () => {
  const root = checkout();
  const reference = path.join(root, 'skill-data/core/references/commands.md');
  fs.writeFileSync(reference, 'stale commands\n');
  // Generated files are compared whatever --only names, so the cheapest related check is enough.
  const checked = run(root, '--only=skill-commands-exist');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Generated documentation is stale: skill-data/core/references/commands.md');
  expect(fs.readFileSync(reference, 'utf8')).toBe('stale commands\n');
});
it('write regenerates the command reference and a second write is stable', () => {
  const root = checkout();
  const reference = path.join(root, 'skill-data/core/references/commands.md');
  fs.writeFileSync(reference, 'stale commands\n');
  expect(run(root, '--write').status).toBe(0);
  const generated = fs.readFileSync(reference, 'utf8');
  expect(generated).toContain('# teamai command reference');
  expect(generated).toContain('teamai workflow start');
  expect(run(root, '--write').status).toBe(0);
  expect(fs.readFileSync(reference, 'utf8')).toBe(generated);
  expect(run(root).status).toBe(0);
}, 3 * RUN_MS);
it('check refuses stale support pages in both languages and write repairs them', () => {
  const root = checkout();
  const pages = ['docs/guide/tool-support.md', 'docs/guide/zh-CN/tool-support.md'];
  for (const page of pages) fs.writeFileSync(path.join(root, page), 'stale support\n');
  const checked = run(root);
  expect(checked.status).toBe(1);
  for (const page of pages) expect(checked.output).toContain(`Generated documentation is stale: ${page}`);
  for (const page of pages) expect(fs.readFileSync(path.join(root, page), 'utf8')).toBe('stale support\n');
  expect(run(root, '--write').status).toBe(0);
  for (const page of pages) expect(fs.readFileSync(path.join(root, page), 'utf8')).toContain('Claude');
  expect(run(root).status).toBe(0);
}, 3 * RUN_MS);
it('check rejects a README matrix that disagrees with the tool descriptor', () => {
  const root = checkout();
  const readme = path.join(root, 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('<tr><td>Claude Code</td>', '<tr><td>Invented Tool</td>'));
  const checked = run(root, '--only=readme-matrix');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Documentation check failed: lists every tool but the internal builds');
});
it('check rejects an invented command in served skills', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skill-data/core/SKILL.md'), '\n`teamai extract graph`\n');
  const checked = run(root, '--only=skill-commands-exist');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('unknown command "extract"');
});
it('check rejects removed wiki workflow instructions', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skill-data/wiki/SKILL.md'), '\nRun GRAPH-CAPABILITIES.md first.\n');
  const checked = run(root, '--only=team-wiki-codebase-skill');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('does not point at GRAPH-CAPABILITIES.md');
});
it('check rejects a syntactically valid workflow example the engine cannot run', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('needs: [compile]', 'needs: [missing-build-step]'));
  const checked = run(root, '--only=workflow-docs-examples');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow.md');
  expect(checked.output).toContain('missing-build-step');
});
it('check pulls an unnamed workflow fragment on a page that is not a workflow page, and names its page and line', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/dashboard.md');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${before}\n\`\`\`yaml\nschemaVersion: v1alpha1\ndescription: Review the change.\nsteps:\n  - id: review\n    prompt: Review the change.\n    retries_forever: true\n\`\`\`\n`);
  const checked = run(root, '--only=workflow-docs-examples');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain(`docs/guide/dashboard.md:${before.split('\n').length + 2}`);
  expect(checked.output).toContain('retries_forever');
});
it('check rejects a driver definition example whose runtime options teamai refuses, naming its page and line', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow-advanced.md');
  const before = fs.readFileSync(page, 'utf8');
  const kept = '      max_parallel: 2\n';
  expect(before).toContain(kept);
  fs.writeFileSync(page, before.replace(kept, `${kept}      credentials: { claude: login }\n`));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toMatch(/docs\/guide\/workflow-advanced\.md:\d+ \(# drivers\/sandboxed\.yaml\)/);
  expect(checked.output).toContain('credentials.claude');
});
it('check reads a driver definition on any guide page, and rejects a key a definition does not take', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/dashboard.md');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${before}\n\`\`\`yaml\n# drivers/boxed.yaml\nschemaVersion: v1alpha1\nname: boxed\nruntime:\n  - use: sandbox\n\`\`\`\n`);
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain(`docs/guide/dashboard.md:${before.split('\n').length + 2}`);
  expect(checked.output).toContain('runtime');
});
it('check rejects a driver definition example whose options the runtime itself refuses', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/dashboard.md');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${before}\n\`\`\`yaml\n# drivers/boxed.yaml\nschemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: sandbox\n    options:\n      provider: sbx\n      image: ghcr.io/acme/agent:1\n\`\`\`\n`);
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain(`docs/guide/dashboard.md:${before.split('\n').length + 2}`);
  expect(checked.output).toContain('Provider sbx takes no option "image"');
});
it('check reads each runtime of an entry through another with that runtime\'s own options', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/dashboard.md');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${before}\n\`\`\`yaml\n# drivers/boxed.yaml\nschemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: t3\n    through: sandbox\n    options:\n      t3: { environment: local }\n      sandbox: { provider: sbx, image: ghcr.io/acme/agent:1 }\n\`\`\`\n`);
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain(`docs/guide/dashboard.md:${before.split('\n').length + 2}`);
  expect(checked.output).toContain('runtimes.0 (sandbox) option image: Provider sbx takes no option "image"');
});
it('check rejects a driver definition example naming a runtime teamai does not ship and the guide does not define', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/dashboard.md');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${before}\n\`\`\`yaml\n# drivers/boxed.yaml\nschemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: sandbx\n\`\`\`\n`);
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('runtimes.0 names sandbx');
});
it('check fails for a runtime teamai ships whose options it cannot validate', () => {
  const root = checkout();
  const manifest = path.join(root, 'package.json');
  const shipped = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({ ...shipped, bin: { ...shipped.bin, 'teamai-runtime-vm': 'dist/runtime-vm.js' } }));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('teamai-runtime-vm');
});
it.each([
  ['teamai codebase --no-such-flag', 'unknown flag "--no-such-flag"'],
  ['teamai skill gett core', 'unknown subcommand "gett"'],
])('check refuses invalid skill usage %s', (invocation, diagnostic) => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skills/teamai/SKILL.md'), `\n\`${invocation}\`\n`);
  const checked = run(root, '--only=skill-commands-exist');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('skills/teamai/SKILL.md');
  expect(checked.output).toContain(diagnostic);
});

it('write changes only its generated files', () => {
  const root = checkout();
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => fs.statSync(path.join(root, file)).isFile());
  const before = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  expect(run(root, '--write').status).toBe(0);
  const generated = new Set(['skill-data/core/references/commands.md', 'docs/guide/tool-support.md', 'docs/guide/zh-CN/tool-support.md', TOOL_IDS]);
  for (const file of files.filter((name) => !generated.has(name.split(path.sep).join('/')))) {
    expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toBe(before.get(file));
  }
});

it('check executes the advanced lease examples and rejects changed engine output', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow-advanced.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('"revision":1', '"revision":99'));
  const checked = run(root, '--only=workflow-docs-examples');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow-advanced.md: the next table answers what the engine answers');
});

it('check refuses a deployed stub that pre-approves starting any workflow', () => {
  const root = checkout();
  const stub = path.join(root, 'skills/teamai/SKILL.md');
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8').replace('Bash(teamai workflow start --describe:*)', 'Bash(teamai workflow start:*)'));
  const checked = run(root, '--only=skill-content');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('pre-approves only read-only skill and workflow calls');
});
it('check refuses a workflow skill whose run-next rule stops naming a refusal only the person may confirm', () => {
  const root = checkout();
  const skill = path.join(root, 'skill-data/workflow/SKILL.md');
  const text = fs.readFileSync(skill, 'utf8');
  const rule = 'and an `owner_active` or a `confirm_needed` whose `next` carries `--confirmed`.';
  expect(text).toContain(rule);
  fs.writeFileSync(skill, text.replace(rule, 'and a `confirm_needed` whose `next` carries `--confirmed`.'));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('owner_active');
});
it('check refuses a quoted glossary Avoid spelling in prose and ignores it in code, also an indented fence, HTML and link targets', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'docs/guide/workflow.md'), '\nIn folder resource form, a hook carries its script.\n');
  fs.appendFileSync(path.join(root, 'docs/guide/sharing.md'), '\n`folder resource`, <img alt="folder resource">, [x](folder-resource.md)\n\n- a step\n\n  ```sh\n  cp -r folder resources/ out/\n  ```\n');
  const checked = run(root, '--only=glossary-terms');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow.md uses "folder resource" 1 times.');
  expect(checked.output).not.toContain('docs/guide/sharing.md');
});
it('check refuses a DriverCan key the workflow engine page does not name', () => {
  const root = checkout();
  const source = path.join(root, DRIVER_CAN);
  const text = fs.readFileSync(source, 'utf8');
  const keys = 'workflow?: true;\n};';
  expect(text).toContain(keys);
  fs.writeFileSync(source, text.replace(keys, 'workflow?: true; queue?: true;\n};'));
  const checked = run(root, '--only=driver-can');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Documentation check failed: docs/dev/workflow-engine.md names every key DriverCan adds to the protocol\'s can');
  expect(checked.output).toContain('queue');
});
