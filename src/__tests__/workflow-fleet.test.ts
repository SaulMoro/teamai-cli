import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaseNext, startRun } from '../workflow/engine.js';
import { answerCancel, cancelAttempt, claimAttempt, expireClaim, finishAttempt, lastGoneWork, leaseEnv, leaseValues, listOffers, listOpenAttempts, markOffered, offerAttempt, readAttemptRecord, recordProgress } from '../workflow/fleet/record.js';
import { startGroupedCommand } from '../tool-launch/process-stop.js';
import { publishRun } from '../workflow/handoff.js';
import { definitionHash } from '../workflow/snapshot.js';
import { attemptDir, AttemptIdSchema, installOwner, readRun, RunIdSchema, takeRunLock } from '../workflow/store.js';
import { memberPlace, takeFleetAttempt, type MemberPlace } from '../workflow/fleet/member.js';
import type { OpenedDriver, OpenedRuntime } from '../workflow/runtimes/sources.js';
import { fleetStepRuntime, shadowedFleetEntries } from '../workflow/fleet/owner.js';
import { RuntimeOptionsSchema } from '@teamai/runtime-protocol';
import { localStepRuntime } from '../workflow/runtimes/local.js';
import { newOpId, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
import { attemptRuntimePath } from '../workflow/runtimes/attempt.js';
import { readableReportsWorktree, updateReports } from '../utils/reports-branch.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { dirs, git, start, team, type Member } from './helpers/workflow-handoff-fixture.js';
import { fakeAgent, type FakeAgent } from '@teamai/tool-testing/fake-agent';
import { claudeFake } from '@teamai/tool-claude/testing';
import os from 'node:os';
import { openSessionArchive } from '../session-flow/archive.js';
import { log } from '../utils/logger.js';

/** A member that runs every step here, as `--driver local` does. */
const HERE: MemberPlace = { command: { kind: 'here' }, prompt: { kind: 'here' } };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RUN = RunIdSchema.parse('r0123abcd');
const ATTEMPT = AttemptIdSchema.parse('a0123abcd');
const LEASE: { kind: 'command'; step: string; command: string; env: Record<string, string> } = { kind: 'command', step: 'build', command: 'npm run build', env: { MODE: 'ci' } };

async function offer(owner: Member, input: { secrets?: Record<string, string>; lease?: typeof LEASE; start?: string } = {}) {
  return offerAttempt(owner.config, {
    run: RUN, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(owner.config),
    start: input.start ?? 'f'.repeat(40), staleAfterMs: 60_000, lease: input.lease ?? LEASE, secrets: input.secrets ?? {},
    definition: { name: 'build', sourceHash: 'a'.repeat(64), definitionHash: 'b'.repeat(64) }, values: {},
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

  it('reads a record a newer teamai wrote in a format of its own as one to upgrade for, and offers it to no member here', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, version: 3, teamai: '9.1.0', shape: 'new' }));

      return { value: undefined, write: { files: [rel], message: 'a newer record' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toEqual({ ok: false, error: {
      code: 'fleet_record_newer',
      message: `The record of attempt ${ATTEMPT} of run ${RUN} on teamai-reports was written by teamai 9.1.0, in a format this teamai cannot read. Upgrade teamai to 9.1.0 or later.`,
    } });
    expect(await listOffers(bob.config, { pool: 'default', repository: 'github.com/acme/business' })).toEqual([]);
  });

  it('writes the teamai version that wrote a record into it', async () => {
    const acme = team();
    const offered = await offer(await acme.member('alice'));

    expect(offered).toMatchObject({ ok: true, value: { version: 2, teamai: expect.stringMatching(/^\d+\.\d+\.\d+/) } });
  });

  it('names the kind of step a lease runs, and reads no lease whose kind its fields do not match', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);
    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: true, value: { lease: { kind: 'command', step: 'build', command: 'npm run build' } } });
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, lease: { ...offered.value.lease, kind: 'prompt' } }));

      return { value: undefined, write: { files: [rel], message: 'a lease of another kind' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: false, error: { code: 'fleet_record_unreadable' } });
  });

  it('reads no record that holds a field its format does not name, rather than reading it without that field', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, lease: { ...offered.value.lease, workflow: true } }));

      return { value: undefined, write: { files: [rel], message: 'a record with a field of its own' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toMatchObject({ ok: false, error: { code: 'fleet_record_unreadable' } });
    expect(await listOffers(bob.config, { pool: 'default', repository: 'github.com/acme/business' })).toEqual([]);
  });

  it('reads a record an older teamai wrote in the format before this one as one its writer upgrades for', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const rel = `workflows/attempts/${RUN}/${ATTEMPT}.json`;
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, rel), JSON.stringify({ ...offered.value, version: 1, teamai: '0.21.0' }));

      return { value: undefined, write: { files: [rel], message: 'an older record' } };
    });
    await readableReportsWorktree(bob.config);

    expect(await readAttemptRecord(bob.config, RUN, ATTEMPT)).toEqual({ ok: false, error: {
      code: 'fleet_record_unreadable',
      message: `The record of attempt ${ATTEMPT} of run ${RUN} on teamai-reports was written by teamai 0.21.0, in an older format this teamai does not read. Upgrade teamai on the install that offered it.`,
    } });
    expect(await listOffers(bob.config, { pool: 'default', repository: 'github.com/acme/business' })).toEqual([]);
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

  it('keeps a prompt step\'s failure code and usage when its message names a path of the member\'s machine, and leaves that message out', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);

    await finishAttempt(bob.config, claimed.value, { exitCode: 1, stderr: '', tool: 'claude', tokens: { input: 10, output: 2 }, failure: { code: 'tool_failed', message: 'claude could not read /home/bob/.claude/settings.json' } }, {});

    const finished = await readAttemptRecord(alice.config, RUN, ATTEMPT);
    expect(finished).toMatchObject({ ok: true, value: { state: 'finished', result: { exitCode: 1, tool: 'claude', tokens: { input: 10, output: 2 }, failure: { code: 'tool_failed' } } } });
    expect(JSON.stringify(finished)).not.toContain('/home/bob');
  });

  it('lists the attempts out for a business repository, with who claimed each and when it last wrote, and none that ended', async () => {
    const acme = team();
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const offered = await offer(alice);
    if (!offered.ok) throw new Error(offered.error.message);
    const claimed = await claimAttempt(bob.config, offered.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    await readableReportsWorktree(alice.config);

    expect(await listOpenAttempts(alice.config, 'github.com/acme/business')).toEqual([
      expect.objectContaining({ run: RUN, attempt: ATTEMPT, state: 'claimed', pool: 'default', lease: expect.objectContaining({ step: 'build' }), member: expect.objectContaining({ user: 'bob' }), claimedAt: expect.any(String), progressAt: expect.any(String) }),
    ]);
    expect(await listOpenAttempts(alice.config, 'github.com/acme/other')).toEqual([]);

    await finishAttempt(bob.config, claimed.value, { exitCode: 0, stderr: '' }, {});
    await readableReportsWorktree(alice.config);

    expect(await listOpenAttempts(alice.config, 'github.com/acme/business')).toEqual([]);
  });

  it('leaves an offer for another member while this machine already drives its run', async () => {
    const acme = team({ mark: MARK });
    const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
    const started = await startRun(alice.config, 'mark', { mark: 'made.txt' }, { secrets: {} });
    if (!('data' in started)) throw new Error(started.error.message);
    const run = RunIdSchema.parse(String(started.data.run));
    const state = await readRun(alice.config, run);
    if (state === 'missing' || state === 'corrupt') throw new Error(`run ${run} is ${state}`);
    const offered = await offerAttempt(alice.config, {
      run, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(alice.config), start: git(alice.checkout, 'rev-parse', 'HEAD'), staleAfterMs: 60_000, secrets: {},
      lease: { kind: 'command', step: 'write', command: 'echo written > "$MARK"', env: { MARK: 'made.txt' } },
      definition: { name: state.name, sourceHash: state.sourceHash, definitionHash: definitionHash(state.definition, state.workflows), teamRevision: state.teamRevision, origin: state.origin },
      values: { inputs: { mark: 'made.txt' } },
    });
    if (!offered.ok) throw new Error(offered.error.message);
    await readableReportsWorktree(bob.config);
    const member = await installOwner(bob.config);

    const taken = await takeRunLock(bob.config, run, async () => takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member, secrets: {}, place: HERE }), { waitMs: 0 });

    expect(taken).toMatchObject({ kind: 'held', value: { data: { idle: { offered: 1 } } } });
    expect(await readAttemptRecord(alice.config, run, ATTEMPT)).toMatchObject({ ok: true, value: { state: 'offered' } });
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

/** A command whose env reads an input: the member renders the env from the input's value, with its own copy of the step. */
const MARK = `schemaVersion: v1alpha1
name: mark
description: Writes the file an input names.
inputs: { mark: string }
steps:
  - id: write
    workspace: new
    env:
      MARK: "{{ inputs.mark }}"
    command: echo written > "$MARK"
`;

/**
 * Alice starts workflow `mark` and offers its step with `forge` applied to the offer; Bob, with the team's workflows,
 * takes it. Answers what Bob's take answered, and the record Alice reads then.
 */
async function takeForged(forge: (forged: Pick<Parameters<typeof offerAttempt>[1], 'lease' | 'definition' | 'values'>) => void, before?: (members: { alice: Member; bob: Member }) => Promise<void>, workflow = MARK, place: MemberPlace = HERE, inputs: Record<string, string> = {}) {
  const acme = team({ mark: workflow });
  const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
  await before?.({ alice, bob });
  const started = await startRun(alice.config, 'mark', { mark: 'made.txt', ...inputs }, { secrets: {} });
  if (!('data' in started)) throw new Error(started.error.message);
  const run = RunIdSchema.parse(String(started.data.run));
  const state = await readRun(alice.config, run);
  if (state === 'missing' || state === 'corrupt') throw new Error(`run ${run} is ${state}`);
  const startCommit = git(alice.checkout, 'rev-parse', 'HEAD');
  git(alice.checkout, 'push', '-q', 'origin', `HEAD:refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
  const forged: Pick<Parameters<typeof offerAttempt>[1], 'lease' | 'definition' | 'values'> = {
    lease: { kind: 'command', step: 'write', command: 'echo written > "$MARK"', env: { MARK: 'made.txt' } },
    definition: { name: state.name, sourceHash: state.sourceHash, definitionHash: definitionHash(state.definition, state.workflows), teamRevision: state.teamRevision, origin: state.origin },
    values: { inputs: { mark: 'made.txt' } },
  };
  forge(forged);
  const offered = await offerAttempt(alice.config, {
    run, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(alice.config),
    start: startCommit, staleAfterMs: 60_000, secrets: {}, ...forged,
  });
  if (!offered.ok) throw new Error(offered.error.message);
  await readableReportsWorktree(bob.config);

  const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place });
  const record = await readAttemptRecord(alice.config, run, ATTEMPT);

  return { taken, record: record.ok && record.value !== 'absent' ? record.value : undefined, alice, bob };
}

/** A prompt step whose prompt reads an input: the member renders it from the input's value, with its own copy of the step. */
const PROMPTED = `schemaVersion: v1alpha1
name: mark
description: Asks for the file an input names.
inputs: { mark: string }
steps:
  - id: write
    workspace: new
    prompt: "Write {{ inputs.mark }}."
    output:
      ok: boolean
`;

describe('a member taking a prompt attempt', () => {
  const agents: FakeAgent[] = [];

  afterEach(() => {
    const left = agents.splice(0).flatMap((agent) => agent.stopLeft());
    vi.unstubAllEnvs();
    expect(left, 'fake agents left running').toEqual([]);
  });

  /** Claude as its recorded call prints it, on PATH, answering `answer`; the member's default tool is Claude. */
  function claudeOnPath(answer: string, before?: string): FakeAgent {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-'));
    dirs.push(root);
    vi.stubEnv('HOME', path.join(root, 'home'));
    const agent = fakeAgent(claudeFake, { bin: path.join(root, 'bin'), answer, ...(before !== undefined && { before }) });
    vi.stubEnv('PATH', `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
    agents.push(agent);

    return agent;
  }

  const useClaude = async ({ bob }: { bob: Member }): Promise<void> => {
    bob.config.workflows = { tools: { default: 'claude' } };
  };

  it('runs the prompt the team\'s workflow defines for the step with its own tool, rendered from the offer\'s values, and writes what the tool answered', async () => {
    const claude = claudeOnPath('{"ok":true}');

    const { taken, record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, useClaude, PROMPTED);

    expect(claude.calls()).toEqual([expect.objectContaining({ args: expect.arrayContaining([expect.stringContaining('Write made.txt.')]), cwd: expect.stringMatching(/work$/) })]);
    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0, outputs: { ok: true }, tool: 'claude' } });
  });

  it('runs on the tool\'s own default model when the step\'s model renders empty, as the owner\'s driver would, not on the defaults\' model', async () => {
    const claude = claudeOnPath('{"ok":true}');
    const modelled = PROMPTED.replace('inputs: { mark: string }', 'inputs: { mark: string, model: string }\ndefaults: { model: opus }').replace('    prompt: "Write', '    model: "{{ inputs.model }}"\n    prompt: "Write');

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
      forged.values = { inputs: { mark: 'made.txt', model: '' } };
    }, useClaude, modelled, HERE, { model: '' });

    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0 } });
    expect(claude.calls()).toHaveLength(1);
    expect(claude.calls()[0]?.args).not.toContain('--model');
  });

  it('archives the session its tool ran, so the owner continues it from the team session archive', async () => {
    claudeOnPath('{"ok":true}');

    const { record, alice } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, useClaude, PROMPTED);

    const session = record?.state === 'finished' ? record.result.session : undefined;
    expect(session).toEqual(expect.any(String));
    await readableReportsWorktree(alice.config);
    const archive = openSessionArchive(alice.config);
    const restored = await archive.restore({ platform: 'claude-code', sessionId: session ?? '' }, { platform: 'claude-code', cwd: alice.checkout });
    await archive.close();
    expect(restored).toEqual({ status: 'restored', sessionId: expect.any(String) });
  });

  it('archives the session from the Claude root the member\'s checkout records, though the step ran in a clone of it', async () => {
    claudeOnPath('{"ok":true}');
    // A relocated root teamai records is one under the member's home.
    const relocated = path.join(process.env.HOME ?? '', '.claude-relocated');
    fs.mkdirSync(relocated, { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', relocated);

    const { record, alice } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, async (members) => {
      await useClaude(members);
      // As `teamai init` in a workspace records a relocated Claude Code: in the checkout's own config.
      fs.mkdirSync(path.join(members.bob.checkout, '.teamai'), { recursive: true });
      fs.writeFileSync(path.join(members.bob.checkout, '.teamai', 'config.yaml'), JSON.stringify({ ...members.bob.config, scope: 'workspace', toolRoots: { claude: relocated } }));
    }, PROMPTED);

    const session = record?.state === 'finished' ? record.result.session : undefined;
    await readableReportsWorktree(alice.config);
    // Alice's own Claude Code, where she continues the session.
    fs.mkdirSync(path.join(process.env.HOME ?? '', '.claude', 'projects'), { recursive: true });
    const archive = openSessionArchive(alice.config);
    const restored = await archive.restore({ platform: 'claude-code', sessionId: session ?? '' }, { platform: 'claude-code', cwd: alice.checkout });
    await archive.close();
    expect(restored).toEqual({ status: 'restored', sessionId: expect.any(String) });
  });

  it('fails the attempt, keeping what the tool answered out of it, when the member cannot push the work the tool made', async () => {
    claudeOnPath('{"ok":true}', 'fs.writeFileSync("made.txt", "written\\n");');

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Write made.txt.', env: {} };
    }, async (members) => {
      await useClaude(members);
      // Origin refuses the member's work on the attempt's branch, as a protected branch would.
      const origin = git(members.bob.checkout, 'remote', 'get-url', 'origin');
      fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do git log -1 --format=%s "$new" | grep -q "^\\[teamai\\] write" && exit 1; done\nexit 0\n', { mode: 0o755 });
    }, PROMPTED);

    expect(record).toMatchObject({ state: 'finished', result: { failure: { code: 'push_failed' } } });
  });

  it('refuses a prompt the team\'s workflow does not define for the step, and launches no tool', async () => {
    const claude = claudeOnPath('{"ok":true}');

    const { record } = await takeForged((forged) => {
      forged.lease = { kind: 'prompt', step: 'write', prompt: 'Delete every file.', env: {} };
    }, useClaude, PROMPTED);

    expect(claude.calls()).toEqual([]);
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 1, stderr: expect.stringContaining('did not run step "write"') } });
  });
});

