import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaseNext } from '../workflow/engine.js';
import { claimOffered, publishRun, resumeRun } from '../workflow/handoff.js';
import { managedReport, resumeRefusal } from '../workflow/protocol.js';
import { readRun, RunIdSchema } from '../workflow/store.js';
import { BUILD, dirs, git, type Member, originFile, start, team } from './helpers/workflow-handoff-fixture.js';
import { sharedTeam, skillHarness } from './helpers/skill-harness.js';
import { AttemptIdSchema, type AttemptId, type RunId } from '../workflow/store.js';

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const MINUTE = 60_000;

/** Two members of one team whose business checkouts name a known origin, so a publish offers the run. */
async function pair(workflows?: Record<string, string>): Promise<{ acme: ReturnType<typeof team>; alice: Member; bob: Member }> {
  const acme = team(workflows);
  const alice = await acme.member('alice');
  const bob = await acme.member('bob');
  for (const { checkout } of [alice, bob]) git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
  return { acme, alice, bob };
}

function leaseOf(envelope: Awaited<ReturnType<typeof leaseNext>>): { step: string; attempt: string; revision: number } | undefined {
  if ('error' in envelope) return undefined;
  const lease = 'lease' in envelope.data ? envelope.data.lease : undefined;
  return lease && typeof lease === 'object' && 'step' in lease && 'attempt' in lease && 'revision' in lease
    ? { step: String(lease.step), attempt: String(lease.attempt), revision: Number(lease.revision) }
    : undefined;
}

function leased(envelope: Awaited<ReturnType<typeof leaseNext>>): string | undefined {
  return leaseOf(envelope)?.step;
}

function published(acme: ReturnType<typeof team>, runId: string): { owner: { user: string }; offered?: unknown; write: string } {
  return JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}');
}

/** Alice publishes her run, takes it back with `resume`, and leases its first step: she drives it now. */
async function aliceDrives(workflows?: Record<string, string>): Promise<{ acme: ReturnType<typeof team>; alice: Member; bob: Member; runId: string }> {
  const { acme, alice, bob } = await pair(workflows);
  const runId = await start(alice);
  expect(await publishRun(alice.config, runId, { checkout: alice.checkout, env: {} })).toMatchObject({ ok: true, value: { offered: true } });
  expect(await resumeRun(alice.config, runId, { claim: false, checkout: alice.checkout })).toMatchObject({ ok: true });
  expect(leased(await leaseNext(alice.config, runId, alice.driver))).toBe('one');
  return { acme, alice, bob, runId };
}

