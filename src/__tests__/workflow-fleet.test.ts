import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseNext } from '../workflow/engine.js';
import { claimAttempt, expireClaim, finishAttempt, lastGoneWork, listOffers, markOffered, offerAttempt, readAttemptRecord, recordProgress } from '../workflow/fleet.js';
import { publishRun } from '../workflow/handoff.js';
import { AttemptIdSchema, installOwner, RunIdSchema, takeRunLock } from '../workflow/store.js';
import { takeFleetAttempt } from '../workflow/drivers/local/fleet-member.js';
import { readableReportsWorktree } from '../utils/reports-branch.js';
import { dirs, start, team, type Member } from './helpers/workflow-handoff-fixture.js';

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RUN = RunIdSchema.parse('r0123abcd');
const ATTEMPT = AttemptIdSchema.parse('a0123abcd');
const LEASE: { step: string; command: string; env: Record<string, string> } = { step: 'build', command: 'npm run build', env: { MODE: 'ci' } };

async function offer(owner: Member, input: { secrets?: Record<string, string>; lease?: typeof LEASE; start?: string } = {}) {
  return offerAttempt(owner.config, {
    run: RUN, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(owner.config),
    start: input.start ?? 'f'.repeat(40), staleAfterMs: 60_000, lease: input.lease ?? LEASE, secrets: input.secrets ?? {},
  });
}

describe('fleet attempts on teamai-reports', () => {
  it('lets one of two members claim an offer, and tells the other the attempt moved', async () => {
    const acme = team();
    const [alice, bob, carol] = [await acme.member('alice'), await acme.member('bob'), await acme.member('carol')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);

    const [first, second] = [await claimAttempt(bob.config, offered.value, await installOwner(bob.config)), await claimAttempt(carol.config, offered.value, await installOwner(carol.config))];

    expect(first).toMatchObject({ ok: true, value: { state: 'claimed', member: { user: 'bob' } } });
    expect(second).toMatchObject({ ok: false, error: { code: 'state_moved' } });
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'claimed', member: { user: 'bob' } } });
  });

  it('lists only the offers of the pool and repository asked for, and no claimed one', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);

    expect(await listOffers(bob.config, { pool: 'default', repository: 'github.com/acme/business' })).toMatchObject([{ attempt: ATTEMPT }]);
    expect(await listOffers(bob.config, { pool: 'gpu', repository: 'github.com/acme/business' })).toEqual([]);
    expect(await listOffers(bob.config, { pool: 'default', repository: 'github.com/acme/other' })).toEqual([]);
  });

  it('keeps a member that went quiet from writing once the owner gave its claim up', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);

    expect(await expireClaim(alice.config, claimed.value)).toMatchObject({ ok: true, value: { state: 'expired' } });
    expect(await recordProgress(bob.config, claimed.value, 'e'.repeat(40))).toMatchObject({ ok: false, error: { code: 'state_moved' } });
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'expired', pushed: 'f'.repeat(40) } });
  });

  it('keeps a finished step\'s result when its stderr names a path of the member\'s machine, and leaves that stderr out', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);

    await finishAttempt(bob.config, claimed.value, { exitCode: 0, stderr: 'warning: cache at /home/bob/.cache/build is stale', to: 'e'.repeat(40), outputs: { built: true } }, {});

    const finished = await readAttemptRecord(alice.config, RUN, ATTEMPT);
    expect(finished).toMatchObject({ ok: true, value: { state: 'finished', result: { exitCode: 0, to: 'e'.repeat(40), outputs: { built: true } } } });
    expect(JSON.stringify(finished)).not.toContain('/home/bob');
  });

  it('leaves an offer for another member while this machine already drives its run', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);
    const member = await installOwner(bob.config);

    const taken = await takeRunLock(bob.config, RUN, async () => takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member, secrets: {} }), { waitMs: 0 });

    expect(taken).toMatchObject({ kind: 'held', value: { data: { idle: { offered: 1 } } } });
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'offered' } });
  });

  it('goes on from no gone work of an attempt another install offered', async () => {
    const acme = team();
    const [alice, bob, carol] = [await acme.member('alice'), await acme.member('bob'), await acme.member('carol')];
    const offered = await offer(carol);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    await recordProgress(bob.config, claimed.value, 'e'.repeat(40)).then(async (progressed) => progressed.ok && expireClaim(carol.config, progressed.value));
    await readableReportsWorktree(alice.config);

    expect(await lastGoneWork(alice.config, { run: RUN, step: 'build', owner: await installOwner(alice.config) })).toBeUndefined();
    expect(await lastGoneWork(alice.config, { run: RUN, step: 'build', owner: await installOwner(carol.config) })).toEqual({ attempt: ATTEMPT, pushed: 'e'.repeat(40) });
  });

  it('reads no record whose start is a name git would resolve rather than a commit id', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    await offer(alice, { start: 'stash@{0}' });

    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toMatchObject({ ok: false, error: { code: 'fleet_record_unreadable' } });
  });

  it('offers a command that names absolute paths, as shell commands do', async () => {
    const acme = team();
    const alice = await acme.member('alice');

    expect(await offer(alice, { lease: { ...LEASE, command: 'npm test 2>/dev/null && cp out /tmp/out' } })).toMatchObject({ ok: true, value: { state: 'offered' } });
  });

  it('offers no lease that carries a secret of the owner, and writes nothing', async () => {
    const acme = team();
    const alice = await acme.member('alice');

    const refused = await offer(alice, { lease: { ...LEASE, env: { TOKEN: 'swordfish-value-1234' } }, secrets: { TOKEN: 'swordfish-value-1234' } });

    expect(refused).toMatchObject({ ok: false, error: { code: 'fleet_unpublishable' } });
    expect(refused.ok ? '' : refused.error.message).not.toContain('swordfish');
    expect(await readAttemptRecord(alice.config, RUN, ATTEMPT)).toEqual({ ok: true, value: 'absent' });
  });
});

describe('publishing a run with an attempt out on a fleet pool', () => {
  it('is refused, naming the step, the pool and the command that waits for it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const next = await leaseNext(alice.config, runId, alice.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const { attempt, step } = next.data.lease as { attempt: string; step: string };
    await markOffered(alice.config, RunIdSchema.parse(runId), AttemptIdSchema.parse(attempt), 'build');

    const refused = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect(refused).toMatchObject({ ok: false, error: { code: 'fleet_attempts_out', step } });
    expect(refused.ok ? '' : refused.error.message).toContain(`fleet pool build`);
    expect(refused.ok ? '' : refused.error.message).toContain(`teamai workflow resume ${runId}`);
  });
});