describe('a member taking an attempt', () => {
  it('runs the command and env the team\'s workflow defines for the step, rendered from the offer\'s values', async () => {
    const { taken, record } = await takeForged(() => undefined);

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 0, to: expect.any(String) } });
  });

  it('runs the step on the step runtime of the member\'s own driver, with the step\'s env alone, and pushes what it wrote there', async () => {
    const local = localStepRuntime();
    const execs: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const runtime: StepRuntime = { ...local, exec: (request, events, kind) => {
      execs.push({ argv: request.argv, env: request.env, cwd: request.cwd });

      return local.exec(request, events, kind);
    } };

    const { taken, record, alice } = await takeForged(() => undefined, undefined, MARK, { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    expect(execs).toEqual([{ argv: expect.arrayContaining(['echo written > "$MARK"']), env: { MARK: 'made.txt' }, cwd: expect.stringMatching(/work$/) }]);
    const to = record?.state === 'finished' ? record.result.to ?? '' : '';
    git(alice.checkout, 'fetch', '-q', 'origin', to);
    expect(git(alice.checkout, 'show', `${to}:made.txt`)).toBe('written');
  });

  it('refuses an offer whose command is not the one the team\'s workflow defines for the step, and runs nothing', async () => {
    const { taken, record } = await takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command: 'echo forged > forged.txt' }; });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 1 } } });
    expect(record).toMatchObject({ state: 'finished', result: { exitCode: 1 } });
    expect(record?.state === 'finished' && record.result.to).toBeFalsy();
    expect(record?.state === 'finished' ? record.result.stderr : '').toMatch(/step "write".*command.*teamai pull/s);
  });

  it('leaves an offer whose definition hash is not the one of the team\'s workflow for another member, and runs nothing', async () => {
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { taken, record } = await takeForged((forged) => { forged.definition.definitionHash = 'f'.repeat(64); });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(record).toMatchObject({ state: 'offered' });
    expect(infos).toHaveBeenCalledWith(expect.stringMatching(/^Left attempt .* for another member: it finds no definition of the run here: Run .* runs workflow "mark"/s));
  });
  it('leaves an offer whose workflow comes from a team commit only a branch besides the default one holds, and runs nothing', async () => {
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    // Anyone who can write the record can push such a branch, teamai-reports among them.
    const { taken, record, bob } = await takeForged((forged) => { forged.lease = { ...forged.lease, kind: 'command', command: 'echo forged > forged.txt' }; }, async ({ alice: { config } }) => {
      const clone = config.repo.localPath;
      git(clone, 'checkout', '-q', '-b', 'side');
      fs.writeFileSync(path.join(clone, 'workflows', 'mark.yaml'), MARK.replace('echo written > "$MARK"', 'echo forged > forged.txt'));
      git(clone, 'commit', '-qam', 'side');
      git(clone, 'push', '-q', 'origin', 'side');
      await syncScorersThenWorkflows(config);
    });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(record).toMatchObject({ state: 'offered' });
    expect(fs.existsSync(path.join(bob.checkout, 'forged.txt'))).toBe(false);
    expect(infos).toHaveBeenCalledWith(expect.stringMatching(/^Left attempt .* for another member: it finds no definition of the run here: .*Merge it to the default branch/s));
  });
  it('pushes the work to every push URL its checkout names for origin, as git push origin does', async () => {
    const mirrors: string[] = [];
    const { taken, record } = await takeForged(() => undefined, async ({ bob }) => {
      const origin = git(bob.checkout, 'remote', 'get-url', 'origin');
      const mirror = path.join(path.dirname(origin), 'mirror.git');
      git(path.dirname(origin), 'init', '-q', '--bare', mirror);
      mirrors.push(origin, mirror);
      git(bob.checkout, 'config', 'remote.origin.pushurl', origin);
      git(bob.checkout, 'config', '--add', 'remote.origin.pushurl', mirror);
      // git push origin applies no pushInsteadOf to a push URL the remote names.
      git(bob.checkout, 'config', `url.${path.join(path.dirname(origin), 'nowhere.git')}.pushInsteadOf`, origin);
    });

    expect(taken).toMatchObject({ data: { ran: { step: 'write', exit_code: 0 } } });
    const to = record?.state === 'finished' ? record.result.to : undefined;
    expect(to).toEqual(expect.any(String));
    for (const remote of mirrors) expect(git(remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/teamai/attempts')).toBe(to);
  });

  it('refuses a step of a workflow a from step admitted, naming that step, and runs nothing', async () => {
    const planned = `schemaVersion: v1alpha1
name: mark
description: Runs the workflow a step writes.
inputs: { mark: string }
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow }
  - id: run
    needs: [plan]
    workflow: { from: plan }
`;
    const { taken, record } = await takeForged((forged) => { forged.lease.step = 'run.write'; }, undefined, planned);

    expect(taken).toMatchObject({ data: { ran: { step: 'run.write', exit_code: 1 } } });
    expect(record?.state === 'finished' && record.result.to).toBeFalsy();
    expect(record?.state === 'finished' ? record.result.stderr : '').toContain('step "run" runs the workflow step "plan" wrote');
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

/** A command that marks that it started, then runs until it is stopped, writing work as it goes. */
const SLOW = `schemaVersion: v1alpha1
name: slow
description: Works until stopped.
steps:
  - id: work
    workspace: new
    command: echo begun > begun.txt; sleep 60
`;

/** A command that goes on from what the attempt's ref holds: it fails unless the work an earlier run left is there. */
const AGAIN = `schemaVersion: v1alpha1
name: slow
description: Goes on from earlier work.
steps:
  - id: work
    workspace: new
    command: test -f left.txt && echo again > again.txt
`;

/**
 * Alice starts workflow `slow`, defined as `definition` with command `command`, and offers its step with `staleAfterMs`;
 * answers both members, the run and the offer.
 */
async function offerSlow(staleAfterMs: number, { definition = SLOW, command = 'echo begun > begun.txt; sleep 60' } = {}) {
  const acme = team({ slow: definition });
  const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
  const started = await startRun(alice.config, 'slow', {}, { secrets: {} });
  if (!('data' in started)) throw new Error(started.error.message);
  const run = RunIdSchema.parse(String(started.data.run));
  const state = await readRun(alice.config, run);
  if (state === 'missing' || state === 'corrupt') throw new Error(`run ${run} is ${state}`);
  const startCommit = git(alice.checkout, 'rev-parse', 'HEAD');
  git(alice.checkout, 'push', '-q', 'origin', `HEAD:refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
  const offered = await offerAttempt(alice.config, {
    run, attempt: ATTEMPT, pool: 'default', repository: 'github.com/acme/business', owner: await installOwner(alice.config), start: startCommit, staleAfterMs, secrets: {},
    lease: { kind: 'command', step: 'work', command, env: {} },
    definition: { name: state.name, sourceHash: state.sourceHash, definitionHash: definitionHash(state.definition, state.workflows), teamRevision: state.teamRevision, origin: state.origin },
    values: {},
  });
  if (!offered.ok) throw new Error(offered.error.message);
  await markOffered(alice.config, run, ATTEMPT, 'default');
  await readableReportsWorktree(bob.config);

  return { alice, bob, run, startCommit, offered: offered.value };
}

async function recordOf(member: Member, run: ReturnType<typeof RunIdSchema.parse>) {
  const read = await readAttemptRecord(member.config, run, ATTEMPT);

  return read.ok && read.value !== 'absent' ? read.value : undefined;
}

async function eventually<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = await read();

    if (value !== undefined) return value;

    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('cancelling an attempt through its record', () => {
  it('withdraws an offer no member claimed, which no member then takes', async () => {
    const { bob, run, offered, alice } = await offerSlow(60_000);

    expect(await cancelAttempt(alice.config, offered)).toMatchObject({ ok: true, value: { state: 'withdrawn' } });
    await readableReportsWorktree(bob.config);
    expect(await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE }))
      .toEqual({ data: { idle: { offered: 0 } } });
    expect(await recordOf(alice, run)).toMatchObject({ state: 'withdrawn' });
  });

  it('stops the member\'s step, which pushes its work and answers cancelled', async () => {
    const { alice, bob, run, startCommit } = await offerSlow(3_000);
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    // The member's first beat pushed the file the step wrote.
    const running = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' && record.pushed !== startCommit ? record : undefined;
    });

    expect(await cancelAttempt(alice.config, running)).toMatchObject({ ok: true, value: { state: 'cancelling' } });

    expect(await taking).toEqual({ data: { cancelled: { run, attempt: ATTEMPT, step: 'work' } } });
    const cancelled = await recordOf(alice, run);
    expect(cancelled).toMatchObject({ state: 'cancelled', member: { id: (await installOwner(bob.config)).id } });
    if (cancelled?.state !== 'cancelled') return;
    git(alice.checkout, 'fetch', '-q', 'origin', `refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
    expect(git(alice.checkout, 'show', `${cancelled.pushed}:begun.txt`)).toBe('begun');
    await readableReportsWorktree(alice.config);
    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: ATTEMPT, pushed: cancelled.pushed });
  }, 60_000);

  it('runs nothing on the member\'s step runtime when the cancel comes while its place there opens', async () => {
    const { alice, bob, run } = await offerSlow(3_000);
    let execs = 0;
    let open = (): void => {};
    const opening = new Promise<void>((resolve) => { open = resolve; });
    const local = localStepRuntime();
    const runtime: StepRuntime = {
      ...local,
      open: async (request, onAccepted) => {
        await opening;

        return local.open(request, onAccepted);
      },
      exec: async (request, events, kind) => {
        execs += 1;

        return local.exec(request, events, kind);
      },
    };
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } } });
    const claimed = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' ? record : undefined;
    });

    expect(await cancelAttempt(alice.config, claimed)).toMatchObject({ ok: true, value: { state: 'cancelling' } });
    // The member reads the cancel within a beat, a second at this stale_after, and stops the step while its place opens.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    open();

    expect(await taking).toEqual({ data: { cancelled: { run, attempt: ATTEMPT, step: 'work' } } });
    expect(execs).toBe(0);
  }, 60_000);

  it('writes no question of a gate that holds a secret value to teamai-reports', async () => {
    const { bob, offered } = await offerSlow(60_000);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const question = { step: 'keep', kind: 'approve' as const, message: 'Ship with token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB?', options: ['yes', 'no'], required: false };

    expect(await recordProgress(bob.config, claimed.value, 'e'.repeat(40), { question, secrets: {} })).toMatchObject({ ok: false, error: { code: 'fleet_unpublishable' } });
    expect(await readAttemptRecord(bob.config, offered.run, offered.attempt)).toMatchObject({ ok: true, value: { state: 'claimed' } });
  });

  it('goes on from the work a member pushed before a cancel it never answered', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000);
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const progressed = await recordProgress(bob.config, claimed.value, 'e'.repeat(40));
    if (!progressed.ok) throw new Error(progressed.error.message);

    expect(await cancelAttempt(alice.config, progressed.value)).toMatchObject({ ok: true, value: { state: 'cancelling' } });
    await readableReportsWorktree(alice.config);
    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: ATTEMPT, pushed: 'e'.repeat(40) });
  });
});