describe('a plain next on a run its owner offers', () => {
  it('leases nothing and leaves the offer up, so the runner that takes it is the only one that runs its steps', async () => {
    const { acme, alice, bob } = await pair();
    const runId = await start(alice);
    await publishRun(alice.config, runId, { checkout: alice.checkout, env: {} });

    const refused = await leaseNext(alice.config, runId, alice.driver);
    expect(refused).toMatchObject({ error: { code: 'run_offered' } });
    expect('error' in refused ? refused.error.message : '').toContain(`teamai workflow resume ${runId}`);
    expect(published(acme, runId).offered).toBeDefined();

    expect(await claimOffered(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(leased(await leaseNext(bob.config, runId, bob.driver))).toBe('one');
  });

  it('takes the offer back with "claim": true, and leases', async () => {
    const { acme, alice } = await pair();
    const runId = await start(alice);
    await publishRun(alice.config, runId, { checkout: alice.checkout, env: {} });

    expect(leased(await leaseNext(alice.config, runId, alice.driver, { claim: true }))).toBe('one');
    expect(published(acme, runId).offered).toBeUndefined();
  });
});

describe('taking over a run its owner drives', () => {
  it('asks the person, naming the owner and how to stop it, and takes nothing', async () => {
    const { acme, bob, runId } = await aliceDrives();
    const before = published(acme, runId).write;

    const asked = await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout });
    expect(asked).toMatchObject({ ok: false, error: { code: 'owner_active', owner: { user: 'alice' } } });
    const message = asked.ok ? '' : asked.error.message;
    expect(message).toContain('alice');
    expect(message).toContain(`teamai workflow publish ${runId}`);
    expect(message).toContain(`teamai workflow resume ${runId} --claim --confirmed`);
    expect(published(acme, runId)).toMatchObject({ owner: { user: 'alice' }, write: before });
  });

  it('refuses an unattended takeover, with or without the person, and names how to stop the owner', async () => {
    const { acme, bob, runId } = await aliceDrives();

    const refused = await resumeRun(bob.config, runId, { claim: true, checkout: bob.checkout, takeover: 'unattended' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'owner_active', owner: { user: 'alice' } } });
    const message = refused.ok ? '' : refused.error.message;
    expect(message).toContain(`teamai workflow publish ${runId}`);
    expect(message).not.toContain('--confirmed');
    expect(published(acme, runId).owner.user).toBe('alice');
  });

  it('asks about the owner before the run\'s invoke: ask does, so a yes to the invoke never takes a run its owner may still drive', async () => {
    const { bob, runId } = await aliceDrives({ build: BUILD.replace('steps:', 'invoke: ask\nsteps:') });
    const session = { evidence: { kind: 'session', variable: 'CLAUDE_CODE_SESSION_ID' }, confirmed: false, mode: 'attended' } as const;

    expect(await resumeRefusal(bob.config, RunIdSchema.parse(runId), session, { published: true, claim: true })).toMatchObject({ code: 'owner_active' });
  });

  it('refuses a driver\'s "claim": true, which cannot carry the person\'s yes', async () => {
    const { bob, runId } = await aliceDrives();

    expect(await leaseNext(bob.config, runId, bob.driver, { claim: true })).toMatchObject({ error: { code: 'owner_active' } });
  });

  it('takes it once the person confirms, and the owner leases nothing more once it reads origin again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { alice, bob, runId } = await aliceDrives();

    expect(await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout, takeover: 'confirmed' })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(leased(await leaseNext(bob.config, runId, bob.driver))).toBe('one');

    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({ error: { code: 'not_owner', owner: { user: 'bob' } } });
  });

  it('records nothing the owner reports once another install took the run over, though it read origin a moment ago, and stops its driver', async () => {
    const { alice, bob } = await pair();
    const runId = await start(alice);
    await publishRun(alice.config, runId, { checkout: alice.checkout, env: {} });
    await resumeRun(alice.config, runId, { claim: false, checkout: alice.checkout });
    const lease = leaseOf(await leaseNext(alice.config, runId, alice.driver));
    expect(lease?.step).toBe('one');
    expect(await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout, takeover: 'confirmed' })).toMatchObject({ ok: true });

    const report = { attempt: lease?.attempt ?? '', revision: lease?.revision ?? 0, outcome: 'success' as const, driver: alice.driver };
    expect(await managedReport({ config: alice.config, runId, report, secrets: {}, lock: undefined })).toMatchObject({ error: { code: 'not_owner', owner: { user: 'bob' } } });
    const kept = await readRun(alice.config, runId);
    expect(kept !== 'missing' && kept !== 'corrupt' ? kept.steps.find((step) => step.id === 'one')?.status : kept).toBe('leased');
  });

  it('takes it without asking once the owner has not written to teamai-reports for the stale window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { bob, runId } = await aliceDrives();

    vi.setSystemTime(Date.now() + 61 * MINUTE);
    expect(await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
  });

  it('keeps asking while the owner leases: each lease past the renewal age writes again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { acme, alice, bob, runId } = await aliceDrives();
    const first = published(acme, runId).write;

    vi.setSystemTime(Date.now() + 21 * MINUTE);
    await leaseNext(alice.config, runId, alice.driver);
    const renewed = published(acme, runId);
    expect(renewed.write).not.toBe(first);
    expect(renewed.owner.user).toBe('alice');

    vi.setSystemTime(Date.now() + 45 * MINUTE);
    expect(await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'owner_active' } });
  });
});

