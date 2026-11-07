import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { sessionSince } from './sessions.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bundleRuntime, CLAUDE, CODEX, connect, credentialsFile, fakeBrowser, fakeT3, PATH_WITHOUT_T3, signIn, type Connection, type FakeT3, type FakeT3Config, type Line } from './testing/harness.js';

// teamai-runtime-t3 through its stdio entry, against a fake T3 Code server (testing/fake-t3.mjs).

let bundleDir: string;
let executable: string;

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-bundle-'));
  executable = await bundleRuntime(bundleDir);
}, 60_000);

afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

/** The link that opens a thread of the fake's environment in T3 Code's desktop app. */
const linkTo = (threadId: string | undefined): string => `t3code://threads/env-fake-1/${encodeURIComponent(threadId ?? '')}`;

/** A line for the person, which answers no request. */
const isNotice = (line: Line): boolean => line['event'] === 'notice';

/** The notices the runtime wrote so far. */
const noticesOf = (runtime: Connection): Line[] => runtime.lines.filter(isNotice);

describe('teamai-runtime-t3', () => {
  let dir: string;
  let checkout: string;
  let t3: FakeT3;
  const connections: Connection[] = [];

  const start = (env: Record<string, string> = {}): Connection => {
    const runtime = connect(executable, t3, env);
    connections.push(runtime);

    return runtime;
  };

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-')));
    checkout = path.join(dir, 'acme-app');
    fs.mkdirSync(checkout);
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    t3 = fakeT3(dir, checkout);
    await t3.start();
  });

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((runtime) => runtime.close()));
    await t3.stop();
    // A judge's copy left unclosed is read-only.
    execFileSync('chmod', ['-R', 'u+w', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('offers prompt steps for the tools the environment runs, and no command', async () => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      const reply = await runtime.next((line) => line['type'] === 'init');

      expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
      expect(reply).toEqual({
        type: 'init', ok: true, prompt: true, confinedPrompt: true,
        can: {
          exec: false, setup: false, env: false, hitl: true, tokens: false, unattended: false, max_turns: false,
          workspace: ['read-only', 'new', 'continue', 'clone', 'team'], tools: ['claude', 'codex'],
          confined: [{ level: 'best-effort', access: 'read', tools: ['claude', 'codex'] }],
        },
      });
    });

    // The `t3` command on this machine creates a pairing code, and teamai approves its own sign-in with it, as T3's page would.
    it.each(['attended', 'unattended'] as const)('signs in with no page in an %s run, through a pairing code the t3 command creates, and keeps the credential to itself', async (mode) => {
      const browser = fakeBrowser(dir);
      const runtime = start({ PATH: [t3.bin, browser.bin, PATH_WITHOUT_T3].join(path.delimiter) });

      runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local' } });

      const reply = await runtime.next((line) => line['type'] === 'init');
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
      expect(t3.commandRuns()).toEqual([[
        'auth', 'pairing', 'create', '--json', '--base-dir', t3.t3Home, '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '2m', '--label', 'teamai workflow',
      ]]);
      expect(t3.calls().map((call) => call.tool).filter((tool) => tool.startsWith('oauth_'))).toEqual(['oauth_decision', 'oauth_token']);
      expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'auto' });
      expect(browser.visits()).toEqual([]);
      expect(runtime.stderr()).toBe('');
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
      await runtime.close();

      const later = start();
      later.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await later.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(t3.commandRuns()).toHaveLength(1);
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    it.each(['auto-accept-edits', 'approval-required'])('approves its silent sign-in with Auto access in a run whose runtime_mode is %s', async (runtimeMode) => {
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local', runtime_mode: runtimeMode } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'auto' });
    });

    it('signs in through T3\'s page in an attended run with no t3 command, keeps the credential to itself, and a later unattended run reuses it', async () => {
      const browser = fakeBrowser(dir);
      const attended = start({ PATH: `${browser.bin}${path.delimiter}${PATH_WITHOUT_T3}` });

      attended.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

      const signedIn = await attended.next((line) => line['type'] === 'init');
      expect(signedIn, JSON.stringify(signedIn)).toMatchObject({ ok: true });
      expect(browser.visits()).toEqual(['/oauth/mcp/authorize']);
      // The page's link reaches the person while init waits, for a browser that did not open.
      expect(noticesOf(attended)).toEqual([{ event: 'notice', message: expect.stringMatching(/^Approve teamai in T3 Code \(silent sign-in failed: found no t3 command .*\)\. If no browser opened, visit: http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+$/) }]);
      expect(attended.stderr()).toBe('');
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(credentialsFile(t3.home))).mode & 0o777).toBe(0o700);
      await attended.close();

      const unattended = start();
      unattended.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await unattended.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { hitl: false } });
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    describe('when the silent sign-in fails', () => {
      const failures: Array<{ failure: string; path?: () => string; config?: Partial<FakeT3Config>; reason: string | (() => string) }> = [
        // It names the three places it looked, T3's own command first.
        { failure: 'there is no t3 command', path: () => PATH_WITHOUT_T3, reason: () => `found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ${path.join(t3.t3Home, 'bin', 't3')}` },
        { failure: 'the t3 command fails', config: { commandFails: 3 }, reason: 't3 auth pairing create exited with status 3: Could not reach the T3 Code server' },
        { failure: 'T3 refuses the pairing code', config: { decisionRefused: true }, reason: 'T3 Code refused the pairing code with HTTP 400: That pairing code is not valid. Create a new one and try again' },
        { failure: 'T3 redirects with no code', config: { decisionNoCode: true }, reason: 'T3 Code\'s sign-in redirect carried no code (access_denied)' },
        // teamai gives an unattended init 10 s, so a T3 Code that does not answer the sign-in fails it with the reason, well before.
        { failure: 'T3 does not answer the sign-in', config: { decisionMs: 30_000 }, reason: 'the silent sign-in did not finish within 8 s' },
      ];

      /** Every secret the sign-in handled: the pairing codes the t3 command created, and the token T3 issues. */
      const secrets = (): string[] => [...t3.pairingCodes(), 'fake-t3-token-0123456789'];

      it.each(failures)('fails an unattended run login_required, saying why, when $failure', { timeout: 30_000 }, async ({ path: pathOf, config, reason: reasonOf }) => {
        const reason = typeof reasonOf === 'string' ? reasonOf : reasonOf();
        if (config) t3.config(config);
        const runtime = start(pathOf ? { PATH: pathOf() } : {});

        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

        const reply = await runtime.next((line) => line['type'] === 'init', 20_000);
        expect(reply).toEqual({
          type: 'init', ok: false,
          error: {
            code: 'login_required',
            message: `teamai has no valid T3 Code sign-in for ${t3.origin()} and could not sign in through the t3 command (${reason}), and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`,
          },
        });

        for (const secret of secrets()) expect(`${JSON.stringify(reply)}${runtime.stderr()}`).not.toContain(secret);
      });

      it.each(failures)('opens T3\'s page in an attended run, saying why, when $failure', { timeout: 30_000 }, async ({ path: pathOf, config, reason: reasonOf }) => {
        const reason = typeof reasonOf === 'string' ? reasonOf : reasonOf();
        if (config) t3.config(config);
        const browser = fakeBrowser(dir);
        const runtime = start({ PATH: [browser.bin, pathOf?.() ?? [t3.bin, PATH_WITHOUT_T3].join(path.delimiter)].join(path.delimiter) });

        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init', 20_000)).toMatchObject({ ok: true });
        expect(browser.visits()).toEqual(['/oauth/mcp/authorize']);
        const said = `Approve teamai in T3 Code (silent sign-in failed: ${reason}). If no browser opened, visit: `;
        const [notice, ...more] = noticesOf(runtime);
        expect(more).toEqual([]);
        const message = z.string().parse(notice?.['message']);
        expect(message.slice(0, said.length)).toBe(said);
        expect(message.slice(said.length)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+$/);
        expect(runtime.stderr()).toBe('');

        for (const secret of secrets()) expect(message).not.toContain(secret);
      });
    });

    it('fails an unattended run with no sign-in and no t3 command, saying how to sign in, and asks T3 for none', async () => {
      const runtime = start({ PATH: PATH_WITHOUT_T3 });

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 'login_required', message: expect.stringContaining('Start any workflow with --driver t3 from a terminal on this machine once') },
      });
      expect(t3.calls()).toEqual([]);
    });

    // teamai opens a runtime in recover mode only to stop and close what it recorded, so a stop works whatever the sign-in.
    it('opens in recover mode with no sign-in, asking T3 nothing and offering nothing', async () => {
      const browser = fakeBrowser(dir);
      const runtime = start({ PATH: [t3.bin, browser.bin, PATH_WITHOUT_T3].join(path.delimiter) });

      runtime.send({ type: 'init', protocol: 1, mode: 'recover', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({ type: 'init', ok: true, can: {} });
      expect(browser.visits()).toEqual([]);
      expect(t3.calls()).toEqual([]);
      expect(t3.commandRuns()).toEqual([]);
    });

    // T3 issues no refresh token, so a credential about to expire is replaced by signing in again.
    it('signs in again with no page when its sign-in has expired, in an unattended run, and keeps the new credential', async () => {
      signIn(t3, 'fake-t3-token-expired-0000000000', 60);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(t3.commandRuns()).toHaveLength(1);
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
      const kept = fs.readFileSync(credentialsFile(t3.home), 'utf8');
      expect(kept).not.toContain('fake-t3-token-expired-0000000000');
      expect(kept).toContain('fake-t3-token-0123456789');
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
    });

    it('fails an unattended run whose sign-in has expired login_required, saying why it could not sign in again', async () => {
      signIn(t3, undefined, 60);
      const runtime = start({ PATH: PATH_WITHOUT_T3 });

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({
        ok: false, error: { code: 'login_required', message: expect.stringContaining('could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ') },
      });
    });

    // teamai gives init 15 s, so a T3 Code that does not answer fails init well before, saying so.
    it('fails init t3_unavailable within its bound when T3 Code does not answer what it runs', async () => {
      signIn(t3);
      t3.config({ environmentMs: 30_000 });
      const runtime = start();
      const sentAt = Date.now();

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init', 20_000)).toEqual({ type: 'init', ok: false, error: { code: 't3_unavailable', message: 'T3 Code did not answer what it runs within 10 s. Check that T3 Code is open and responding, then start the workflow again.' } });
      expect(Date.now() - sentAt).toBeLessThan(12_000);
    }, 30_000);

    it('fails when T3 Code is not running, saying to open it or run t3 serve', async () => {
      signIn(t3);
      await t3.stop();
      fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 't3_unavailable', message: 'T3 Code is not running on this machine. Open T3 Code, or run `t3 serve`, then start the workflow again.' } });
    });

    // A server file outlives a server that crashed or is stopping.
    it('fails t3_unavailable, naming t3 serve, when the server its file names does not answer', async () => {
      signIn(t3);
      const origin = t3.origin();
      await t3.stop();
      fs.writeFileSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, pid: 999_999, origin }));
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code at ${origin} does not answer. Open T3 Code, or run \`t3 serve\`, then start the workflow again.` },
      });
    });

    describe('with no t3 command on PATH', () => {
      /** T3's own command, where T3 installs it in its data directory. */
      const installed = (): string => {
        const command = path.join(t3.t3Home, 'bin', 't3');
        fs.mkdirSync(path.dirname(command), { recursive: true });
        fs.copyFileSync(path.join(t3.bin, 't3'), command);
        fs.chmodSync(command, 0o755);

        return command;
      };

      // T3 sets T3CODE_CLI_PATH and no T3CODE_HOME in its threads; a T3 home other than ~/.t3 is found through the command's path.
      it('signs in through the t3 command T3CODE_CLI_PATH names, in the T3 home that holds it', async () => {
        const runtime = start({ PATH: PATH_WITHOUT_T3, T3CODE_HOME: '', T3CODE_CLI_PATH: installed() });

        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(t3.commandRuns()).toEqual([expect.arrayContaining(['auth', 'pairing', 'create', '--base-dir', t3.t3Home])]);
      });

      it('signs in through the t3 command in the T3 home', async () => {
        installed();
        const runtime = start({ PATH: PATH_WITHOUT_T3 });

        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(t3.commandRuns()).toHaveLength(1);
      });
    });

    it('runs every prompt on the provider instance `instance` names, and fails naming the setup step for one T3 lacks', async () => {
      signIn(t3);
      t3.config({ providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }, { ...CLAUDE, providerInstanceId: 'claude-off', constraints: ['Provider instance is disabled.'] }] });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-work' } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude'] } });

      const missing = start();
      missing.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-sandbox' } });
      expect(await missing.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 'bad_option', key: 'instance', message: expect.stringMatching(/^T3 Code has no provider instance "claude-sandbox"\. Add it in T3 Code under Settings → Providers, .*Instances here: [^.]+$/) },
      });

      const disabled = start();
      disabled.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-off' } });
      expect(await disabled.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { key: 'instance', message: expect.stringMatching(/cannot run now: Provider instance is disabled\. Enable it in T3 Code under Settings → Providers$/) } });
    });

    // T3 Code 0.1.8 lists a signed-out Claude or Codex with these constraints, so neither is offered to run or to judge.
    it('offers no tool whose provider T3 reports as signed out', async () => {
      signIn(t3);
      t3.config({ providers: [{ ...CLAUDE, constraints: ['Claude Code is not authenticated. Run `claude auth login` and try again.', 'Provider is not authenticated.'] }, CODEX] });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['codex'], confined: [{ tools: ['codex'] }] } });
    });

    describe('the default tool', () => {
      const CODEX_DEFAULT = { instanceId: 'codex', model: 'gpt-6.1-sol' };

      it.each<{ set: string; settings: Line; providers?: FakeT3Config['providers']; options?: Line; tool: string | undefined }>([
        { set: 'the member\'s T3 default runs on an offered instance', settings: { defaultModelSelection: CODEX_DEFAULT }, tool: 'codex' },
        { set: 'the checkout\'s project sets its own default, over the global one', settings: { defaultModelSelection: CODEX_DEFAULT, projectSettingsOverrides: { 'project-1': { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } } } }, tool: 'claude' },
        { set: 'no default is set', settings: {}, tool: undefined },
        { set: 'the default\'s instance cannot run now', settings: { defaultModelSelection: CODEX_DEFAULT }, providers: [CLAUDE, { ...CODEX, constraints: ['Provider is not authenticated.'] }], tool: undefined },
        { set: '`instance` names another instance than the default\'s', settings: { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } }, providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work' }], options: { instance: 'claude-work' }, tool: undefined },
        { set: 'the default runs a provider this runtime does not run', settings: { defaultModelSelection: { instanceId: 'opencode', model: 'big-pickle' } }, tool: undefined },
        {
          set: 'the default instance runs another command than Claude\'s own, a wrapper teamai has no tool for',
          settings: { defaultModelSelection: { instanceId: 'acme-claude-t3', model: 'claude-opus-5-5' }, providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } },
          providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3' }], tool: 'claude',
        },
      ])('reports the tool of the member\'s effective T3 default when $set', async ({ settings, providers, options, tool }) => {
        signIn(t3);
        t3.settings(settings);

        if (providers) t3.config({ providers });
        // teamai starts the runtime in the run's checkout, and names it in init.
        const runtime = connect(executable, t3, {}, dir);
        connections.push(runtime);

        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', ...options }, checkout });
        const reply = await runtime.next((line) => line['type'] === 'init');

        expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
        expect(reply).toMatchObject({ ok: true });
        expect(z.object({ default_tool: z.string().optional() }).parse(reply['can']).default_tool).toBe(tool);
      });
    });

    describe('a team or personal tool instance', () => {
      const ACME = { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' };
      const INSTANCE = { name: 'acme-claude', tool: 'claude', command: 'acme-claude' };

      /** The init reply for `instances` given in init, `options` added to the definition's, and each provider instance's Binary path. */
      const initWith = async ({ binaryPaths, options = {}, providers = [CLAUDE, CODEX, ACME], instances = [INSTANCE] }: { binaryPaths: Record<string, string>; options?: Line; providers?: FakeT3Config['providers']; instances?: Line[] }): Promise<Line> => {
        signIn(t3);
        t3.config({ providers });
        t3.settings({ providerInstances: Object.fromEntries(Object.entries(binaryPaths).map(([id, binaryPath]) => [id, { config: { binaryPath } }])) });
        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', ...options }, instances });
        const reply = await runtime.next((line) => line['type'] === 'init');
        expect(RuntimeMessageSchema.safeParse(reply).success, JSON.stringify(reply)).toBe(true);

        return reply;
      };

      it('offers it on the T3 provider instance whose Binary path is its command', async () => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude' } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'], confined: [{ tools: ['claude', 'codex', 'acme-claude'] }] } });
        expect(reply).not.toHaveProperty('unavailable');
      });

      it.each([
        { case: 'a relative Binary path', binaryPath: 'acme-claude' },
        { case: 'a Binary path to another file', binaryPath: '/opt/acme/bin/acme-claude-old' },
      ])('does not offer it on an instance with $case, and names the instance to add', async ({ binaryPath }) => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': binaryPath } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
        expect(reply['unavailable']).toEqual({
          'acme-claude': 'No T3 Code provider instance runs acme-claude. Add one in T3 Code under Settings → Providers, with driver Claude and Binary path the absolute path of acme-claude (command -v acme-claude), or map one with instances: { acme-claude: <its id> } in the definition\'s t3 options.',
        });
      });

      // teamai passes every instance the member may run, so one that is ambiguous must not stop the steps on the others.
      it('does not offer it, naming both and the option that picks one, when two instances run its command, and still offers the rest', async () => {
        const reply = await initWith({
          binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude', 'acme-claude-2': '/usr/local/bin/acme-claude' },
          providers: [CLAUDE, ACME, { ...ACME, providerInstanceId: 'acme-claude-2' }],
        });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude'] } });
        expect(reply['unavailable']).toEqual({
          'acme-claude': 'T3 Code provider instances "acme-claude-t3" and "acme-claude-2" both run acme-claude. Pick one with instances: { acme-claude: <its id> } in the definition\'s t3 options.',
        });
      });

      it('keeps its other tools, naming the key under unavailable, when `instances` maps a name that is neither a tool T3 runs nor an instance teamai passed', async () => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude' }, options: { instances: { 'acme-cluade': 'acme-claude-t3' } } });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] },
          unavailable: { 'acme-cluade': 'instances names acme-cluade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.acme-cluade, or name the instance as its tool definition does.' },
        });
      });

      // A step that never names the misspelt key would not show its reason, so the member hears of it at the start.
      it('says once, before it answers init, that `instances` names a key that is neither a tool T3 runs nor an instance teamai passed', async () => {
        signIn(t3);
        t3.config({ providers: [CLAUDE, CODEX, ACME] });
        t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } });
        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local', instances: { 'acme-cluade': 'acme-claude-t3', clade: 'claudeAgent' } }, instances: [INSTANCE] });
        await runtime.next((line) => line['type'] === 'init');

        expect(runtime.lines.slice(0, -1)).toEqual([
          { event: 'notice', message: 'instances names acme-cluade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.acme-cluade, or name the instance as its tool definition does.' },
          { event: 'notice', message: 'instances names clade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.clade, or name the instance as its tool definition does.' },
        ]);
      });

      // T3 runs the instance in its own home, so the instance signs in there and keeps its sessions there, not in teamai's.
      it.each([
        { case: 'has no home of its own, so runs in Claude\'s', homePath: undefined, notice: 'T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.claude, while teamai gives acme-claude the home ~/.acme-claude: on T3 it signs in and keeps its sessions there. To use the same home, set the instance\'s Home path in T3 Code under Settings → Providers to ~/.acme-claude.' },
        { case: 'has another home', homePath: '~/.acme-old', notice: 'T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.acme-old, while teamai gives acme-claude the home ~/.acme-claude: on T3 it signs in and keeps its sessions there. To use the same home, set the instance\'s Home path in T3 Code under Settings → Providers to ~/.acme-claude.' },
        { case: 'has the same home', homePath: '~/.acme-claude', notice: undefined },
      ])('says once when the instance that runs it $case than teamai gives it', async ({ homePath, notice }) => {
        signIn(t3);
        t3.config({ providers: [CLAUDE, CODEX, ACME] });
        t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude', ...(homePath && { homePath }) } } } });
        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' }, instances: [{ ...INSTANCE, home: { dir: '.acme-claude', env: 'CLAUDE_CONFIG_DIR' } }] });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
        expect(noticesOf(runtime)).toEqual(notice === undefined ? [] : [{ event: 'notice', message: notice }]);
      });

      it('runs it on the instance `instances` maps it to', async () => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude', 'acme-claude-2': '/usr/local/bin/acme-claude' }, providers: [CLAUDE, ACME, { ...ACME, providerInstanceId: 'acme-claude-2' }], options: { instances: { 'acme-claude': 'acme-claude-2' } } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'acme-claude'] } });
      });

      it.each([
        { case: 'that T3 lacks', mapped: 'acme-sandbox', message: 'T3 Code has no provider instance "acme-sandbox", which instances maps acme-claude to. Add or enable it in T3 Code under Settings → Providers, or remove instances.acme-claude' },
        { case: 'of another driver', mapped: 'codex', message: 'T3 Code provider instance "codex" runs codex, and acme-claude extends claude. Map acme-claude to a Claude instance in instances.acme-claude' },
        { case: 'whose Binary path runs another file', mapped: 'acme-claude-t3', message: 'T3 Code provider instance "acme-claude-t3" has the Binary path /opt/acme/bin/claude, which is not acme-claude, the command acme-claude runs. Set its Binary path in T3 Code under Settings → Providers to the absolute path of acme-claude (command -v acme-claude), or change instances.acme-claude' },
      ])('offers the other tools and names the setting under unavailable, for a mapping to an instance $case', async ({ mapped, message }) => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/claude' }, options: { instances: { 'acme-claude': mapped } } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] }, unavailable: { 'acme-claude': message } });
      });

      it('keeps offering claude on its default instance when the team adjusts claude with no command of its own', async () => {
        const reply = await initWith({ binaryPaths: {}, instances: [{ name: 'claude', tool: 'claude', home: { dir: '/home/member/.claude-team', env: 'CLAUDE_CONFIG_DIR' } }] });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
        expect(reply).not.toHaveProperty('unavailable');
      });

      it('offers no claude, naming the setting under unavailable, when `instances` maps claude to an instance T3 lacks, and keeps codex', async () => {
        const reply = await initWith({ binaryPaths: {}, options: { instances: { claude: 'claude-work' } } });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['codex'] },
          unavailable: { claude: 'T3 Code has no provider instance "claude-work", which instances maps claude to. Add or enable it in T3 Code under Settings → Providers, or remove instances.claude' },
        });
      });
    });

    describe('with `runtime_mode: full-access`', () => {
      const FULL_ACCESS_SCOPES = ['--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'settings:write', '--scope', 'source-control:write'];

      it('signs in with Full access through a pairing code carrying the scopes T3 needs for it, and reports every tool it offers as running in full access', async () => {
        const runtime = start();

        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local', runtime_mode: 'full-access' } });
        const reply = await runtime.next((line) => line['type'] === 'init');

        expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'], unattended: false }, permissions: { claude: 'full-access', codex: 'full-access' } });
        expect(t3.commandRuns()).toEqual([['auth', 'pairing', 'create', '--json', '--base-dir', t3.t3Home, ...FULL_ACCESS_SCOPES, '--ttl', '2m', '--label', 'teamai workflow']]);
        expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'full-access' });
      });

      it('signs in again with Full access when the kept sign-in was approved with Auto, and a later Auto run keeps the new one', async () => {
        signIn(t3, undefined, undefined, 'orchestration:read orchestration:operate');
        const runtime = start();

        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local', runtime_mode: 'full-access' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, permissions: { claude: 'full-access' } });
        expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'full-access' });
        await runtime.close();

        const later = start();
        later.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

        expect(await later.next((line) => line['type'] === 'init')).not.toHaveProperty('permissions');
        expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
      });

      it('asks the person to approve Full access when it signs in through T3\'s page', async () => {
        t3.config({ pageAccess: 'full-access' });
        const browser = fakeBrowser(dir);
        const runtime = start({ PATH: `${browser.bin}${path.delimiter}${PATH_WITHOUT_T3}` });

        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', runtime_mode: 'full-access' } });

        const reply = await runtime.next((line) => line['type'] === 'init');
        expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, permissions: { claude: 'full-access' } });
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', message: expect.stringMatching(/^Approve teamai in T3 Code with Full access, since runtime_mode is full-access \(silent sign-in failed: found no t3 command .*\)\. If no browser opened, visit: http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+$/) }]);
      });

      it('fails sign_in_too_narrow, naming the fix, when the person approves only Auto access in T3\'s page', async () => {
        const browser = fakeBrowser(dir);
        const runtime = start({ PATH: `${browser.bin}${path.delimiter}${PATH_WITHOUT_T3}` });

        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', runtime_mode: 'full-access' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
          type: 'init', ok: false,
          error: {
            code: 'sign_in_too_narrow',
            message: 'teamai\'s T3 Code sign-in was approved without Full access, which runtime_mode full-access needs. Start the workflow again and pick Full access in the page T3 Code opens, or remove runtime_mode: full-access.',
          },
        });
      });
    });

    // teamai quotes a keyed option failure inside a sentence of its own and ends it, so these messages bring no full stop.
    it.each(['yolo'])('refuses `runtime_mode: %s`, a mode it never starts a thread in', async (runtimeMode) => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', runtime_mode: runtimeMode } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: {
          code: 'bad_option', key: 'runtime_mode',
          message: `runtime_mode "${runtimeMode}" is not one runtime t3 takes. A step thread runs in the member's T3 default mode, or auto, never full access unless runtime_mode says so; runtime_mode sets it to auto, auto-accept-edits, approval-required or full-access. Remove it, or set one of those four`,
        },
      });
      expect(t3.calls()).toEqual([]);
    });

    it('names an option it does not take', async () => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instnace: 'x' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'instnace' } });
    });
  });

  describe('a prompt step', () => {
    let worktree: string;
    let result: string;
    const OPEN = 'op-0000000a';
    const RUN = 'r7f3a91c2';

    /** A runtime past init and open on the attempt's worktree, and its handle. */
    const opened = async (mode: 'attended' | 'unattended' = 'attended', env: Record<string, string> = {}, options: Line = {}): Promise<{ runtime: Connection; handle: string }> => {
      const runtime = start(env);
      runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local', ...options } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      const accepted = await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');
      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted' && !isNotice(line))).toMatchObject({ event: 'ready' });

      return { runtime, handle: z.string().parse(accepted['handle']) };
    };

    const prompt = (handle: string, op: string, lease: Record<string, unknown> = {}) => ({
      type: 'prompt', op, handle, env: { TEAMAI_WORKFLOW_RESULT: result }, unset: [], cwd: worktree,
      lease: {
        step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false, result,
        prompt: `Review the change on this branch.\n\nWrite the workflow result as JSON to ${result}. Use this shape: {"output":{}}.`,
        ...lease,
      },
    });

    /** How the op ended: its first line that neither accepts it nor shows its thread. */
    const ended = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && line['event'] !== 'display' && !isNotice(line), 20_000);

    beforeEach(() => {
      signIn(t3);
      worktree = path.join(checkout, '.teamai', 'workflow-worktrees', `${RUN}-a1b2c3d4`);
      execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', worktree]);
      result = path.join(dir, 'attempt', 'out', 'result.json');
      fs.mkdirSync(path.dirname(result), { recursive: true });
    });

    /** Opens the place of an attempt whose folder is `folder` on `runtime`, and answers how the open ended. */
    const openOn = async (runtime: Connection, folder: string, op = OPEN, timeoutMs?: number): Promise<Line> => {
      runtime.send({ type: 'open', op, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree: folder, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      await runtime.next((line) => line['op'] === op && line['event'] === 'accepted');

      return runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && !isNotice(line), timeoutMs);
    };

    const initialized = async (options: Line = {}, env: Record<string, string> = {}): Promise<Connection> => {
      const runtime = start(env);
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', ...options } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });

      return runtime;
    };

    /** The project script settings that make T3 run `script` in the folder of every thread in project-1. */
    const scriptsInProject1 = (script: { name: string; command: string; runOnWorktreeCreate: boolean; runOnSettle?: boolean }) => ({
      projectSettingsFolded: true, projectSettingsOverrides: { 'project-1': { defaultProjectScripts: [{ id: 'one', icon: 'configure', ...script }] } },
    });

    describe('in a checkout that is no T3 project yet', () => {
      it('adds it to T3 Code with the t3 command, as the member, saying so, and runs the step there', async () => {
        t3.config({ projects: [] });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, checkout]);
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', op: OPEN, handle: `t3-${RUN}-a1b2c3d4`, message: `Adding ${checkout} to T3 Code as a project, so its steps can run there.` }]);
        expect(runtime.stderr()).toBe('');

        const handle = `t3-${RUN}-a1b2c3d4`;
        runtime.send(prompt(handle, 'op-0000000b'));
        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.threads()[0]).toMatchObject({ projectId: expect.stringMatching(/^project-/), workspace: 'existing_worktree', worktreePath: worktree });
      });

      it('fails open when the t3 command cannot add it, naming the command that does', async () => {
        t3.config({ projects: [], projectAddFails: 4 });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toEqual({
          op: OPEN, event: 'failed',
          failure: { code: 'not_a_t3_project', message: `${checkout} is not a project in T3 Code fake-laptop, and teamai could not add it (t3 project add exited with status 4: Could not add the project). Add it in T3 Code (Add project), or run t3 project add ${checkout}, then start the workflow again.` },
        });
      });

      it('runs the step on the project another step\'s open added meanwhile, when its own add finds it there', async () => {
        t3.config({ projects: [], projectAddRaced: true });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.threads()[0]).toMatchObject({ projectId: expect.stringMatching(/^project-/), workspace: 'existing_worktree', worktreePath: worktree });
      });

      it('fails open within its bound when the t3 command never finishes adding it', async () => {
        t3.config({ projects: [], projectAddHangs: true });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree, OPEN, 15_000)).toEqual({
          op: OPEN, event: 'failed',
          failure: { code: 'not_a_t3_project', message: `${checkout} is not a project in T3 Code fake-laptop, and teamai could not add it (t3 project add did not finish within 10 s). Add it in T3 Code (Add project), or run t3 project add ${checkout}, then start the workflow again.` },
        });
      }, 20_000);

      it('adds it again when T3 deleted the project it had', async () => {
        t3.config({ projects: [{ id: 'project-old', title: 'acme-app', workspaceRoot: checkout, deletedAt: '2026-10-01T09:00:00.000Z' }] });
        const runtime = await initialized();

        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, checkout]);
      });
    });

    // T3 runs a project's setup script in every worktree a thread binds, before the agent starts, so its output would be
    // committed as the step's work. A thread on a project's own folder runs no setup script.
    it('runs the step on a project of its own for the worktree when T3 would run the project\'s setup script in it, and nothing of that script lands there', async () => {
      t3.settings(scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true }));
      const runtime = await initialized();

      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, '--title', `acme-app · teamai ${RUN}`, worktree]);
      expect(t3.threads()[0]).toMatchObject({ workspace: 'root', worktreePath: worktree, projectId: expect.not.stringMatching(/^project-1$/) });
      expect(fs.existsSync(path.join(worktree, 'SETUP_RAN.txt'))).toBe(false);
      expect(noticesOf(runtime)).toEqual([{
        event: 'notice', op: OPEN, handle: `t3-${RUN}-a1b2c3d4`,
        message: `T3 Code runs the setup script "Install" of acme-app in each worktree a thread opens on, so teamai adds the step's worktree ${worktree} to T3 Code as a project of its own, where that script does not run.`,
      }]);
      expect(runtime.stderr()).toBe('');
    });

    // The project teamai added for the worktree points at a folder that no longer exists once teamai removed it.
    it('removes the project it added for the step\'s worktree once teamai removed the worktree, and keeps the checkout\'s project', async () => {
      t3.settings(scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true }));
      const handle = `t3-${RUN}-a1b2c3d4`;
      const runtime = await initialized();
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(handle, 'op-0000000b'));
      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
      const added = t3.threads()[0]?.projectId;
      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      execFileSync('git', ['-C', checkout, 'worktree', 'remove', '--force', worktree]);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.commandRuns()).toContainEqual(['project', 'remove', '--base-dir', t3.t3Home, '--force', added]);
      expect(t3.projects().filter((project) => !project.deletedAt).map((project) => project.id)).toEqual(['project-1']);
      expect(t3.threads()).toEqual([]);
    });

    it('keeps the project it added for a folder teamai still has at close, and removes it at a later close once the folder is gone', async () => {
      const clone = path.join(dir, 'clones', `${RUN}-a1b2c3d4`);
      execFileSync('git', ['clone', '-q', checkout, clone]);
      const runtime = await initialized();
      expect(await openOn(runtime, clone)).toMatchObject({ event: 'ready' });
      const added = t3.projects().find((project) => project.workspaceRoot === clone)?.id;
      runtime.send({ type: 'close', handle: `t3-${RUN}-a1b2c3d4` });
      await runtime.next((line) => line['event'] === 'closed');
      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([]);

      fs.rmSync(clone, { recursive: true, force: true });
      runtime.send({ type: 'open', op: 'op-0000000c', run: RUN, attempt: 'a5e6f7a8', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      await runtime.next((line) => line['op'] === 'op-0000000c' && line['event'] === 'ready');
      runtime.send({ type: 'close', handle: `t3-${RUN}-a5e6f7a8` });
      await runtime.next((line) => line['event'] === 'closed' && line['handle'] === `t3-${RUN}-a5e6f7a8`);

      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([['project', 'remove', '--base-dir', t3.t3Home, '--force', added]]);
      expect(t3.projects().filter((project) => !project.deletedAt).map((project) => project.id)).toEqual(['project-1']);
    });

    it('keeps the project it added for a folder it cannot look at, which may still be in use', async () => {
      const clones = path.join(dir, 'clones');
      const clone = path.join(clones, `${RUN}-a1b2c3d4`);
      execFileSync('git', ['clone', '-q', checkout, clone]);
      const runtime = await initialized();
      expect(await openOn(runtime, clone)).toMatchObject({ event: 'ready' });
      runtime.send({ type: 'close', handle: `t3-${RUN}-a1b2c3d4` });
      await runtime.next((line) => line['event'] === 'closed');

      fs.chmodSync(clones, 0o000);

      try {
        runtime.send({ type: 'open', op: 'op-0000000c', run: RUN, attempt: 'a5e6f7a8', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
        await runtime.next((line) => line['op'] === 'op-0000000c' && line['event'] === 'ready');
        runtime.send({ type: 'close', handle: `t3-${RUN}-a5e6f7a8` });
        await runtime.next((line) => line['event'] === 'closed' && line['handle'] === `t3-${RUN}-a5e6f7a8`);
      } finally {
        fs.chmodSync(clones, 0o755);
      }

      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([]);
      expect(t3.projects().filter((project) => !project.deletedAt).map((project) => project.workspaceRoot)).toContain(clone);
    });

    it('never removes the checkout\'s project, though teamai added it', async () => {
      t3.config({ projects: [] });
      const handle = `t3-${RUN}-a1b2c3d4`;
      const runtime = await initialized();
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      execFileSync('git', ['-C', checkout, 'worktree', 'remove', '--force', worktree]);

      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      expect(t3.commandRuns().filter((run) => run[1] === 'remove')).toEqual([]);
      expect(t3.projects()).toEqual([expect.objectContaining({ workspaceRoot: checkout, deletedAt: null })]);
    });

    it('runs the thread on the worktree\'s own project in the mode the member set for the checkout\'s project', async () => {
      const settings = scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true });
      t3.settings({ ...settings, defaultRuntimeMode: 'auto', projectSettingsOverrides: { 'project-1': { ...settings.projectSettingsOverrides['project-1'], defaultRuntimeMode: 'approval-required' } } });
      const runtime = await initialized();

      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'));

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]).toMatchObject({ runtimeMode: 'approval-required', projectId: expect.not.stringMatching(/^project-1$/) });
    });

    it('runs the thread on the worktree\'s own project on the default model the member set for the checkout\'s project', async () => {
      const settings = scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true });
      t3.settings({
        ...settings, defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
        projectSettingsOverrides: { 'project-1': { ...settings.projectSettingsOverrides['project-1'], defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } } },
      });
      const runtime = await initialized();

      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b', { model: undefined }));

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]).toMatchObject({ provider: 'claudeAgent', model: 'claude-sonnet-5-5', projectId: expect.not.stringMatching(/^project-1$/) });
    });

    it('leaves a thread unsettled, saying why once, when settling it would run the project\'s settle script in the step\'s worktree', async () => {
      t3.settings(scriptsInProject1({ name: 'Stop services', command: 'echo stopped > SETTLE_RAN.txt', runOnWorktreeCreate: false, runOnSettle: true }));
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000000b'));
      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      const [thread] = t3.threads();
      expect(thread?.settled).toBe(false);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize')).toEqual([]);
      expect(fs.existsSync(path.join(worktree, 'SETTLE_RAN.txt'))).toBe(false);
      expect(noticesOf(runtime)).toEqual([{
        event: 'notice', handle,
        message: `teamai leaves the T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") in T3 Code's active threads: settling it would run the project's script "Stop services" in the step's folder.`,
      }]);
      expect(runtime.stderr()).toBe('');
    });

    // A read-only step reads the checkout where it is, as on local, and a clone is a folder of its own: each is a
    // project's own folder, where T3 runs no setup script.
    it('runs a step in the checkout itself as a thread of the checkout\'s project, where T3 runs no setup script', async () => {
      t3.settings(scriptsInProject1({ name: 'Install', command: 'echo installed > SETUP_RAN.txt', runOnWorktreeCreate: true }));
      const runtime = await initialized();

      expect(await openOn(runtime, checkout)).toMatchObject({ event: 'ready' });
      runtime.send({ ...prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'), cwd: checkout });

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.threads()[0]).toMatchObject({ projectId: 'project-1', workspace: 'root', worktreePath: checkout });
      expect(t3.commandRuns()).toEqual([]);
      expect(fs.existsSync(path.join(checkout, 'SETUP_RAN.txt'))).toBe(false);
    });

    it('runs a step in a clone teamai prepared on a project it adds for the clone', async () => {
      const clone = path.join(dir, 'clones', `${RUN}-a1b2c3d4`);
      execFileSync('git', ['clone', '-q', checkout, clone]);
      const runtime = await initialized();

      expect(await openOn(runtime, clone)).toMatchObject({ event: 'ready' });
      runtime.send({ ...prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b'), cwd: clone });

      expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.commandRuns()).toContainEqual(['project', 'add', '--base-dir', t3.t3Home, clone]);
      expect(t3.threads()[0]).toMatchObject({ projectId: expect.not.stringMatching(/^project-1$/), workspace: 'root', worktreePath: clone });
    });

    describe('with no mode or model set for the step', () => {
      it.each<{ set: string; settings: Line; options: Line; mode: string }>([
        { set: 'the member\'s T3 default mode', settings: { defaultRuntimeMode: 'approval-required' }, options: {}, mode: 'approval-required' },
        { set: 'the project\'s default mode, over the global one', settings: { defaultRuntimeMode: 'approval-required', projectSettingsOverrides: { 'project-1': { defaultRuntimeMode: 'auto-accept-edits' } } }, options: {}, mode: 'auto-accept-edits' },
        { set: 'runtime_mode, over the member\'s default', settings: { defaultRuntimeMode: 'approval-required' }, options: { runtime_mode: 'auto' }, mode: 'auto' },
        { set: 'no default at all', settings: {}, options: {}, mode: 'auto' },
      ])('starts the thread in $set', async ({ settings, options, mode }) => {
        t3.settings(settings);
        const { runtime, handle } = await opened('attended', {}, options);
        runtime.send(prompt(handle, 'op-0000000b'));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['runtimeMode']).toBe(mode);
        expect(runtime.stderr()).toBe('');
        expect(noticesOf(runtime)).toEqual([]);
      });

      it('starts threads in Auto, never in full access, when that is the member\'s T3 default, and says so once', async () => {
        t3.settings({ defaultRuntimeMode: 'full-access' });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000000b'));
        runtime.send(prompt(handle, 'op-0000000c', { step: 'second' }));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(await ended(runtime, 'op-0000000c')).toMatchObject({ event: 'finished' });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['runtimeMode'])).toEqual(['auto', 'auto']);
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', op: 'op-0000000b', handle, message: 'T3\'s default mode is Full access; teamai starts its threads in Auto unless runtime_mode says full-access.' }]);
        expect(runtime.stderr()).toBe('');
      });

      // T3 applies the member's default, its options, and their fallback once its usage is spent, only to a launch that names no model.
      it('names no model when the step\'s tool runs on the instance of the member\'s default, so T3 applies that default, and shows the model T3 chose', async () => {
        t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000000b', { model: undefined }));

        expect(await runtime.next((line) => line['op'] === 'op-0000000b' && line['event'] === 'display')).toMatchObject({ display: { fields: { model: 'claude-sonnet-5-5' } } });
        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('modelSelection');
        expect(t3.threads()[0]).toMatchObject({ provider: 'claudeAgent', model: 'claude-sonnet-5-5' });
      });

      it('runs a tool on the instance of the project\'s default model, over the global default', async () => {
        t3.config({ providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }, CODEX] });
        t3.settings({ defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, projectSettingsOverrides: { 'project-1': { defaultModelSelection: { instanceId: 'claude-work', model: 'claude-opus-5-5' } } } });
        const runtime = connect(executable, t3, {}, checkout);
        connections.push(runtime);
        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });
        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000000b', { model: { name: 'claude-sonnet-5-5' } }));

        expect(await ended(runtime, 'op-0000000b')).toMatchObject({ event: 'finished' });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claude-work', model: 'claude-sonnet-5-5' });
      });

      it('offers no tool whose instance the member turned off for the checkout\'s project, though it is on globally', async () => {
        t3.settings({ projectSettingsOverrides: { 'project-1': { providerInstances: { codex: { enabled: false } } } } });
        const runtime = connect(executable, t3, {}, checkout);
        connections.push(runtime);

        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude'] } });
      });
    });

    it('runs as a T3 thread of its own on the attempt\'s worktree, then ends finished with the result and the session', async () => {
      const { runtime, handle } = await opened('attended', { T3CODE_THREAD_ID: 'thread-parent-1' });
      const op = 'op-0000000b';

      runtime.send(prompt(handle, op));

      // The prompt is accepted before the launch, and its thread is shown once T3 launched it, so the run details link it during the run.
      expect(await runtime.next((line) => line['op'] === op)).toEqual({ op, event: 'accepted' });
      const shown = await runtime.next((line) => line['op'] === op);
      expect(RuntimeMessageSchema.safeParse(shown).success).toBe(true);
      expect(shown).toEqual({
        op, event: 'display',
        display: { label: `review · teamai ${RUN}`, url: expect.stringMatching(/^t3code:\/\/threads\/env-fake-1\/mcp%3Alaunch%3A[0-9a-f]{64}$/), fields: { thread: expect.stringMatching(/^mcp:launch:/), model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({ op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: { verdict: 'approve' } } });

      const [thread] = t3.threads();
      expect(thread).toMatchObject({
        title: `review · teamai ${RUN}`, worktreePath: worktree, projectId: 'project-1', provider: 'claudeAgent', model: 'claude-opus-5-5',
        runtimeMode: 'auto', status: 'completed',
      });
      // In T3's own chat form, which T3 shows as a link to that thread.
      expect(thread?.message).toMatch(new RegExp(`^This thread runs step "review" of teamai workflow run ${RUN} \\(attempt a1b2c3d4\\)\\. It was started from the T3 thread <t3-thread://v2/env-fake-1/thread-parent-1>\\.`));
      expect(thread?.message).toContain(`Write the workflow result as JSON to ${result}.`);
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).toMatchObject({ clientRequestId: op, workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('delegatedFrom');
    });

    // teamai ends a prompt lost that is not accepted within 15 s, and T3 may take a while to launch a thread.
    it('accepts a prompt before T3 answers its launch, and shows the thread once it did', async () => {
      t3.config({ launchMs: 3_000 });
      const { runtime, handle } = await opened();
      const sentAt = Date.now();

      runtime.send(prompt(handle, 'op-00000064'));

      expect(await runtime.next((line) => line['op'] === 'op-00000064')).toEqual({ op: 'op-00000064', event: 'accepted' });
      expect(Date.now() - sentAt).toBeLessThan(2_000);
      expect(await runtime.next((line) => line['op'] === 'op-00000064', 10_000)).toMatchObject({ event: 'display', display: { url: linkTo(t3.threads()[0]?.threadId) } });
      expect(await ended(runtime, 'op-00000064')).toMatchObject({ event: 'finished' });
    });

    // A failure after the acceptance ends the op once, with no second acceptance. Only a check's refusal proves T3
    // launched nothing, so this one leaves a thread that may run, and the op ends as a stop teamai could not confirm.
    it('accepts once a prompt whose launch T3 refuses after accepting it', async () => {
      t3.config({ launchFails: true });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000065'));

      expect(await ended(runtime, 'op-00000065')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('T3 Code cannot launch threads now') } });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000065').map((line) => line['event'])).toEqual(['accepted', 'failed']);
    });

    // Only a check a new launch runs proves T3 launched nothing: the op keeps its own failure, and close, finding the same
    // refusal when it repeats the launch, forgets it.
    it('fails t3_launch_failed when a new launch\'s check refuses the thread, and closes once the repeated launch is refused the same way', async () => {
      t3.config({ launchInvalid: true });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000078'));

      expect(await ended(runtime, 'op-00000078')).toEqual({ op: 'op-00000078', event: 'failed', failure: { code: 't3_launch_failed', message: expect.stringContaining('is not a worktree of project project-1') } });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['clientRequestId'])).toEqual(['op-00000078', 'op-00000078']);
    });

    it.each(['auto-accept-edits', 'approval-required'])('runs every thread in %s when `runtime_mode` tightens it', async (runtimeMode) => {
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: runtimeMode });

      runtime.send(prompt(handle, 'op-0000001a'));

      expect(await ended(runtime, 'op-0000001a')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe(runtimeMode);
    });

    it('runs every thread in full access when `runtime_mode` is full-access', async () => {
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: 'full-access' });

      runtime.send(prompt(handle, 'op-0000001c'));

      expect(await ended(runtime, 'op-0000001c')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('full-access');
      expect(noticesOf(runtime)).toEqual([]);
    });

    it('fails sign_in_too_narrow, asking for Full access, when T3 refuses a full-access thread on the kept sign-in', async () => {
      t3.config({ access: 'auto' });
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: 'full-access' });

      runtime.send(prompt(handle, 'op-0000001d'));

      expect(await ended(runtime, 'op-0000001d')).toEqual({
        op: 'op-0000001d', event: 'failed', failure: {
          code: 'sign_in_too_narrow',
          message: 'T3 Code refused to start the step\'s thread in full-access mode, because teamai\'s sign-in does not allow it (Child runtime mode full-access is broader than parent mode auto.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Full access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.',
        },
      });
    });

    it('runs an Auto thread on the sign-in a run at a tighter runtime_mode left', async () => {
      fs.rmSync(credentialsFile(t3.home));
      const tighter = start();
      tighter.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local', runtime_mode: 'approval-required' } });
      expect(await tighter.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      await tighter.close();

      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-000000c7'));

      const end = await ended(runtime, 'op-000000c7');
      expect(end, JSON.stringify(end)).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('auto');
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    it('fails sign_in_too_narrow, naming the fix, when the sign-in does not allow the mode the thread runs in', async () => {
      t3.config({ access: 'approval-required' });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000001b'));

      expect(await ended(runtime, 'op-0000001b')).toEqual({
        op: 'op-0000001b', event: 'failed', failure: {
          code: 'sign_in_too_narrow',
          message: 'T3 Code refused to start the step\'s thread in auto mode, because teamai\'s sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.',
        },
      });
      expect(t3.threads()).toEqual([]);

      // T3 refuses the repeated launch close looks the thread up with as well: there was none, and none is left.
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(t3.threads()).toEqual([]);
    });

    // Once a step ended and T3 holds no run of its thread, teamai settles it: it leaves the active list and still opens from its link.
    it.each([
      { ended: 'finished', agent: { output: { verdict: 'approve' } }, event: 'finished' },
      { ended: 'finished, reporting the step failed', agent: { failure: { code: 'tests_failed', message: 'npm test fails in src/cart.test.ts.' } }, event: 'finished' },
      { ended: 'failed', agent: { fail: true }, event: 'failed' },
      { ended: 'cancelled', agent: { hold: true, output: {} }, event: 'cancelled' },
    ])('settles the thread of a step that ended $ended once teamai collects it', async ({ agent, event }) => {
      t3.config({ agent });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000030'));
      await runtime.next((line) => line['op'] === 'op-00000030' && line['event'] === 'accepted');

      if (event === 'cancelled') {
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        runtime.send({ type: 'cancel', op: 'op-00000030' });
      }

      expect(await ended(runtime, 'op-00000030')).toMatchObject({ event });
      expect(t3.threads()[0]?.settled).toBe(false);

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]?.settled).toBe(true);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize').map((call) => call.args)).toEqual([{ threadId: t3.threads()[0]?.threadId, action: 'settle' }]);
    });

    // After a restart, cancel ends the op once T3 acknowledged the stop, which may come before the run ended.
    it('settles the thread of a step cancelled after a restart, once its run ends after T3 acknowledged the stop', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000036'));
      await first.runtime.next((line) => line['op'] === 'op-00000036' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      t3.config({ stopLagMs: 1_000 });

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000036' });
      expect(await second.next((line) => line['op'] === 'op-00000036')).toEqual({ op: 'op-00000036', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      second.send({ type: 'collect', handle: first.handle });

      expect(await second.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('never settles a thread that still runs, or an interactive step\'s thread that waits for the person', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000031', { interactive: true }));
      await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
      t3.config({ agent: { hold: true, output: {} } });
      runtime.send(prompt(handle, 'op-00000032'));
      await expect.poll(() => t3.threads().map((thread) => thread.status).sort()).toEqual(['completed', 'running']);

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads().map((thread) => thread.settled)).toEqual([false, false]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize')).toEqual([]);
    });

    // The step fails at once, but its thread is still teamai's to stop: close keeps the place until T3 stops it.
    it.each([
      { stop: 'refuses', config: { interruptFails: true } },
      { stop: 'acknowledges but the run does not end', config: { stopLagMs: 60_000, waitCapMs: 50 } },
    ])('never settles or drops the thread of a step that ended while T3 still runs it, when T3 $stop the stop', async ({ config }) => {
      t3.config({ agent: { waits: true }, ...config });
      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-00000035'));
      // The thread may still run, so the op ends with the one code teamai reads as a stop it could not confirm.
      expect(await ended(runtime, 'op-00000035')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('Stop it in T3 Code with its Stop button.') } });

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'collected')).toMatchObject({ event: 'close_failed', handle, failure: { code: 'thread_still_runs' } });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000035', state: 'failed', failure: { code: 'cancel_failed' } }] });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

      // T3 stops it now: close stops it, settles it and drops the place.
      t3.config({ interruptFails: false, stopLagMs: 0 });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('settles only the threads it launched', async () => {
      t3.addThread({ threadId: 'thread-person-1', title: 'Fix the cart total', status: 'completed' });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000033'));
      expect(await ended(runtime, 'op-00000033')).toMatchObject({ event: 'finished' });
      const launched = t3.threads().find((thread) => thread.threadId !== 'thread-person-1');

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize').map((call) => call.args['threadId'])).toEqual([launched?.threadId]);
      expect(t3.threads().find((thread) => thread.threadId === 'thread-person-1')?.settled).toBe(false);
    });

    // T3 leaves a delegated task's thread unsettled when it settles the thread that delegated it.
    it('settles the tasks a step thread delegated, at any depth, with the step thread, and no task of another thread', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, delegates: true } });
      t3.addThread({ threadId: 'thread-person-1', title: 'Fix the cart total', status: 'completed' });
      t3.addThread({ threadId: 'thread-person-1:task', title: 'Check the totals', status: 'completed', parentThreadId: 'thread-person-1' });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000037'));
      expect(await ended(runtime, 'op-00000037')).toMatchObject({ event: 'finished' });
      const step = t3.threads().find((thread) => thread.title === `review · teamai ${RUN}`)?.threadId;

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');

      expect(Object.fromEntries(t3.threads().map((thread) => [thread.threadId, thread.settled]))).toEqual({
        [`${step}`]: true, [`${step}:task`]: true, [`${step}:task:task`]: true, 'thread-person-1': false, 'thread-person-1:task': false,
      });
      expect(noticesOf(runtime)).toEqual([]);
    });

    // T3 lists threads by their last change, newest first; a task the step delegated changed after the step was launched.
    it('lists only the threads changed since the step was launched to settle its tasks, however many the person left unsettled', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, delegates: true } });
      const lastWeek = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();

      for (let index = 0; index < 250; index += 1) t3.addThread({ threadId: `thread-person-${index}`, title: `Older work ${index}`, status: 'completed', updatedAt: lastWeek });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000038'));
      expect(await ended(runtime, 'op-00000038')).toMatchObject({ event: 'finished' });
      const step = t3.threads().find((thread) => thread.title === `review · teamai ${RUN}`)?.threadId;

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');

      const settled = Object.fromEntries(t3.threads().filter((thread) => thread.threadId.startsWith(`${step}`)).map((thread) => [thread.threadId, thread.settled]));
      expect(settled).toEqual({ [`${step}`]: true, [`${step}:task`]: true, [`${step}:task:task`]: true });
      expect(t3.threads().filter((thread) => thread.threadId.startsWith('thread-person-') && thread.settled)).toEqual([]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_list' && call.args['settled'] === false)).toHaveLength(1);
    });

    it('says once that a thread could not be settled, and the step still counts', async () => {
      t3.config({ organizeFails: true });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000034'));
      expect(await ended(runtime, 'op-00000034')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      const threadId = t3.threads()[0]?.threadId;

      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });

      expect(noticesOf(runtime)).toEqual([{
        event: 'notice', handle,
        message: `teamai could not settle the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}"), so it stays in T3 Code's active threads: Thread ${threadId} cannot be organized now.`,
      }]);
      expect(t3.threads()[0]?.settled).toBe(false);
    });

    it('started outside a T3 thread, names no thread it was started from', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000c'));

      expect(await ended(runtime, 'op-0000000c')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.message).not.toContain('started from');
    });

    it('runs a Codex step on the Codex instance with the effort the lease asks, and finds its session', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000d', { tool: 'codex', model: { name: 'gpt-6.1-sol', effort: 'high' } }));

      expect(await ended(runtime, 'op-0000000d')).toMatchObject({ event: 'finished', session: { tool: 'codex', id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] });
    });

    // T3 runs an instance's tool in the instance's own home, so scoring and resume read the session there.
    it.each([
      { tool: 'claude', instance: 'claudeAgent', model: 'claude-opus-5-5', where: '~/.claude-work', homePath: () => '~/.claude-work', home: () => path.join(t3.home, '.claude-work') },
      { tool: 'codex', instance: 'codex', model: 'gpt-6.1-sol', where: '~/.codex-work', homePath: () => '~/.codex-work', home: () => path.join(t3.home, '.codex-work') },
      { tool: 'claude', instance: 'claudeAgent', model: 'claude-opus-5-5', where: 'an absolute path', homePath: () => path.join(dir, 'accounts', 'second'), home: () => path.join(dir, 'accounts', 'second') },
    ])('finds the session of a $tool step in the home its instance names, $where, and names that home', async ({ tool, instance, model, homePath, home }) => {
      t3.settings({ providerInstances: { [instance]: { driver: instance, config: { homePath: homePath() } } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000e', { tool, model: { name: model } }));

      const end = await ended(runtime, 'op-0000000e');
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toMatchObject({ event: 'finished', session: { tool, id: expect.stringMatching(/^[0-9a-f-]{36}$/), home: home() } });
    });

    // A member whose shell runs teamai with another HOME, such as a script's scratch HOME, still runs T3 Code as
    // themselves: an instance with no homePath keeps its sessions in the tool's home in T3 Code's own home.
    it('finds the session in the tool home of T3 Code\'s own user when teamai runs with another HOME, and names that home', async () => {
      await t3.stop();
      t3 = fakeT3(path.join(dir, 'member'), checkout, { t3HomeInHome: true });
      await t3.start();
      const elsewhere = path.join(dir, 'scratch-home');
      fs.mkdirSync(elsewhere);
      const { runtime, handle } = await opened('attended', { HOME: elsewhere });

      runtime.send(prompt(handle, 'op-0000000f'));

      expect(await ended(runtime, 'op-0000000f')).toMatchObject({ event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/), home: path.join(t3.home, '.claude') } });
    });

    it('runs a tool instance\'s step on the T3 provider instance whose Binary path is its command, and names the session after the instance, in that instance\'s home', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude', homePath: '~/.acme-claude' } } } });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: '.acme-claude', env: 'CLAUDE_CONFIG_DIR' } }] });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000001e', { tool: 'acme-claude' }));

      expect(await ended(runtime, 'op-0000001e')).toMatchObject({ event: 'finished', session: { tool: 'acme-claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/), home: path.join(t3.home, '.acme-claude') } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'acme-claude-t3', model: 'claude-opus-5-5' });
    });

    it('runs a tool on the provider instance `instances` maps it to', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }] });
      const runtime = await initialized({ instances: { claude: 'claude-work' } });
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-0000001f'));

      expect(await ended(runtime, 'op-0000001f')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claude-work', model: 'claude-opus-5-5' });
    });

    // A member whose T3 default is a team tool's wrapper still runs plain claude as Claude itself, not through the wrapper.
    it('runs a claude step on the instance named after Claude, not on the member\'s default instance when that one runs a wrapper, which serves the tool instance', async () => {
      t3.config({ providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' }] });
      t3.settings({ defaultModelSelection: { instanceId: 'acme-claude-t3', model: 'claude-opus-5-5' }, providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude' }], checkout });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'], default_tool: 'acme-claude' } });
      expect(await openOn(runtime, worktree)).toMatchObject({ event: 'ready' });

      runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000020'));

      expect(await ended(runtime, 'op-00000020')).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    });

    // A T3 thread always starts a session of its own, so teamai must not link it to the one the step asked to resume.
    it('says nothing of resuming when the lease asks to resume a session, since the thread started a new one', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000001b', { resume: '0b7e4a52-6f3c-4d1e-9a2b-5c8d7e6f1a30' }));

      const end = await ended(runtime, 'op-0000001b');
      expect(end).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(end).not.toHaveProperty('resumed');
    });

    it('fails model_unavailable for a model or an effort the instance does not run, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000e', { model: { name: 'claude-opus-9' } }));
      runtime.send(prompt(handle, 'op-0000000f', { model: { name: 'claude-sonnet-5-5', effort: 'max' } }));

      expect(await ended(runtime, 'op-0000000e')).toEqual({ op: 'op-0000000e', event: 'failed', failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5.' } });
      expect(await ended(runtime, 'op-0000000f')).toMatchObject({ failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) runs claude-sonnet-5-5 with no effort "max".' } });
      expect(t3.threads()).toEqual([]);
    });

    it('fails tool_failed when the thread\'s run fails, naming the thread by its link', async () => {
      t3.config({ agent: { fail: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000010'));

      expect(await ended(runtime, 'op-00000010')).toEqual({ op: 'op-00000010', event: 'failed', failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(t3.threads()[0]?.threadId)} ("review · teamai r7f3a91c2") ended failed before the step was done.` } });
    });

    // T3 records why a run failed as an error item, titled "Usage limit reached" when the provider's usage ran out.
    it('fails usage_limited, naming the tool, its instance and what T3 says of the reset, when the thread\'s run stops on a usage limit', async () => {
      t3.config({ agent: { fail: true, error: { title: 'Usage limit reached', text: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)' } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000014'));

      const end = await ended(runtime, 'op-00000014');
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({
        op: 'op-00000014', event: 'failed',
        failure: { code: 'usage_limited', message: 'claude reached its usage limit on T3 Code provider instance "claudeAgent" (Claude): You\'ve hit your limit · resets 3pm (Europe/Madrid)' },
      });
    });

    it('fails tool_failed when the thread\'s run fails on a provider error that is no usage limit', async () => {
      t3.config({ agent: { fail: true, error: { title: 'Provider error', text: 'Claude API is overloaded (529). Try again shortly.' } } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000015'));

      expect(await ended(runtime, 'op-00000015')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') } });
    });

    it('fails a thread that completes without writing the result file', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000011'));

      expect(await ended(runtime, 'op-00000011')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`ended without writing the result file ${result}.`) } });
    });

    it('fails a thread whose tool kept no session, since the step could not be scored', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, noSession: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000012'));

      expect(await ended(runtime, 'op-00000012')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`claude kept no session for ${worktree} in ${path.join(t3.home, '.claude')}, so the step cannot be scored or resumed.`) } });
    });

    it('stops the thread on cancel and ends cancelled once its run has ended', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000013'));
      await runtime.next((line) => line['op'] === 'op-00000013' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 1_000 });

      runtime.send({ type: 'cancel', op: 'op-00000013' });

      expect(await ended(runtime, 'op-00000013')).toEqual({ op: 'op-00000013', event: 'cancelled' });
      expect(t3.calls().find((call) => call.tool === 't3_thread_interrupt')?.args).toMatchObject({ stop: true });
      expect(t3.threads()[0]?.status).toBe('interrupted');
    });

    it('answers close_failed, keeping the place, when T3 acknowledges the stop but the thread\'s run does not end', async () => {
      t3.config({ agent: { hold: true, output: {} }, waitCapMs: 50 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000038'));
      await runtime.next((line) => line['op'] === 'op-00000038' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 60_000 });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toMatchObject({
        event: 'close_failed', handle, failure: { code: 'thread_still_runs', message: expect.stringContaining('T3 Code acknowledged the stop, but its run was still running') },
      });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });
    });

    // T3 answers a wait with the run's own status, and timedOut until the work it delegated settled too.
    describe('when the step\'s run delegated work that has not settled', () => {
      it('ends the step only once the delegated work settled, even though its own run completed', async () => {
        t3.config({ delegatesPending: true, waitCapMs: 50 });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000040'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(runtime.lines.filter((line) => line['op'] === 'op-00000040').map((line) => line['event'])).toEqual(['accepted', 'display']);
        t3.config({ delegatesPending: false });

        expect(await ended(runtime, 'op-00000040')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      });

      it('ends the step as the run that answered once the work settled ended, rather than as its own run', async () => {
        t3.config({ resultRunStatus: 'failed' });
        const { runtime, handle } = await opened();

        runtime.send(prompt(handle, 'op-00000041'));

        expect(await ended(runtime, 'op-00000041')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') } });
      });

      // T3 answers the stop no_active_run, from the run's own events, while it stops the delegated work apart.
      it('answers close_failed, keeping the place, until the delegated work of a run that already ended settles', async () => {
        t3.config({ delegatesPending: true, waitCapMs: 50 });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000042'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('completed');

        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toMatchObject({
          event: 'close_failed', handle, failure: { code: 'thread_still_runs', message: expect.stringContaining('the work it delegated had not settled') },
        });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
        expect(t3.threads()[0]?.settled).toBe(false);
        t3.config({ delegatesPending: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]?.settled).toBe(true);
      });

      it('answers a cancel after a restart cancel_failed until the stopped run\'s delegated work settled, and running while a later cancel retries', async () => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000043'));
        await first.runtime.next((line) => line['op'] === 'op-00000043' && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ delegatesPending: true, waitCapMs: 300, stopLagMs: 100 });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-00000043' });

        expect(await second.next((line) => line['op'] === 'op-00000043')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('the work it delegated had not settled') } });
        expect(t3.threads()[0]?.status).toBe('interrupted');
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000043', state: 'failed', failure: { code: 'cancel_failed' } }] });

        // The retried stop takes a while: until it is confirmed, the op runs, so its old failure is not read as this cancel's outcome.
        t3.config({ delegatesPending: false, interruptMs: 1_000 });
        second.send({ type: 'cancel', op: 'op-00000043' });
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000043', state: 'running' }] });

        expect(await second.next((line) => line['op'] === 'op-00000043')).toEqual({ op: 'op-00000043', event: 'cancelled' });
        second.send({ type: 'collect', handle: first.handle });
        await second.next((line) => line['event'] === 'collected');
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    it('refuses a prompt that carries credentials, since the thread runs on T3 Code\'s own sign-in, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send({ ...prompt(handle, 'op-0000001e'), credentials: { ACME_TOKEN: 'acme-secret-value' } });

      const end = await ended(runtime, 'op-0000001e');
      expect(end).toEqual({
        op: 'op-0000001e', event: 'failed', failure: {
          code: 'credentials_unsupported',
          message: 'Runtime t3 got credentials ACME_TOKEN, but a T3 thread runs its tool in T3 Code\'s environment, on T3 Code\'s own sign-in, and this runtime cannot pass it a value (its init offers can.env: false). Remove the credentials from the runtime, or run the step on a runtime that offers can.env.',
        },
      });
      expect(JSON.stringify(runtime.lines)).not.toContain('acme-secret-value');
      expect(t3.threads()).toEqual([]);
    });

    // T3 acknowledges a stop before the run ends, so close waits for the run's end before it settles the thread.
    it('stops a thread still running when teamai closes its place, settles it once its run ends, then answers closed', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000001f'));
      await runtime.next((line) => line['op'] === 'op-0000001f' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 1_000 });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      // The prompt it stopped ends once, before the place is forgotten.
      const events = runtime.lines.filter((line) => line['op'] === 'op-0000001f' || line['event'] === 'closed').map((line) => line['event']);
      expect(events).toEqual(['accepted', 'display', 'cancelled', 'closed']);
    });

    it('stops every thread of the place at once when teamai closes it, within the close bound', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000006d'));
      runtime.send(prompt(handle, 'op-0000006e'));
      await expect.poll(() => t3.threads().map((thread) => thread.status)).toEqual(['running', 'running']);
      t3.config({ interruptMs: 6_000 });
      const closedAt = Date.now();

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle, 20_000)).toEqual({ event: 'closed', handle });
      expect(Date.now() - closedAt).toBeLessThan(10_000);
      expect(t3.threads().map((thread) => thread.status)).toEqual(['interrupted', 'interrupted']);
    }, 30_000);

    it('answers close_failed, keeping the place, when T3 will not stop a thread still running there', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000020'));
      await runtime.next((line) => line['op'] === 'op-00000020' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptFails: true });
      const [thread] = t3.threads();

      runtime.send({ type: 'close', handle });

      const answer = await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted');
      expect(RuntimeMessageSchema.safeParse(answer).success).toBe(true);
      expect(answer).toEqual({
        event: 'close_failed', handle, failure: {
          code: 'thread_still_runs',
          message: `The T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") still runs, and T3 Code did not stop it: Thread ${thread?.threadId} has a run T3 cannot interrupt now. Stop it in T3 Code with its Stop button.`,
        },
      });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000020', state: 'running' }] });
    });

    it('ends a cancelled prompt cancel_failed, and a later close fails, while T3 will not stop its thread', async () => {
      t3.config({ agent: { hold: true, output: {} }, waitCapMs: 50 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000021'));
      await runtime.next((line) => line['op'] === 'op-00000021' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      // Waits on the thread answer while each refused stop is still pending.
      t3.config({ interruptFails: true, interruptMs: 400 });

      runtime.send({ type: 'cancel', op: 'op-00000021' });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'close_failed', 5_000)).toMatchObject({ handle });
      const [thread] = t3.threads();

      expect(await ended(runtime, 'op-00000021')).toEqual({
        op: 'op-00000021', event: 'failed', failure: {
          code: 'cancel_failed',
          message: `The T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") still runs, and T3 Code did not stop it: Thread ${thread?.threadId} has a run T3 cannot interrupt now. Stop it in T3 Code with its Stop button, then run teamai workflow cancel ${RUN} again.`,
        },
      });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'close_failed' || line['event'] === 'closed', 5_000)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000021', state: 'failed', failure: { code: 'cancel_failed' } }] });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000021' && line['event'] === 'cancelled')).toEqual([]);
      expect(t3.threads()[0]?.status).toBe('running');
    });

    // A retried cancel owns the op's end, as the prompt that launched it did: a resent prompt joins it, and starts no follow.
    it('keeps a retried cancel\'s cancelled when teamai resends the prompt while the stop is under way', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000006f'));
      await runtime.next((line) => line['op'] === 'op-0000006f' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptFails: true });
      runtime.send({ type: 'cancel', op: 'op-0000006f' });
      expect(await ended(runtime, 'op-0000006f')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });

      t3.config({ interruptFails: false, interruptMs: 1_000 });
      runtime.send({ type: 'cancel', op: 'op-0000006f' });
      runtime.send(prompt(handle, 'op-0000006f'));
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000006f', state: 'running' }] });

      expect(await ended(runtime, 'op-0000006f')).toEqual({ op: 'op-0000006f', event: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(runtime.lines.filter((line) => line['op'] === 'op-0000006f').map((line) => line['event'])).toEqual(['accepted', 'display', 'failed', 'accepted', 'cancelled']);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000006f', state: 'cancelled' }] });
      expect(t3.threads()).toHaveLength(1);
    });

    // teamai ends a live prompt it cancelled lost when no outcome comes within 15 s, so the runtime answers well before.
    it('answers a live cancel cancel_failed within the stop bound when T3 Code does not answer the stop', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000063'));
      await runtime.next((line) => line['op'] === 'op-00000063' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptMs: 30_000 });
      const cancelledAt = Date.now();

      runtime.send({ type: 'cancel', op: 'op-00000063' });

      expect(await ended(runtime, 'op-00000063')).toMatchObject({
        event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('T3 Code did not answer the stop within 10 s') },
      });
      expect(Date.now() - cancelledAt).toBeLessThan(12_000);
    }, 20_000);

    // `workflow cancel --release` let the attempt go: a launch T3 answers later finds no place to record its thread in.
    it('does not record a released place again when T3 answers its launch after the close gave up on it', async () => {
      t3.config({ agent: { hold: true, output: {} }, launchMs: 12_000 });
      const { runtime, handle } = await opened();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      runtime.send(prompt(handle, 'op-000000b0'));
      await runtime.next((line) => line['op'] === 'op-000000b0' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle, release: true });

      expect(await runtime.next((line) => line['handle'] === handle, 15_000)).toMatchObject({ event: 'close_failed', handle, failure: { code: 't3_unavailable' } });
      expect(fs.existsSync(record)).toBe(false);
      await runtime.next((line) => line['op'] === 'op-000000b0' && line['event'] === 'display', 10_000);
      expect(fs.existsSync(record)).toBe(false);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
    }, 40_000);

    it('does not record a released place when its open ends after the close gave up on it', async () => {
      const runtime = await initialized();
      t3.config({ projectsMs: 12_000 });
      const handle = `t3-${RUN}-a1b2c3d4`;
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      runtime.send({ type: 'open', op: 'op-000000b1', run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      await runtime.next((line) => line['op'] === 'op-000000b1' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle, release: true });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted' && !isNotice(line), 15_000)).toMatchObject({ event: 'close_failed', handle, failure: { code: 't3_unavailable' } });
      expect(await runtime.next((line) => line['op'] === 'op-000000b1' && line['event'] !== 'accepted' && !isNotice(line), 10_000)).toEqual({
        op: 'op-000000b1', event: 'failed', failure: { code: 'open_failed', message: `teamai released ${handle} while T3 Code was still opening it, so the runtime does not keep it.` },
      });
      expect(fs.existsSync(record)).toBe(false);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted' && !isNotice(line))).toEqual({ event: 'gone', handle });
    }, 40_000);

    // The 10 s run from the moment the cancel is read, a launch still pending included, so the answer beats teamai's 15 s.
    it('answers a cancel that comes while T3 launches the thread within the stop bound, when T3 then does not answer the stop', async () => {
      t3.config({ agent: { hold: true, output: {} }, launchMs: 7_000, interruptMs: 30_000 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000069'));
      await runtime.next((line) => line['op'] === 'op-00000069' && line['event'] === 'accepted');
      const cancelledAt = Date.now();

      runtime.send({ type: 'cancel', op: 'op-00000069' });

      expect(await ended(runtime, 'op-00000069')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
      expect(Date.now() - cancelledAt).toBeLessThan(12_000);
    }, 30_000);

    it('keeps the thread of a launch T3 answers after the cancel gave up on it, with no second outcome, and a later cancel stops it', async () => {
      t3.config({ agent: { hold: true, output: {} }, launchMs: 12_000 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000006a'));
      await runtime.next((line) => line['op'] === 'op-0000006a' && line['event'] === 'accepted');
      const cancelledAt = Date.now();

      runtime.send({ type: 'cancel', op: 'op-0000006a' });

      expect(await ended(runtime, 'op-0000006a')).toEqual({
        op: 'op-0000006a', event: 'failed', failure: {
          code: 'cancel_failed',
          message: `teamai cancelled the step while T3 Code launched its thread "review · teamai ${RUN}", and the launch had not finished 10 s later, so the thread may run. Run teamai workflow cancel ${RUN} again.`,
        },
      });
      expect(Date.now() - cancelledAt).toBeLessThan(12_000);
      // The launch answers now: the thread is the runtime's to stop, and the op keeps its one outcome.
      await runtime.next((line) => line['op'] === 'op-0000006a' && line['event'] === 'display', 10_000);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000006a', state: 'failed', failure: { code: 'cancel_failed' } }], display: { url: linkTo(t3.threads()[0]?.threadId) } });

      runtime.send({ type: 'cancel', op: 'op-0000006a' });

      expect(await runtime.next((line) => line['op'] === 'op-0000006a')).toEqual({ op: 'op-0000006a', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      expect(runtime.lines.filter((line) => line['op'] === 'op-0000006a').map((line) => line['event'])).toEqual(['accepted', 'failed', 'display', 'cancelled']);
    }, 40_000);

    // T3 answers a stop of a thread the person deleted thread_not_found: nothing of it runs any more.
    it('counts a thread the person deleted in T3 as stopped and settled, so close finishes', async () => {
      t3.config({ agent: { waits: true }, interruptFails: true });
      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-00000050'));
      expect(await ended(runtime, 'op-00000050')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
      t3.config({ interruptFails: false });
      t3.deleteThread(z.string().parse(t3.threads()[0]?.threadId));

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(runtime.stderr()).not.toContain('could not settle');
    });

    // T3 Code went away mid-run: the thread may still run, so the op ends as a stop teamai could not confirm.
    it('ends a prompt cancel_failed when it loses track of a thread that may still run', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000068'));
      await runtime.next((line) => line['op'] === 'op-00000068' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await t3.stop();

      expect(await runtime.next((line) => line['op'] === 'op-00000068' && line['event'] !== 'accepted' && line['event'] !== 'display', 30_000)).toMatchObject({
        event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/could not be followed, so it may still run: .+ Run teamai workflow cancel r7f3a91c2 to stop it\.$/) },
      });
    }, 40_000);

    it('fails a step whose agent asks for an approval in an unattended run, and stops its thread', async () => {
      t3.config({ agent: { waits: true } });
      const { runtime, handle } = await opened('unattended');

      runtime.send(prompt(handle, 'op-00000014'));

      expect(await ended(runtime, 'op-00000014')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('asked for an approval, and nobody is there to give it in an unattended run.') } });
      expect(t3.threads()[0]).toMatchObject({ runtimeMode: 'auto', status: 'interrupted' });
    });

    // T3 holds an approval a delegated task asks for on the task's own thread, not as a pending request of the step's.
    it('fails a step whose delegated task asks for an approval in an unattended run, and stops its thread and the task', async () => {
      t3.config({ agent: { delegatedWaits: true } });
      const { runtime, handle } = await opened('unattended');

      runtime.send(prompt(handle, 'op-00000014'));

      const end = await ended(runtime, 'op-00000014');
      const step = t3.threads().find((thread) => thread.parentThreadId === undefined);
      expect(end).toEqual({ op: 'op-00000014', event: 'failed', failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(step?.threadId)} ("review · teamai ${RUN}") delegated a task that asked for an approval, and nobody is there to give it in an unattended run.` } });
      expect(t3.threads().map((thread) => thread.status)).toEqual(['interrupted', 'interrupted']);
    });

    it('refuses a lease in unattended permissions, which its offer never takes, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000015', { permissions: 'unattended' }));

      expect(await ended(runtime, 'op-00000015')).toMatchObject({ event: 'failed', failure: { code: 'unattended_unsupported' } });
      expect(t3.threads()).toEqual([]);
    });

    it('reconnects to the same thread after its own restart: reattach shows it running, and the repeated prompt launches no other', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: { verdict: 'approve' } } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000017'));
      await first.runtime.next((line) => line['op'] === 'op-00000017' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'reattach', handle: first.handle });
      const [thread] = t3.threads();

      expect(await second.next((line) => line['event'] === 'alive')).toEqual({
        event: 'alive', handle: first.handle, ops: [{ op: 'op-00000017', state: 'running' }],
        display: { label: `review · teamai ${RUN}`, url: linkTo(thread?.threadId), fields: { thread: thread?.threadId, model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      second.send(prompt(first.handle, 'op-00000017'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-00000017')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      expect(t3.threads()).toHaveLength(1);
    });

    it('reconnects to the same thread after the member signed in again, where a repeated launch would start another', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-0000004f'));
      await first.runtime.next((line) => line['op'] === 'op-0000004f' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      t3.config({ token: 'fake-t3-token-second-0987654321', namespace: 'session-2' });
      signIn(t3, 'fake-t3-token-second-0987654321');

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      second.send(prompt(first.handle, 'op-0000004f'));
      await second.next((line) => line['op'] === 'op-0000004f' && line['event'] === 'accepted');
      second.send({ type: 'close', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('stops the thread a runtime before it left running when teamai cancels that prompt first thing after a restart, and settles it at collect', async () => {
      t3.config({ agent: { release: path.join(dir, 'release'), output: { verdict: 'approve' } } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-0000001c'));
      await first.runtime.next((line) => line['op'] === 'op-0000001c' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      // As `teamai workflow cancel` does for a run whose driver died: cancel, then reattach until the op no longer runs.
      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-0000001c' });

      await expect.poll(async () => {
        second.send({ type: 'reattach', handle: first.handle });

        return (await second.next((line) => line['event'] === 'alive'))['ops'];
      }).toEqual([{ op: 'op-0000001c', state: 'cancelled' }]);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: false });

      second.send({ type: 'collect', handle: first.handle });

      expect(await second.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    describe('in recover mode, after the runtime that launched a thread exited', () => {
      /** A step thread left running by a runtime that exited, and a runtime opened in recover mode. */
      const recovering = async (op: string): Promise<{ runtime: Connection; handle: string }> => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, op));
        await first.runtime.next((line) => line['op'] === op && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'recover', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toEqual({ type: 'init', ok: true, can: {} });

        return { runtime, handle: first.handle };
      };

      // `workflow cancel --release`: the person checked nothing of the attempt runs, and let it go.
      it('forgets the place when a close that releases the attempt cannot stop its thread, and still answers close_failed', async () => {
        const { runtime, handle } = await recovering('op-00000063');
        t3.config({ interruptFails: true });
        const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);

        runtime.send({ type: 'close', handle, release: true });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({
          event: 'close_failed', handle,
          failure: { code: 'thread_still_runs', message: `Runtime t3 forgot ${handle}, as you released it, though T3 Code did not confirm it closed (thread_still_runs). If one of its T3 threads still runs, stop it in T3 Code with its Stop button.` },
        });
        expect(fs.existsSync(record)).toBe(false);
        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'gone')).toEqual({ event: 'closed', handle });
      });

      it('forgets a place whose record it cannot read when a close releases the attempt', async () => {
        const { runtime, handle } = await recovering('op-00000064');
        const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
        fs.writeFileSync(record, '{broken');

        runtime.send({ type: 'close', handle, release: true });

        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', handle, failure: { code: 'journal_unreadable' } });
        expect(fs.existsSync(record)).toBe(false);
      });

      it('answers reattach from its journal, and reaches T3 only to stop the thread on cancel and to settle it at close', async () => {
        const { runtime, handle } = await recovering('op-00000060');
        const before = t3.calls().length;

        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'alive', handle, ops: [{ op: 'op-00000060', state: 'running' }] });
        expect(t3.calls().slice(before)).toEqual([]);

        runtime.send({ type: 'cancel', op: 'op-00000060' });
        expect(await runtime.next((line) => line['op'] === 'op-00000060')).toEqual({ op: 'op-00000060', event: 'cancelled' });
        runtime.send({ type: 'collect', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collected', handle });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // A whole close fits 10 s, looking a lost launch up included; past that it keeps the place.
      it('answers close_failed within the close bound, keeping the place, while T3 is slow to answer the repeated launch', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 30_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000006c'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 16_000 });

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'recover', options: { environment: 'local' } });
        await runtime.next((line) => line['type'] === 'init');
        const closedAt = Date.now();
        runtime.send({ type: 'close', handle: first.handle });

        expect(await runtime.next((line) => line['handle'] === first.handle, 20_000)).toMatchObject({
          event: 'close_failed', handle: first.handle, failure: { code: 't3_unavailable', message: expect.stringContaining(`"review · teamai ${RUN}" and T3 Code never answered, so it may run, and T3 Code did not say within 10 s whether it launched it`) },
        });
        expect(Date.now() - closedAt).toBeLessThan(12_000);
        runtime.send({ type: 'reattach', handle: first.handle });
        expect(await runtime.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'alive', ops: [{ op: 'op-0000006c', state: 'running' }] });
        expect(t3.threads()[0]?.status).toBe('running');

        t3.config({ launchMs: 0 });
        runtime.send({ type: 'close', handle: first.handle });

        expect(await runtime.next((line) => line['handle'] === first.handle, 20_000)).toEqual({ event: 'closed', handle: first.handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      }, 60_000);

      // A retried cancel that cannot journal its op running leaves nothing behind that would swallow the next one.
      it('answers a retried cancel again once the record can be written, after it could not journal the retry', async () => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000076'));
        await first.runtime.next((line) => line['op'] === 'op-00000076' && line['event'] === 'display');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        t3.config({ interruptFails: true });
        first.runtime.send({ type: 'cancel', op: 'op-00000076' });
        expect(await ended(first.runtime, 'op-00000076')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
        await first.runtime.close();
        t3.config({ interruptFails: false });

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'recover', options: { environment: 'local' } });
        await runtime.next((line) => line['type'] === 'init');
        const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
        fs.chmodSync(places, 0o500);
        runtime.send({ type: 'cancel', op: 'op-00000076' });
        expect(await runtime.next((line) => line['op'] === 'op-00000076')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('EACCES') } });
        fs.chmodSync(places, 0o700);

        runtime.send({ type: 'cancel', op: 'op-00000076' });

        expect(await runtime.next((line) => line['op'] === 'op-00000076')).toEqual({ op: 'op-00000076', event: 'cancelled' });
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      it('keeps the place while T3 Code cannot be reached, and closes it once T3 Code is back', async () => {
        const { runtime, handle } = await recovering('op-00000061');
        await t3.stop();
        fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));

        runtime.send({ type: 'cancel', op: 'op-00000061' });
        expect(await runtime.next((line) => line['op'] === 'op-00000061')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('Open T3 Code') } });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining('Open T3 Code') } });

        // The fake comes back on another port, where the same sign-in is kept under its new address.
        await t3.start();
        signIn(t3);
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    // As `teamai workflow cancel` goes for a run whose driver died (cancel, reattach, collect, close), with T3 Code down.
    it('neither forgets nor drops a place whose thread still runs while T3 Code cannot be reached after a restart', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000044'));
      await first.runtime.next((line) => line['op'] === 'op-00000044' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      await t3.stop();
      fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 't3_unavailable' } });
      second.send({ type: 'reattach', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'alive', handle: first.handle, ops: [{ op: 'op-00000044', state: 'running' }] });
      second.send({ type: 'close', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'close_failed', failure: { code: 't3_unavailable' } });
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'alive' });

      // T3 Code is back: the place closes as usual.
      await t3.start();
      const third = start();
      third.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await third.next((line) => line['type'] === 'init');
      third.send({ type: 'close', handle: first.handle });

      expect(await third.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // A thread the journal holds stays the runtime's to stop until it saw that thread stop, whatever ended its op and
    // whichever runtime process launched it.
    describe('when a prompt resumed after a restart is refused while its thread still runs', () => {
      /** A step thread left running by a runtime that exited, and a second runtime, set up by `before`, that it is resent to. */
      const resumed = async (op: string, before: () => void): Promise<{ runtime: Connection; handle: string }> => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, op));
        await first.runtime.next((line) => line['op'] === op && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        before();

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        runtime.send(prompt(first.handle, op));

        return { runtime, handle: first.handle };
      };

      // Only a running op, or one failed cancel_failed, may still run, so the refusal rides in a cancel_failed.
      it('keeps the thread when T3 no longer offers the model: collect leaves it, and close stops it first', async () => {
        const { runtime, handle } = await resumed('op-00000045', () => t3.config({ providers: [{ ...CLAUDE, models: [{ id: 'claude-sonnet-5-5' }] }, CODEX] }));

        expect(await ended(runtime, 'op-00000045')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('has no model claude-opus-5-5') } });
        runtime.send({ type: 'collect', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collected', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ interruptFails: true });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'alive', ops: [{ op: 'op-00000045', state: 'failed' }] });

        t3.config({ interruptFails: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // T3 finds a repeated launch only under the sign-in that sent it, so a thread the journal names is reconnected to by its id.
      it('sends no launch for a thread it holds, so T3 refusing launches cannot drop it, and close stops it', async () => {
        const { runtime, handle } = await resumed('op-00000046', () => t3.config({ launchFails: true }));
        await runtime.next((line) => line['op'] === 'op-00000046' && line['event'] === 'accepted');

        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(await ended(runtime, 'op-00000046')).toEqual({ op: 'op-00000046', event: 'cancelled' });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(1);
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    // A launch's clientRequestId is journaled before the launch, and T3 answers a repeated launch with the thread it
    // launched for that id, so a launch whose reply never came is found again.
    describe('when T3 launched a step\'s thread but its reply never came', () => {
      it('finds the thread at close by repeating the launch, keeping the place while T3 cannot answer', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000047'));

        expect(await ended(runtime, 'op-00000047')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`"review · teamai ${RUN}"`) } });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({
          event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining(`"review · teamai ${RUN}"`) },
        });

        t3.config({ launchReplyLost: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // T3 answers a call it could not complete with orchestration_error, which says nothing of what it launched.
      it('keeps the place when T3 cannot complete the repeated launch, and finds the thread once it can', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000004a'));
        expect(await ended(runtime, 'op-0000004a')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        t3.config({ launchReplyLost: false, launchUnavailable: true });

        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({
          event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining('The operation could not be completed') },
        });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ launchUnavailable: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // The op may still run, so it ends as a stop teamai could not confirm, which neither collect nor finishing may follow.
      it('ends the prompt cancel_failed, and a later cancel finds and stops the thread', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000067'));

        expect(await ended(runtime, 'op-00000067')).toEqual({
          op: 'op-00000067', event: 'failed', failure: {
            code: 'cancel_failed',
            message: `teamai launched the T3 thread "review · teamai ${RUN}", and T3 Code did not confirm the launch, so it may run: MCP error -32603: The connection closed before T3 answered. Run teamai workflow cancel ${RUN} to find and stop it.`,
          },
        });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toEqual([]);

        t3.config({ launchReplyLost: false });
        runtime.send({ type: 'cancel', op: 'op-00000067' });

        expect(await ended(runtime, 'op-00000067')).toEqual({ op: 'op-00000067', event: 'cancelled' });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      it('answers a cancel after a restart cancel_failed while T3 cannot complete the repeated launch, and cancelled once it can', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000004b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0, launchUnavailable: true });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-0000004b' });

        expect(await second.next((line) => line['op'] === 'op-0000004b')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('The operation could not be completed') } });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(2);
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000004b', state: 'failed', failure: { code: 'cancel_failed' } }] });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ launchUnavailable: false });
        second.send({ type: 'cancel', op: 'op-0000004b' });

        expect(await second.next((line) => line['op'] === 'op-0000004b')).toEqual({ op: 'op-0000004b', event: 'cancelled' });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      // T3 checks the mode a sign-in allows before it looks a repeated launch up, so a repeat in another mode finds nothing.
      it('resends a prompt whose launch T3 never answered as it was journaled, so it reconnects even in a mode the sign-in would refuse', async () => {
        const release = path.join(dir, 'release');
        t3.config({ agent: { release, output: { verdict: 'approve' } }, access: 'approval-required', launchMs: 3_000 });
        const first = await opened('attended', {}, { runtime_mode: 'approval-required' });
        first.runtime.send(prompt(first.handle, 'op-00000066'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0 });

        // This runtime launches new threads in auto, which the sign-in does not allow.
        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        second.send(prompt(first.handle, 'op-00000066'));
        expect(await second.next((line) => line['op'] === 'op-00000066' && line['event'] === 'display')).toMatchObject({ display: { url: linkTo(t3.threads()[0]?.threadId) } });
        fs.writeFileSync(release, '');

        expect(await ended(second, 'op-00000066')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch').map((call) => call.args['runtimeMode'])).toEqual(['approval-required', 'approval-required']);
      });

      // T3 finds a repeated launch only under the sign-in that sent it, and a sign-in lasts a limited time.
      describe('after the member signed in again', () => {
        const SECOND = 'fake-t3-token-second-0987654321';

        /** A launch T3 made under the first sign-in and never answered, its runtime gone, and a runtime on a new sign-in. */
        const lostThenSignedInAgain = async (op: string): Promise<{ runtime: Connection; handle: string; record: string }> => {
          t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
          const first = await opened();
          first.runtime.send(prompt(first.handle, op));
          await expect.poll(() => t3.threads()[0]?.status).toBe('running');
          await first.runtime.close();
          t3.config({ launchMs: 0, token: SECOND, namespace: 'session-2' });
          signIn(t3, SECOND);

          const runtime = start();
          runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
          expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });

          return { runtime, handle: first.handle, record: path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`) };
        };

        const unconfirmed = (record: string) => ({
          code: 'launch_unconfirmed',
          message: `teamai launched the T3 thread "review · teamai ${RUN}" in the T3 project "acme-app" under an earlier T3 Code sign-in, and T3 Code never answered, so it may still run. T3 Code finds that launch only under the sign-in that sent it, so teamai cannot find or stop it. In T3 Code, stop "review · teamai ${RUN}" with its Stop button if it runs, then delete ${record} and run teamai workflow cancel ${RUN} again.`,
        });

        it('keeps the place at close, naming the thread to stop and the record to delete, and launches nothing', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004c');

          runtime.send({ type: 'close', handle });

          expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'close_failed', handle, failure: unconfirmed(record) });
          expect(t3.threads()).toHaveLength(1);
          expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });
          // The record names the sign-in by a hash, never by its token.
          expect(fs.readFileSync(record, 'utf8')).not.toContain('fake-t3-token');
        });

        it('fails the op on a cancel, saying the same, and launches nothing', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004d');

          runtime.send({ type: 'cancel', op: 'op-0000004d' });

          expect(await runtime.next((line) => line['op'] === 'op-0000004d')).toEqual({ op: 'op-0000004d', event: 'failed', failure: { ...unconfirmed(record), code: 'cancel_failed' } });
          runtime.send({ type: 'close', handle });
          expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'launch_unconfirmed' } });
          expect(t3.threads()).toHaveLength(1);
          expect(t3.threads()[0]?.status).toBe('running');
        });

        it('fails a resumed prompt, saying the same, rather than launching the step again', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004e');

          runtime.send(prompt(handle, 'op-0000004e'));

          expect(await ended(runtime, 'op-0000004e')).toEqual({ op: 'op-0000004e', event: 'failed', failure: { ...unconfirmed(record), code: 'cancel_failed' } });
          expect(t3.threads()).toHaveLength(1);
        });
      });

      // Looking the launch up counts toward the cancel's 10 s.
      it('answers a cancel after a restart cancel_failed within the stop bound while T3 is slow to answer the repeated launch', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000006b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 16_000 });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        const cancelledAt = Date.now();
        second.send({ type: 'cancel', op: 'op-0000006b' });

        expect(await second.next((line) => line['op'] === 'op-0000006b', 20_000)).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('did not say within 10 s whether it launched it') } });
        expect(Date.now() - cancelledAt).toBeLessThan(12_000);
        expect(t3.threads()[0]?.status).toBe('running');
      }, 40_000);

      // A record written after its place closed would be a place no close removes.
      it('writes no record for a place a close removed while a cancel still looked its launch up', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000007b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 13_000 });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        const cancelledAt = Date.now();
        second.send({ type: 'cancel', op: 'op-0000007b' });
        expect(await second.next((line) => line['op'] === 'op-0000007b', 20_000)).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });

        t3.config({ launchMs: 0 });
        second.send({ type: 'close', handle: first.handle });
        expect(await second.next((line) => line['handle'] === first.handle, 20_000)).toEqual({ event: 'closed', handle: first.handle });
        const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
        expect(fs.readdirSync(places)).toEqual([]);

        // The cancel's lookup answers 13 s after it was sent.
        await new Promise((resolve) => { setTimeout(resolve, Math.max(cancelledAt + 14_500 - Date.now(), 0)); });
        expect(fs.readdirSync(places)).toEqual([]);
      }, 40_000);

      it('finds and stops the thread when teamai cancels the prompt after the runtime that launched it exited first', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000048'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0 });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-00000048' });

        await expect.poll(async () => {
          second.send({ type: 'reattach', handle: first.handle });

          return (await second.next((line) => line['event'] === 'alive'))['ops'];
        }).toEqual([{ op: 'op-00000048', state: 'cancelled' }]);
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
        second.send({ type: 'close', handle: first.handle });
        expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
        expect(t3.threads()[0]?.settled).toBe(true);
      });
    });

    it('keeps a place whose record it cannot read, failing what needs it with the file to look at, rather than answering gone', async () => {
      const { runtime, handle } = await opened();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      fs.writeFileSync(record, '{broken');
      const unreadable = { code: 'journal_unreadable', message: expect.stringContaining(record) };

      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'failed', handle, failure: unreadable });
      // The record may hold the op's thread, launched by a runtime before this one, so the prompt may still run.
      runtime.send(prompt(handle, 'op-00000049'));
      expect(await ended(runtime, 'op-00000049')).toEqual({ op: 'op-00000049', event: 'failed', failure: { ...unreadable, code: 'cancel_failed' } });
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collect_failed', handle, failure: unreadable });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'close_failed', handle, failure: unreadable });

      expect(fs.readFileSync(record, 'utf8')).toBe('{broken');
      expect(t3.threads()).toEqual([]);
    });

    // A record that cannot be read is not proof the op launched nothing, so the cancel neither stops nor forgets its thread.
    it('fails a cancel after a restart cancel_failed, naming the record it cannot read, and a resent prompt then reconnects rather than ending cancelled', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000070'));
      await first.runtime.next((line) => line['op'] === 'op-00000070' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`);
      const kept = fs.readFileSync(record, 'utf8');
      fs.writeFileSync(record, '{broken');

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000070' });

      expect(await second.next((line) => line['op'] === 'op-00000070')).toEqual({ op: 'op-00000070', event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(record) } });
      expect(fs.readFileSync(record, 'utf8')).toBe('{broken');

      // The person repairs the record: the resent prompt follows the thread the record names.
      fs.writeFileSync(record, kept);
      second.send(prompt(first.handle, 'op-00000070'));
      await second.next((line) => line['op'] === 'op-00000070' && line['event'] === 'accepted');
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000070', state: 'running' }] });
      expect(second.lines.filter((line) => line['op'] === 'op-00000070' && line['event'] === 'cancelled')).toEqual([]);
      expect(t3.threads()[0]?.status).toBe('running');
    });

    // The record it cannot read may be another place's: the cancel still stands, so the prompt it cancelled launches nothing.
    it('launches nothing for a prompt teamai cancelled while another place\'s record could not be read', async () => {
      const { runtime, handle } = await opened();
      const other = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', 't3-rother-a0000000.json');
      fs.writeFileSync(other, '{broken');

      runtime.send({ type: 'cancel', op: 'op-00000076' });
      expect(await runtime.next((line) => line['op'] === 'op-00000076')).toEqual({ op: 'op-00000076', event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(other) } });
      runtime.send(prompt(handle, 'op-00000076'));

      expect(await ended(runtime, 'op-00000076')).toEqual({ op: 'op-00000076', event: 'cancelled' });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);
    });

    // Only a confirmed stop ends an op cancelled, never a mark that teamai cancelled it before the runtime saw its prompt.
    it('stops the thread a record names before it ends cancelled a prompt teamai cancelled while that record was missing', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000071'));
      await first.runtime.next((line) => line['op'] === 'op-00000071' && line['event'] === 'display');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`);
      fs.renameSync(record, `${record}.aside`);

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000071' });
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'gone', handle: first.handle });

      fs.renameSync(`${record}.aside`, record);
      second.send(prompt(first.handle, 'op-00000071'));

      expect(await ended(second, 'op-00000071')).toEqual({ op: 'op-00000071', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
    });

    // teamai fails every request it waits on when a runtime writes a line that names none, so each failure names its own.
    it('fails only the request it cannot carry out, naming its handle or op, when its journal cannot be written', async () => {
      const { runtime, handle } = await opened();
      const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
      fs.chmodSync(places, 0o500);

      runtime.send({ type: 'open', op: 'op-00000062', run: RUN, attempt: 'a9e8d7c6', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      expect(await runtime.next((line) => line['op'] === 'op-00000062' && line['event'] !== 'accepted')).toEqual({
        op: 'op-00000062', event: 'failed', failure: { code: 'runtime_error', message: expect.stringMatching(/^Runtime t3 could not carry out open of op-00000062: .*EACCES/) },
      });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({
        event: 'failed', handle, failure: { code: 'runtime_error', message: expect.stringMatching(new RegExp(`^Runtime t3 could not carry out close of ${handle}: .*EACCES`)) },
      });

      expect(runtime.lines.filter((line) => line['event'] === 'error')).toEqual([]);
    });

    // An op that owned its end without a journaled launch would make the resent prompt join it and never end.
    it('launches nothing for a prompt whose launch it cannot journal, and runs the prompt teamai resends once it can', async () => {
      const { runtime, handle } = await opened();
      const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
      fs.chmodSync(places, 0o500);

      runtime.send(prompt(handle, 'op-00000077'));
      expect(await ended(runtime, 'op-00000077')).toEqual({ op: 'op-00000077', event: 'failed', failure: { code: 'runtime_error', message: expect.stringMatching(/^Runtime t3 could not carry out prompt of op-00000077: .*EACCES/) } });
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);

      fs.chmodSync(places, 0o700);
      runtime.send(prompt(handle, 'op-00000077'));

      expect(await ended(runtime, 'op-00000077')).toMatchObject({ event: 'finished' });
      expect(t3.threads()).toHaveLength(1);
    });

    // teamai fails every request it waits on for an uncorrelated error, so only a line that names no request gets one.
    it('fails a malformed request that still names its op or handle on its own, and answers a line that names none with an error', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000073'));
      await runtime.next((line) => line['op'] === 'op-00000073' && line['event'] === 'display');

      runtime.send({ type: 'prompt', op: 'op-00000074', handle });
      expect(await runtime.next((line) => line['op'] === 'op-00000074')).toEqual({ op: 'op-00000074', event: 'failed', failure: { code: 'runtime_protocol', message: expect.stringMatching(/^Not a protocol 1 request: /) } });
      runtime.send({ type: 'settle', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'failed', handle, failure: { code: 'runtime_protocol', message: expect.stringMatching(/^Not a protocol 1 request: /) } });
      runtime.send({ type: 'close' });
      expect(await runtime.next((line) => line['event'] === 'error')).toEqual({ event: 'error', message: expect.stringMatching(/^Not a protocol 1 request: /) });

      expect(runtime.lines.filter((line) => line['event'] === 'error')).toHaveLength(1);
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000073').map((line) => line['event'])).toEqual(['accepted', 'display']);
    });

    // A failure for an op the runtime already runs would be a second outcome, while its thread still runs.
    it('drops a malformed request that names an op it already runs, which then ends once', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000075'));
      await runtime.next((line) => line['op'] === 'op-00000075' && line['event'] === 'display');

      runtime.send({ type: 'prompt', op: 'op-00000075', handle });
      // Lines are read in order: the reattach answers after the malformed line was.
      runtime.send({ type: 'reattach', handle });
      await runtime.next((line) => line['event'] === 'alive');
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000075').map((line) => line['event'])).toEqual(['accepted', 'display']);
      expect(runtime.stderr()).toContain('op-00000075');
      runtime.send({ type: 'cancel', op: 'op-00000075' });

      expect(await ended(runtime, 'op-00000075')).toEqual({ op: 'op-00000075', event: 'cancelled' });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000075').map((line) => line['event'])).toEqual(['accepted', 'display', 'cancelled']);
      expect(runtime.lines.filter((line) => line['event'] === 'error')).toEqual([]);
    });

    it('keeps running, and ends its prompt, when it notes a dropped line after teamai stopped reading its stderr', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000079'));
      await runtime.next((line) => line['op'] === 'op-00000079' && line['event'] === 'display');
      runtime.child.stderr.destroy();

      // Its note about the dropped line goes to a stderr nobody reads.
      runtime.send({ type: 'prompt', op: 'op-00000079', handle });
      runtime.send({ type: 'reattach', handle });
      await runtime.next((line) => line['event'] === 'alive');
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      runtime.send({ type: 'cancel', op: 'op-00000079' });

      expect(await ended(runtime, 'op-00000079')).toEqual({ op: 'op-00000079', event: 'cancelled' });
    });

    // A prompt whose end goes unanswered is one teamai waits on for good.
    it('answers a prompt that ends while its record cannot be written, once, and says on stderr that it was not recorded', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007a'));
      await runtime.next((line) => line['op'] === 'op-0000007a' && line['event'] === 'display');
      const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
      fs.chmodSync(places, 0o500);
      fs.writeFileSync(release, '');

      expect(await ended(runtime, 'op-0000007a')).toMatchObject({ op: 'op-0000007a', event: 'finished' });
      fs.chmodSync(places, 0o700);
      expect(runtime.stderr()).toMatch(/^Runtime t3 could not record how op-0000007a ended, so only this process reports that end: .*EACCES/m);
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');
      expect(runtime.lines.filter((line) => line['op'] === 'op-0000007a').map((line) => line['event'])).toEqual(['accepted', 'display', 'finished']);
    });

    it('reports the end of a prompt it could not record to a reattach, a cancel and a repeated prompt in the same process, never another end', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007c'));
      await runtime.next((line) => line['op'] === 'op-0000007c' && line['event'] === 'display');
      const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
      fs.chmodSync(places, 0o500);
      fs.writeFileSync(release, '');
      const end = await ended(runtime, 'op-0000007c');
      fs.chmodSync(places, 0o700);
      expect(end).toMatchObject({ event: 'finished' });

      runtime.send({ type: 'reattach', handle });

      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000007c', state: 'finished' }] });
      runtime.send({ type: 'cancel', op: 'op-0000007c' });
      expect(await ended(runtime, 'op-0000007c')).toEqual(end);
      const launches = t3.calls().filter((call) => call.tool === 't3_thread_launch').length;
      runtime.send(prompt(handle, 'op-0000007c'));
      expect(await ended(runtime, 'op-0000007c')).toEqual(end);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(launches);
    });

    // A cancelled end, unlike a finished one, cannot be rebuilt by following the stopped thread again.
    it('answers a repeated prompt with a cancelled end it could not record, not with the stopped thread\'s own end', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000007d'));
      await runtime.next((line) => line['op'] === 'op-0000007d' && line['event'] === 'display');
      const places = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places');
      fs.chmodSync(places, 0o500);
      runtime.send({ type: 'cancel', op: 'op-0000007d' });
      const end = await ended(runtime, 'op-0000007d');
      fs.chmodSync(places, 0o700);
      expect(end).toEqual({ op: 'op-0000007d', event: 'cancelled' });

      runtime.send(prompt(handle, 'op-0000007d'));

      expect(await ended(runtime, 'op-0000007d')).toEqual(end);
    });

    it('answers a repeated prompt that ended with the same outcome, before and after its own restart', async () => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000018'));
      const end = await ended(runtime, 'op-00000018');
      runtime.send(prompt(handle, 'op-00000018'));
      expect(await ended(runtime, 'op-00000018')).toEqual(end);
      await runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'reattach', handle });
      expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000018', state: 'finished', session: end['session'], result: end['result'] }] });
      second.send(prompt(handle, 'op-00000018'));

      expect(await ended(second, 'op-00000018')).toEqual(end);
      expect(t3.threads()).toHaveLength(1);
    });

    // teamai may close a place it opened before the open answered: close waits for the open, then removes what it made.
    it('closes a place only once its open finished, leaving no record of it', async () => {
      t3.config({ projectsMs: 2_000 });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await runtime.next((line) => line['type'] === 'init');
      runtime.send({ type: 'open', op: 'op-00000072', run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
      const handle = z.string().parse((await runtime.next((line) => line['op'] === 'op-00000072'))['handle']);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted', 15_000)).toEqual({ event: 'closed', handle });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000072').map((line) => line['event'])).toEqual(['accepted', 'ready']);
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
    });

    it('answers reattach of a closed place gone', async () => {
      const { runtime, handle } = await opened();
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });

      runtime.send({ type: 'reattach', handle });

      expect(await runtime.next((line) => line['event'] === 'gone')).toEqual({ event: 'gone', handle });
    });

    it('ends an interactive step only once the agent wrote the result: an idle thread after a turn does not end it', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000019', { interactive: true }));
      await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(runtime.lines.filter((line) => line['op'] === 'op-00000019').map((line) => line['event'])).toEqual(['accepted', 'display']);
      expect(t3.threads()[0]?.message).toContain('Write the result file only once they say the step is done.');
      // The person said it is done, and the agent wrote the result.
      fs.writeFileSync(result, JSON.stringify({ output: { notes: 'agreed' } }));

      expect(await ended(runtime, 'op-00000019')).toMatchObject({ event: 'finished', result: { output: { notes: 'agreed' } } });
    });

    it('runs no command', async () => {
      const { runtime, handle } = await opened();

      runtime.send({ type: 'exec', op: 'op-00000016', handle, argv: ['/bin/sh', '-c', 'touch ran'], env: {}, unset: [], cwd: worktree });

      expect(await ended(runtime, 'op-00000016')).toMatchObject({ event: 'failed', failure: { code: 'exec_unsupported' } });
      expect(fs.existsSync(path.join(worktree, 'ran'))).toBe(false);
    });
  });

  describe('a confined prompt (a judge)', () => {
    const RUN = 'r5c0de123';
    const OPEN = 'op-000000a0';
    const REPLY = { label: 'pass', reasoning: 'The diff adds the test the rubric asks for.' };
    let evidence: string;

    /** A runtime past init and an open with no view, as teamai opens a confined prompt's place, and its handle. */
    const opened = async (options: Line = {}, mode: 'attended' | 'unattended' = 'attended'): Promise<{ runtime: Connection; handle: string }> => {
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local', ...options } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, confinedPrompt: true });
      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a9e8d7c6', credentials: {} });
      const accepted = await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');
      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted' && !isNotice(line))).toMatchObject({ event: 'ready' });

      return { runtime, handle: z.string().parse(accepted['handle']) };
    };

    // As teamai-score's judge step renders it: it names the evidence directory and the schema in it by their paths.
    const judge = (handle: string, op: string) => ({
      type: 'prompt', op, handle, env: {}, unset: [], credentials: {}, cwd: evidence,
      lease: {
        step: 'judge', tool: 'claude', model: { name: 'claude-sonnet-5-5' }, permissions: 'approval-required', interactive: false, result: path.join(dir, 'attempt', 'result.json'),
        prompt: `Judge one piece of work against a scorer's rubric. Read only the files under ${evidence}:\nthe transcript, the diff, and evidence.json.\n\nReply with JSON that matches the schema in ${path.join(evidence, 'schema.json')}, and nothing else.`,
      },
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema: { type: 'object', required: ['label'] } },
    });

    /** How the op ended: its first line that neither accepts it nor shows its thread. */
    const ended = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && line['event'] !== 'display' && !isNotice(line), 20_000);

    beforeEach(() => {
      signIn(t3);
      evidence = path.join(dir, 'run', 'score', 'evidence');
      fs.mkdirSync(path.join(evidence, 'session'), { recursive: true });
      fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ skills: ['review'] }));
      fs.writeFileSync(path.join(evidence, 'diff.patch'), '+it("adds the cart test", () => {});\n');
      fs.writeFileSync(path.join(evidence, 'schema.json'), JSON.stringify({ type: 'object' }));
      fs.writeFileSync(path.join(evidence, 'session', 'transcript.jsonl'), '{"type":"user"}\n');
      t3.config({ agent: { reply: `\`\`\`json\n${JSON.stringify(REPLY)}\n\`\`\`` } });
    });

    it('judges in a fresh thread of its own on a read-only copy of the directory, and reports best-effort read access', async () => {
      const { runtime, handle } = await opened();
      const op = 'op-000000a1';

      runtime.send(judge(handle, op));

      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({
        op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: REPLY },
        confined: { level: 'best-effort', access: 'read' },
      });

      const [thread] = t3.threads();
      const launch = t3.calls().find((call) => call.tool === 't3_thread_launch')?.args;
      expect(launch).toMatchObject({ scratch: true, title: `judge · teamai ${RUN}`, runtimeMode: 'auto', clientRequestId: op, modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
      expect(launch).not.toHaveProperty('projectId');
      expect(launch).not.toHaveProperty('message');
      const copy = z.string().parse(thread?.worktreePath);
      expect(copy).not.toBe(evidence);
      expect(thread).toMatchObject({ sees: ['diff.patch', 'evidence.json', 'schema.json', 'session/transcript.jsonl'], couldWrite: false, status: 'completed', settled: false });
      expect(thread?.message).toContain(`Read only the files under ${copy}:`);
      expect(thread?.message).toContain(`the schema in ${path.join(copy, 'schema.json')}`);
      expect(thread?.message).not.toContain(evidence);
      // The prompt may describe a reply of another shape, as teamai-score's names the label's own schema file.
      expect(thread?.message).toContain(`Reply with one JSON value and no other text. teamai checks it against this JSON Schema, so it decides the reply's shape: ${JSON.stringify({ type: 'object', required: ['label'] })}. Where the prompt below asks for a reply of another shape, give that value where this schema places it.`);
    });

    // teamai names the directory in the prompt exactly as it sends confined.dir, a repository path with a space included.
    it('points each mention of the directory at the copy, and leaves a sibling that shares its name', async () => {
      const spaced = path.join(dir, 'my repo', 'score', 'evidence');
      fs.cpSync(evidence, spaced, { recursive: true });
      const { runtime, handle } = await opened();
      const request = judge(handle, 'op-000000a6');

      runtime.send({
        ...request, cwd: spaced, confined: { ...request.confined, dir: spaced },
        lease: { ...request.lease, prompt: `Read only the files under ${spaced}:\nReply with JSON that matches the schema in ${path.join(spaced, 'schema.json')}, and nothing else. Ignore ${spaced}-old and ${spaced}.bak.` },
      });

      expect(await ended(runtime, 'op-000000a6')).toMatchObject({ event: 'finished' });
      const [thread] = t3.threads();
      const copy = z.string().parse(thread?.worktreePath);
      expect(thread?.message).toContain(`Read only the files under ${copy}:`);
      expect(thread?.message).toContain(`the schema in ${path.join(copy, 'schema.json')},`);
      expect(thread?.message).toContain(`Ignore ${spaced}-old and ${spaced}.bak.`);
      expect(thread?.message).not.toContain(`under ${spaced}`);
    });

    it('runs the judge\'s thread in Auto, never in full access, when `runtime_mode` is full-access', async () => {
      const { runtime, handle } = await opened({ runtime_mode: 'full-access' });

      runtime.send(judge(handle, 'op-000000a3'));

      expect(await ended(runtime, 'op-000000a3')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('auto');
    });

    it('runs the judge\'s thread in the tighter `runtime_mode`', async () => {
      const { runtime, handle } = await opened({ runtime_mode: 'approval-required' });

      runtime.send(judge(handle, 'op-000000a2'));

      expect(await ended(runtime, 'op-000000a2')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('approval-required');
    });

    // teamai collects no judge's place, so its thread is settled when the place closes.
    it('removes the copy and settles the thread when teamai closes the judge\'s place', async () => {
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000a3'));
      expect(await ended(runtime, 'op-000000a3')).toMatchObject({ event: 'finished' });
      const copy = z.string().parse(t3.threads()[0]?.worktreePath);
      expect(fs.existsSync(copy)).toBe(true);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(fs.existsSync(copy)).toBe(false);
      expect(t3.threads()[0]?.settled).toBe(true);
      expect(fs.readdirSync(evidence).sort()).toEqual(['diff.patch', 'evidence.json', 'schema.json', 'session']);
    });

    it('keeps the judge\'s copy, its thread\'s folder, while T3 still runs a judge that failed, and removes it once close stopped the thread', async () => {
      t3.config({ agent: { waits: true }, interruptFails: true });
      const { runtime, handle } = await opened({}, 'unattended');
      runtime.send(judge(handle, 'op-000000a8'));
      expect(await ended(runtime, 'op-000000a8')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
      const copy = z.string().parse(t3.threads()[0]?.worktreePath);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
      expect(fs.existsSync(copy)).toBe(true);

      t3.config({ interruptFails: false });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(fs.existsSync(copy)).toBe(false);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // A close that comes while T3 launches the judge's thread waits for the launch, then stops what it started.
    it('stops a judge whose launch was still under way when teamai closed its place, and leaves no thread running', async () => {
      t3.config({ agent: { hold: true, reply: JSON.stringify(REPLY) }, launchMs: 3_000 });
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000a9'));
      await runtime.next((line) => line['op'] === 'op-000000a9' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle, 15_000)).toEqual({ event: 'closed', handle });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]?.status).not.toBe('running');
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
    }, 30_000);

    it('fails a judge whose reply is not JSON, naming its thread by its link', async () => {
      t3.config({ agent: { reply: 'I think it passes.' } });
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000a4'));

      expect(await ended(runtime, 'op-000000a4')).toEqual({
        op: 'op-000000a4', event: 'failed',
        failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(t3.threads()[0]?.threadId)} ("judge · teamai r5c0de123") replied with no JSON value.` },
      });
    });

    it('fails judge_copy_failed, naming the directory, when the directory cannot be copied, and briefs no thread', async () => {
      fs.chmodSync(path.join(evidence, 'diff.patch'), 0o000);
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000a7'));

      expect(await ended(runtime, 'op-000000a7')).toEqual({
        op: 'op-000000a7', event: 'failed',
        failure: { code: 'judge_copy_failed', message: expect.stringMatching(new RegExp(`^teamai could not copy ${evidence} into the judge thread's folder \\S+, so the judge did not start: .*EACCES`)) },
      });
      expect(t3.threads()[0]?.message).toBeUndefined();
    });

    it('neither copies nor briefs a judge whose place the person released while T3 launched its thread', async () => {
      t3.config({ launchMs: 12_000 });
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000b2'));
      await runtime.next((line) => line['op'] === 'op-000000b2' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle, release: true });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted' && !isNotice(line), 15_000)).toMatchObject({ event: 'close_failed', handle, failure: { code: 't3_unavailable' } });
      expect(await ended(runtime, 'op-000000b2')).toEqual({
        op: 'op-000000b2', event: 'failed',
        failure: { code: 'released', message: 'teamai released the place while T3 Code launched the judge thread, so it did not brief that thread, and the judge did not start.' },
      });
      expect(t3.threads()[0]?.message).toBeUndefined();
      expect(fs.readdirSync(z.string().parse(t3.threads()[0]?.worktreePath))).toEqual([]);
    }, 40_000);

    it('reconnects to the same judge after its own restart, and copies and briefs it only once', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, reply: JSON.stringify(REPLY) } });
      const first = await opened();
      first.runtime.send(judge(first.handle, 'op-000000a5'));
      await first.runtime.next((line) => line['op'] === 'op-000000a5' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send(judge(first.handle, 'op-000000a5'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-000000a5')).toMatchObject({ event: 'finished', result: { output: REPLY }, confined: { level: 'best-effort', access: 'read' } });
      expect(t3.threads()).toHaveLength(1);
      const briefs = t3.calls().filter((call) => call.tool === 't3_thread_send').map((call) => call.args['message']);
      expect(briefs).toEqual([t3.threads()[0]?.message]);
    });
  });
});

// A step's thread can delegate a task that runs its own session in the same folder, after the step's started.
describe('the session a step thread kept', () => {
  it('is the first one started in the folder since the launch, not a delegated task\'s later one', async () => {
    const toolHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-t3-sessions-')));
    const cwd = path.join(toolHome, 'worktree');
    const dir = path.join(toolHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const write = (sessionId: string, at: string): void => fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId, cwd, timestamp: at, uuid: `${sessionId}-u`, message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', sessionId, cwd, timestamp: at, uuid: `${sessionId}-a`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
    ].join('\n') + '\n');
    const launchedAt = Date.parse('2026-11-06T10:00:00.000Z');
    write('5ab0c71a-0000-4000-8000-000000000001', '2026-11-06T10:00:01.000Z');
    write('dd5bedbf-0000-4000-8000-000000000002', '2026-11-06T10:00:30.000Z');

    try {
      expect(await sessionSince({ driver: 'claudeAgent', toolHome, cwd, since: launchedAt })).toBe('5ab0c71a-0000-4000-8000-000000000001');
    } finally {
      fs.rmSync(toolHome, { recursive: true, force: true });
    }
  });
});