describe('a restarted member', () => {
  it('finishes with the work its killed run pushed when the step adds nothing to it', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN.replace('test -f left.txt && echo again > again.txt', 'test -f left.txt'), command: 'test -f left.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    git(bob.checkout, 'fetch', '-q', 'origin', ref);
    const work = path.join(path.dirname(bob.checkout), 'bob-left');
    git(bob.checkout, 'worktree', 'add', '-q', '--detach', work, 'FETCH_HEAD');
    fs.writeFileSync(path.join(work, 'left.txt'), 'kept\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'left');
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`);
    const left = git(work, 'rev-parse', 'HEAD');
    git(bob.checkout, 'worktree', 'remove', '--force', work);
    await readableReportsWorktree(bob.config);

    await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect(await recordOf(alice, run)).toMatchObject({ state: 'finished', result: { exitCode: 0, to: left } });
  });

  it('stops the command it left running, and finishes the claim it held from the work it pushed', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN, command: 'test -f left.txt && echo again > again.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    // What a member killed mid-step left: its work so far on the attempt's ref, and the step's command still running.
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    git(bob.checkout, 'fetch', '-q', 'origin', ref);
    const work = path.join(path.dirname(bob.checkout), 'bob-left');
    git(bob.checkout, 'worktree', 'add', '-q', '--detach', work, 'FETCH_HEAD');
    fs.writeFileSync(path.join(work, 'left.txt'), 'kept\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'left');
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`);
    git(bob.checkout, 'worktree', 'remove', '--force', work);
    fs.mkdirSync(attemptDir(bob.config, run, ATTEMPT), { recursive: true });
    const left = startGroupedCommand({ command: 'sleep 60', cwd: bob.checkout, env: process.env, detached: true, group: attemptDir(bob.config, run, ATTEMPT) });
    let isLeftRunning = true;
    void left.exit.then(() => { isLeftRunning = false; });
    await readableReportsWorktree(bob.config);

    try {
      const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

      expect(isLeftRunning).toBe(false);
      expect(taken).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
      const finished = await recordOf(alice, run);
      expect(finished).toMatchObject({ state: 'finished', result: { exitCode: 0, to: expect.any(String) } });
      if (finished?.state !== 'finished' || finished.result.to === undefined) return;
      git(alice.checkout, 'fetch', '-q', 'origin', ref);
      expect(git(alice.checkout, 'show', `${finished.result.to}:left.txt`)).toBe('kept');
      expect(git(alice.checkout, 'show', `${finished.result.to}:again.txt`)).toBe('again');
    } finally {
      await left.stop();
    }
  }, 60_000);

  it('runs the step again on its step runtime, once the place its killed run left there is closed', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: AGAIN, command: 'test -f left.txt && echo again > again.txt' });
    const claimed = await claimAttempt(bob.config, offered, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    git(bob.checkout, 'fetch', '-q', 'origin', ref);
    const work = path.join(path.dirname(bob.checkout), 'bob-left');
    git(bob.checkout, 'worktree', 'add', '-q', '--detach', work, 'FETCH_HEAD');
    fs.writeFileSync(path.join(work, 'left.txt'), 'kept\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'left');
    git(work, 'push', '-q', 'origin', `HEAD:${ref}`);
    git(bob.checkout, 'worktree', 'remove', '--force', work);
    // What the killed run left on the runtime, once stopped: a closed place, and the exec it had sent there, whose id the
    // runtime answers with how that exec ended, as an id sent again reconnects to its exec.
    const stoppedExec = newOpId();
    const local = localStepRuntime();
    const runtime: StepRuntime = { ...local, exec: async (request, events, kind) => (request.op === stoppedExec ? { kind: 'cancelled' } : local.exec(request, events, kind)) };
    fs.mkdirSync(attemptDir(bob.config, run, ATTEMPT), { recursive: true });
    fs.writeFileSync(attemptRuntimePath(bob.config, run, ATTEMPT), JSON.stringify({ runtime: runtime.name, driver: 'bobs', phase: 'closed', open: { op: newOpId(), handle: 'h-left' }, exec: { op: stoppedExec } }));
    await readableReportsWorktree(bob.config);

    const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: { command: { kind: 'runtime', driver: 'bobs', use: 'box', runtime } } });

    expect(taken).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    const finished = await recordOf(alice, run);
    if (finished?.state !== 'finished' || finished.result.to === undefined) throw new Error(`not finished: ${JSON.stringify(finished)}`);
    git(alice.checkout, 'fetch', '-q', 'origin', ref);
    expect(git(alice.checkout, 'show', `${finished.result.to}:again.txt`)).toBe('again');
  }, 60_000);
});