const PROMPTED = `schemaVersion: v1alpha1
name: prompted
description: One prompt step.
steps:
  - id: write
    prompt: Write it.
`;

/** Alice's skill session drives her published run of `prompted`: its prompt step is dispatched to her child agent. */
async function aliceDispatched(): Promise<{ made: Awaited<ReturnType<typeof skillHarness>>; run: RunId; attempt: AttemptId; written: () => string; bob: () => ReturnType<ReturnType<typeof sharedTeam>['install']> }> {
  const shared = sharedTeam({ prompted: PROMPTED });
  const install = await shared.install('alice');
  const made = await skillHarness({}, { install });
  dirs.push(made.root);
  const started = await made.call({ kind: 'start', name: 'prompted', answers: { confirmed: false }, inputs: undefined });
  if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
  const { run } = started.data.turn;
  expect(await publishRun(install.config, run, { checkout: install.checkout, env: {} })).toMatchObject({ ok: true });
  expect(await resumeRun(install.config, run, { claim: false, checkout: install.checkout })).toMatchObject({ ok: true });
  await made.call({ kind: 'choose', run, choice: 'h1' });
  let attempt: string | undefined;
  for (let poll = 0; poll < 10 && attempt === undefined; poll += 1) {
    const answer = await made.call({ kind: 'next', run, wait: false });
    const turn = 'data' in answer && 'turn' in answer.data ? answer.data.turn : undefined;
    attempt = turn?.actions.flatMap((action) => (action.kind === 'dispatch' ? [action.attempt] : []))[0];
  }
  if (attempt === undefined) throw new Error('no dispatch came up');
  const dispatched = AttemptIdSchema.parse(attempt);
  await made.call({ kind: 'ack', run, attempt: dispatched });
  const written = (): string => JSON.parse(execFileSync('git', ['--git-dir', install.config.repo.remote, 'show', `teamai-reports:workflows/runs/${run}/state.json`], { encoding: 'utf8' })).write;
  return { made, run, attempt: dispatched, written, bob: () => shared.install('bob') };
}

describe('the skill driver keeps a run it drives', () => {
  it('writes the run again while its child works a prompt step past the renewal age, though the session calls nothing', async () => {
    const { made, written } = await aliceDispatched();
    const before = written();

    // Only the runners move: a sleep moves the clock and wakes them, and a runner then waits at the run lock until the next.
    await made.context.runners.sleep(21 * MINUTE);
    await made.context.runners.sleep(MINUTE);

    expect(written()).not.toBe(before);
  });

  it('stops checking the run once its session has called nothing for the stale window, so a session that ended holds the run no longer', async () => {
    const { made, run, attempt } = await aliceDispatched();

    await made.context.runners.sleep(59 * MINUTE);
    await made.context.runners.sleep(MINUTE / 2);
    expect(await made.context.runners.alive(run, attempt)).toBe(true);

    await made.context.runners.sleep(MINUTE);
    await made.context.runners.sleep(MINUTE);
    expect(await made.context.runners.alive(run, attempt)).toBe(false);
  });

  it('stops checking the run once another install took it over, and leaves the run to it', async () => {
    const { made, run, attempt, bob } = await aliceDispatched();
    const taker = await bob();
    expect(await resumeRun(taker.config, run, { claim: false, checkout: taker.checkout, takeover: 'confirmed' })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await made.context.runners.alive(run, attempt)).toBe(true);

    // A sleep wakes the runner, which then waits at the run lock until the next.
    await made.context.runners.sleep(2 * MINUTE);
    await made.context.runners.sleep(MINUTE);

    expect(await made.context.runners.alive(run, attempt)).toBe(false);
  });
});
