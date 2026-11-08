import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseNext } from '../workflow/engine.js';
import { claimOffered, publishRun } from '../workflow/handoff.js';
import { dirs, git, type Member, originFile, start, team } from './helpers/workflow-handoff-fixture.js';

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Two members of one team whose business checkouts name a known origin, so a publish offers the run. */
async function pair(): Promise<{ acme: ReturnType<typeof team>; alice: Member; bob: Member }> {
  const acme = team();
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