/** A step that writes git config where it runs, as a hostile or careless step can. */
const PLANT = `schemaVersion: v1alpha1
name: slow
description: Writes git config.
steps:
  - id: work
    workspace: new
    command: git config teamai.planted yes && echo planted > planted.txt
`;

describe('a member\'s own checkout', () => {
  it('keeps no git config the step wrote where it ran', async () => {
    const { bob, run } = await offerSlow(60_000, { definition: PLANT, command: 'git config teamai.planted yes && echo planted > planted.txt' });

    const taken = await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    expect(taken).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    expect(fs.readFileSync(path.join(bob.checkout, '.git', 'config'), 'utf8')).not.toContain('planted');
  });

  it('gives the step the origin its checkout names, as the checkout would', async () => {
    const { alice, bob, run } = await offerSlow(60_000, { definition: PLANT.replace('git config teamai.planted yes && echo planted > planted.txt', 'git remote get-url origin > origin.txt'), command: 'git remote get-url origin > origin.txt' });

    await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });

    const finished = await recordOf(alice, run);
    const to = finished?.state === 'finished' ? finished.result.to : undefined;
    git(alice.checkout, 'fetch', '-q', 'origin', `refs/heads/teamai/attempts/${run}/${ATTEMPT}`);
    expect(git(alice.checkout, 'show', `${to ?? 'missing'}:origin.txt`)).toBe(git(bob.checkout, 'remote', 'get-url', 'origin'));
  });
});

describe('the values an offer carries', () => {
  it('carries only the fields of an input, a step\'s outputs and the item that the env reads', () => {
    const read = leaseValues(
      { id: 'build', env: { TARGET: '{{ inputs.config.target }}', SHA: '{{ steps.plan.outputs.commit.sha }}', NAME: '{{ item.name }}' } },
      {
        inputs: { config: { target: 'web', cache: '/Users/alice/.cache/build' }, unread: 'x' },
        steps: { plan: { outputs: { commit: { sha: 'abc', log: '/Users/alice/plan.log' }, notes: 'long' } } },
        run: { id: 'r0123abcd' },
        item: { name: 'one', path: '/Users/alice/one' },
      },
    );

    expect(read).toEqual({ values: { inputs: { config: { target: 'web' } }, outputs: { plan: { commit: { sha: 'abc' } } }, item: { name: 'one' } } });
  });

  it('carries an item whose field the env reads is missing, so the member renders the env as the owner did', () => {
    const step = { id: 'part', env: { PART: '{{ item.name }}' } };
    const read = leaseValues(step, { inputs: {}, steps: {}, run: { id: 'r0123abcd' }, item: { path: '/Users/alice/one' } });
    if (!('values' in read)) throw new Error(read.error);

    // As the owner renders it, from the whole item.
    expect(leaseEnv(step, read.values, RUN)).toEqual(leaseEnv(step, { item: { path: '/Users/alice/one' } }, RUN));
  });

  it('carries nothing for a field an input does not have, even one every object inherits', () => {
    expect(leaseValues({ id: 'build', env: { KIND: '{{ inputs.constructor }}' } }, { inputs: { target: 'web' }, steps: {}, run: { id: 'r0123abcd' } }))
      .toEqual({ values: {} });
  });
});

/** A command that works for a few seconds, writing a file before and after. */
const BRIEF = SLOW.replace('echo begun > begun.txt; sleep 60', 'echo begun > begun.txt; sleep 4; echo done > done.txt');
const BRIEF_COMMAND = 'echo begun > begun.txt; sleep 4; echo done > done.txt';
const OTHER = AttemptIdSchema.parse('a4567cdef');

describe('a member\'s claim among writes it did not see land', () => {
  it('goes on running when a write of its own claim landed though it could not tell', async () => {
    const { alice, bob, run, startCommit } = await offerSlow(3_000, { definition: BRIEF, command: BRIEF_COMMAND });
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    const claimed = await eventually(async () => {
      const record = await recordOf(alice, run);

      return record?.state === 'claimed' ? record : undefined;
    });

    // The member's own progress write, which landed while the member read that it failed.
    expect(await recordProgress(bob.config, claimed, startCommit)).toMatchObject({ ok: true });

    expect(await taking).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
  }, 60_000);

  it('saves again once a push to one of its push URLs failed, from the work the others took', async () => {
    let mirror = '';
    const { alice, bob, run } = await offerSlow(3_000, { definition: BRIEF, command: BRIEF_COMMAND });
    const origin = git(bob.checkout, 'remote', 'get-url', 'origin');
    mirror = path.join(path.dirname(origin), 'mirror.git');
    git(path.dirname(origin), 'init', '-q', '--bare', mirror);
    git(bob.checkout, 'config', 'remote.origin.pushurl', origin);
    git(bob.checkout, 'config', '--add', 'remote.origin.pushurl', mirror);
    // The mirror takes no object until the first save reached origin.
    const objects = path.join(mirror, 'objects');
    fs.chmodSync(objects, 0o555);
    const taking = takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE });
    const ref = `refs/heads/teamai/attempts/${run}/${ATTEMPT}`;
    const startTip = git(origin, 'rev-parse', ref);

    try {
      await eventually(async () => (git(origin, 'rev-parse', ref) === startTip ? undefined : true));
    } finally {
      fs.chmodSync(objects, 0o755);
    }

    expect(await taking).toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
    const finished = await recordOf(alice, run);
    const to = finished?.state === 'finished' ? finished.result.to : undefined;
    expect(git(origin, 'show', `${to}:done.txt`)).toBe('done');
    expect(git(mirror, 'rev-parse', ref)).toBe(to);
  }, 60_000);

  it('takes an offer although a record it never claimed names it as the claimer', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000, { definition: BRIEF, command: BRIEF_COMMAND });
    // A claim naming Bob of an attempt whose ref origin does not hold, which Bob never wrote.
    const other = await offerAttempt(alice.config, { ...offered, attempt: OTHER, secrets: {} });
    if (!other.ok) throw new Error(other.error.message);
    expect(await claimAttempt(alice.config, other.value, await installOwner(bob.config))).toMatchObject({ ok: true });
    await readableReportsWorktree(bob.config);

    expect(await takeFleetAttempt(bob.config, { pool: 'default', repository: 'github.com/acme/business', root: bob.checkout, member: await installOwner(bob.config), secrets: {}, place: HERE }))
      .toEqual({ data: { ran: { run, attempt: ATTEMPT, step: 'work', exit_code: 0 } } });
  }, 60_000);
});

describe('the gone work a retry goes on from', () => {
  it('is never that of an attempt this install did not offer, whatever owner its record names', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000);
    // A record of an attempt Alice never offered, naming her as its owner.
    const forged = await offerAttempt(bob.config, { ...offered, attempt: OTHER, secrets: {} });
    if (!forged.ok) throw new Error(forged.error.message);
    const claimed = await claimAttempt(bob.config, forged.value, await installOwner(bob.config));
    if (!claimed.ok) throw new Error(claimed.error.message);
    const progressed = await recordProgress(bob.config, claimed.value, 'e'.repeat(40));
    if (!progressed.ok) throw new Error(progressed.error.message);
    expect(await expireClaim(bob.config, progressed.value)).toMatchObject({ ok: true });
    await readableReportsWorktree(alice.config);

    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toBeUndefined();
    await markOffered(alice.config, run, OTHER, 'default');
    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: OTHER, pushed: 'e'.repeat(40) });
  });

  it('is the last one the owner gave up by its own clock, whatever time a member wrote', async () => {
    const { alice, bob, run, offered } = await offerSlow(60_000);
    const member = await installOwner(bob.config);
    const claimed = await claimAttempt(bob.config, offered, member);
    if (!claimed.ok) throw new Error(claimed.error.message);
    const cancelling = await cancelAttempt(alice.config, (await recordProgress(bob.config, claimed.value, 'd'.repeat(40))).ok ? (await recordOf(alice, run)) as typeof claimed.value : claimed.value);
    if (!cancelling.ok || cancelling.value.state !== 'cancelling') throw new Error('not cancelling');
    // The member's clock runs a year ahead when it answers.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 365 * 24 * 3600_000 });
    try {
      expect(await answerCancel(bob.config, cancelling.value, 'd'.repeat(40))).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
    const later = await offerAttempt(alice.config, { ...offered, attempt: OTHER, secrets: {} });
    if (!later.ok) throw new Error(later.error.message);
    const reclaimed = await claimAttempt(bob.config, later.value, member);
    if (!reclaimed.ok) throw new Error(reclaimed.error.message);
    const moved = await recordProgress(bob.config, reclaimed.value, 'e'.repeat(40));
    if (!moved.ok) throw new Error(moved.error.message);
    expect(await expireClaim(alice.config, moved.value)).toMatchObject({ ok: true });
    await markOffered(alice.config, run, OTHER, 'default');
    await readableReportsWorktree(alice.config);

    expect(await lastGoneWork(alice.config, { run, step: 'work' })).toEqual({ attempt: OTHER, pushed: 'e'.repeat(40) });
  });
});

describe('fleet entries of one driver definition', () => {
  const fleet = (options: Record<string, unknown>) => ({ use: 'fleet', options: RuntimeOptionsSchema.parse(options) });

  it('names a fleet entry an earlier one takes every step from, and only that one', () => {
    expect(shadowedFleetEntries([
      fleet({ pool: 'default' }),
      fleet({ pool: 'e2e', can: { network: true } }),
      { use: 'local' },
      fleet({ pool: 'spare' }),
    ])).toEqual([
      'The fleet entry for pool "spare" never gets a step: the fleet entry for pool "default" before it offers everything it does, and takes each step first. Put the more specific entry first.',
    ]);
  });

  it('names no labelled entry after one without its labels, and an entry an earlier one with every label of it covers', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'default' }), fleet({ pool: 'e2e', labels: ['computer-use'] })])).toEqual([]);
    expect(shadowedFleetEntries([fleet({ pool: 'e2e', labels: ['computer-use', 'gpu'] }), fleet({ pool: 'gpu', labels: ['gpu'] })])).toEqual([
      'The fleet entry for pool "gpu" never gets a step: the fleet entry for pool "e2e" before it offers everything it does, and takes each step first. Put the more specific entry first.',
    ]);
  });

  it('declares the labels its entry lists, so a step that requires them goes to its pool', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });

    expect(await runtime.init({ options: { pool: 'e2e', labels: ['computer-use'] }, mode: 'unattended', checkout: alice.checkout })).toMatchObject({ ok: true, can: { labels: ['computer-use'] } });
    await runtime.dispose();
  });

  it('declares no person at its tools, whatever its entry promises, so no interactive step goes to the fleet', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });
    const ready = await runtime.init({ options: { pool: 'e2e', can: { hitl: true, network: true } }, mode: 'unattended', checkout: alice.checkout });

    expect(ready).toMatchObject({ ok: true, can: { network: true } });
    expect(ready.ok && ready.can).not.toHaveProperty('hitl');
    await runtime.dispose();
  });

  it('names a specific fleet entry a general one before it covers', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'any', can: { network: true, isolation: 'sandbox' } }), fleet({ pool: 'box', can: { isolation: 'worktree' } })])).toEqual([
      'The fleet entry for pool "box" never gets a step: the fleet entry for pool "any" before it offers everything it does, and takes each step first. Put the more specific entry first.',
    ]);
  });

  it('names no entry after one that runs no command, since an entry that says nothing of exec runs commands', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'prompts', can: { exec: false } }), fleet({ pool: 'default' })])).toEqual([]);
  });

  it('names a shadowed fleet entry that also sets the options teamai takes for itself', () => {
    expect(shadowedFleetEntries([fleet({ pool: 'default' }), fleet({ pool: 'spare', max_parallel: 2, credentials: { GH_TOKEN: 'env:GH_TOKEN' } })])).toEqual([
      'The fleet entry for pool "spare" never gets a step: the fleet entry for pool "default" before it offers everything it does, and takes each step first. Put the more specific entry first.',
    ]);
  });
});

describe('where a member runs an attempt', () => {
  /** A member's own driver `name` whose runtimes offer `cans` in order, `local` for the local runtime. */
  async function driverOf(cans: Array<'local' | { use: string; can: Record<string, boolean> }>): Promise<OpenedDriver> {
    const acme = team();
    const { config } = await acme.member('bob');
    const runtime = localStepRuntime();
    const runtimes = cans.map((entry): OpenedRuntime => (entry === 'local'
      ? { kind: 'local', use: 'local', engine: { logins: [] } }
      : { kind: 'external', use: entry.use, runtime, can: entry.can, launchesAgents: false, engine: { logins: [] }, credentials: {}, found: [], masks: {}, optionsFrom: 'test' }));
    const [first, ...rest] = runtimes;
    if (!first) throw new Error('no runtime');

    return { driver: { name: 'bobs', definition: { schemaVersion: 'v1alpha1', name: 'bobs', runtimes: [] }, source: 'personal', file: 'bobs.yaml', config }, asked: 'bobs', runtimes: [first, ...rest] };
  }

  it('runs on the first runtime of its driver that runs commands, one that does not say it runs none included', async () => {
    expect(memberPlace(await driverOf([{ use: 'box', can: {} }, 'local']))).toMatchObject({ command: { kind: 'runtime', use: 'box', driver: 'bobs' } });
  });

  it('passes over a runtime that runs no command and its own fleet, and runs here when local comes next', async () => {
    expect(memberPlace(await driverOf([{ use: 'judge', can: { exec: false } }, { use: 'fleet', can: {} }, 'local']))).toMatchObject({ command: { kind: 'here' } });
  });

  it('runs a prompt step on the first runtime of its driver that runs prompts, and a command on the first that runs commands', async () => {
    expect(memberPlace(await driverOf([{ use: 'judge', can: { exec: false } }, { use: 'box', can: { prompt: false } }, 'local']))).toMatchObject({
      command: { kind: 'runtime', use: 'box' },
      prompt: { kind: 'runtime', use: 'judge' },
    });
  });

  it('takes no prompt step on a driver whose runtimes run none, and still takes command steps there', async () => {
    const place = memberPlace(await driverOf([{ use: 'box', can: { prompt: false } }]));

    expect(place).toMatchObject({ command: { kind: 'runtime', use: 'box' } });
    expect(place).not.toHaveProperty('prompt');
  });

  it('refuses a driver whose runtimes run neither commands nor prompts', async () => {
    expect(memberPlace(await driverOf([{ use: 'box', can: { exec: false, prompt: false } }]))).toMatchObject({ refused: expect.stringContaining('no runtime that runs command or prompt steps') });
  });
});
