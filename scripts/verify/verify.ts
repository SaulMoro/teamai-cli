import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runLedger } from './ledger.js';
import { planCleanup } from './leftovers.js';
import { passedKeys, splitPassOption } from './secrets.js';
import { addMember, ensureOrigin, memberLayout, parseMachine } from './members.js';
import { memberOf, parseTarget, runOn } from './target.js';
import { checkoutStatus, createWorld, git, liveWorlds, loadWorld, REPO_ROOT, saveWorld, TEAM_URL, TOOL_COMMANDS, type World } from './world.js';

const HELP = `Verify a teamai change end to end: the real CLI, packed and installed, in an isolated world.

  npm run verify:world                        build, pack, create a world; print its run id alone on stdout
  npm run -s verify -- doctor [run]           node, git and each tool on PATH; whether the world matches the checkout
  npm run -s verify -- teamai <run> <args>    the world's installed teamai, in its project
  npm run -s verify -- sh <run> <cmd> [args]  any command in the world (git, claude -p, a second checkout)
  npm run -s verify -- ledger <run>           uninstall teamai in the world, then what is left, in LEDGER-<n>.md; exit 1 on any LEAK
  npm run -s verify -- cleanup <run>|--all    remove the world and the containers and sandboxes its runs left, keeping world.json,
                                              logs/ and every ledger; refuses while a process of the world runs
  npm run -s verify -- dir <run>|--all        the world's directory, or every live world

A world holds a project repo with one commit, a bare team repo at ${TEAM_URL}, the npm pack tarball of
this checkout installed on its own, a HOME and TMPDIR of its own, and a fake gh first on PATH: \`gh pr list\`
prints fakes/gh-pr-list.json or [], anything else fails as when gh is not signed in, and each call goes to
fakes/gh.log. Commands get an environment built from nothing: no tool home (CLAUDE_CONFIG_DIR, CODEX_HOME, ...)
or TEAMAI_* variable of your shell reaches them. Set one on the command line when the claim needs it: \`sh <run> env CODEX_HOME=... teamai pull\`.

A world freezes the build it was made from. Change teamai and the next proof needs a new world; doctor warns when
the checkout has moved on. Start from \`teamai init ${TEAM_URL} --provider git --agent claude\`.

Use the real tool on its cheapest model (claude -p --model haiku). A faked tool proves the fake. A tool that is not
installed or not signed in here makes the claim UNVERIFIABLE, not passed.

Verdicts, reported with the combination and entry point (VERIFIED: claude x git x project scope via teamai pull):
  VERIFIED      every observable matched and the ledger is CLEAN
  FAILED        an observable did not match, or the ledger found a LEAK; quote the output
  UNVERIFIABLE  a prerequisite is missing (a tool, a sign-in, Windows); name it
A fix is proved by a pair: FAILED in a world built from main, VERIFIED in a world built from the change.

Run ledger after the last run, before cleanup. Paste the verdict, the commands, build.json's line from the run's
first output, and the ledger's last line into the PR's real-CLI record.`;

const [verb, ...rest] = process.argv.slice(2);

function doctor(runId: string | undefined): void {
  const line = (good: boolean, text: string): void => console.log(`${good ? 'ok  ' : 'warn'} ${text}`);
  line(true, `node ${process.version}`);
  line(true, git(REPO_ROOT, '--version'));

  for (const tool of TOOL_COMMANDS) {
    try {
      const version = execFileSync(tool, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim().split('\n')[0];
      line(true, `${tool} ${version}`);
    } catch {
      line(false, `${tool} not on PATH: claims about it are UNVERIFIABLE here`);
    }
  }

  if (runId === undefined) return;
  const world = loadWorld(runId);
  const head = git(REPO_ROOT, 'rev-parse', 'HEAD');
  const same = head === world.build.commit && !world.build.dirty && checkoutStatus().length === 0;
  line(world.cleanedAt === undefined, `world ${world.runId} at ${world.dir}${world.cleanedAt === undefined ? '' : ' was cleaned up'}`);
  line(same, `world built from ${world.build.commit.slice(0, 7)}${world.build.dirty ? '+dirty' : ''}; checkout is at ${head.slice(0, 7)}${same ? '' : ': make a new world to test the checkout as it is now'}`);
}

/**
 * Removes what the world's runs left that the leftover rows attribute to it, then the world's files, keeping world.json,
 * logs/, observed.jsonl and every ledger. Never signals a process: while one of the world's lives, refuses and names it.
 */
async function cleanup(world: World): Promise<boolean> {
  const plan = await planCleanup(world);

  if (plan.kind === 'refuse') {
    console.error(`Not cleaning ${world.runId}: a process of the world still runs. Stop each one, then run cleanup again:\n${plan.processes.map((what) => `  ${what}`).join('\n')}`);

    return false;
  }

  for (const note of plan.unobserved) console.error(`NOT OBSERVED: ${note}; cleanup removed nothing of it.`);

  for (const removal of plan.removals) {
    const [command = 'true', ...args] = removal.command;
    const ran = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });

    if (ran.status !== 0) {
      console.error(`Not cleaning ${world.runId}: removing ${removal.what} failed (${ran.error?.message ?? ran.stderr.trim()}). Its files are kept, so a ledger can still find it.`);

      return false;
    }

    console.log(`Removed ${removal.what}`);
  }

  for (const member of world.members ?? []) {
    if (member.machine !== 'container') continue;
    const removed = spawnSync('docker', ['rm', '-f', member.container], { encoding: 'utf8' });

    if (removed.status !== 0 && !/No such container/i.test(removed.stderr)) {
      console.error(`Not cleaning ${world.runId}: removing @${member.name}'s container ${member.container} failed (${removed.stderr.trim()}).`);

      return false;
    }

    console.log(`@${member.name}'s container ${member.container} is gone`);
  }

  const keep = new Set(['world.json', 'logs', 'observed.jsonl']);

  for (const name of fs.readdirSync(world.dir)) {
    if (keep.has(name) || /^LEDGER-\d+\.md$/.test(name)) continue;
    fs.rmSync(path.join(world.dir, name), { recursive: true, force: true });
  }

  // A world made since its TMPDIR moved out of its directory, to /tmp; each member's sits beside it.
  for (const tmp of [world.tmp, ...(world.members ?? []).map((member) => member.tmp)]) {
    if (path.relative(world.dir, tmp).startsWith('..')) fs.rmSync(tmp, { recursive: true, force: true });
  }

  saveWorld({ ...world, cleanedAt: new Date().toISOString() });
  console.log(`Cleaned ${world.runId}. Evidence kept in ${world.dir}`);

  return true;
}

async function main(): Promise<number> {
  switch (verb) {
    case 'world': {
      const world = createWorld();
      console.error(`World ${world.dir}\nBuild ${world.build.commit.slice(0, 12)}${world.build.dirty ? '+dirty' : ''}, teamai ${world.build.version}, sha256 ${world.build.sha256.slice(0, 12)}`);
      console.log(world.runId);

      return 0;
    }

    case 'doctor': {
      const run = rest.find((arg) => arg !== '--drivers');
      doctor(run === undefined ? undefined : parseTarget(run).runId);

      if (rest.includes('--drivers')) {
        const { doctorDrivers } = await import('./doctor.js');
        doctorDrivers((good, text) => console.log(`${good ? 'ok  ' : 'warn'} ${text}`));
      }

      return 0;
    }

    case 'origin': {
      const world = ensureOrigin(loadWorld(parseTarget(rest[0]).runId));
      console.log(`${world.origin?.url ?? ''} -> ${world.origin?.bare ?? ''}`);

      return 0;
    }

    case 'member': {
      const [run, name, ...flags] = rest;

      if (name === undefined) throw new Error('member needs a run id and a name, such as `member <run> bob`.');
      const world = addMember(loadWorld(parseTarget(run).runId), { name, machine: parseMachine(flags) });
      console.log(memberOf(world, name).project);

      return 0;
    }

    case 'teamai':
    case 'sh': {
      const { runId, target } = parseTarget(rest[0]);
      const { names, argv: command } = splitPassOption(rest.slice(1));
      const passed = passedKeys(names, process.env);

      if (!passed.ok) throw new Error(`--pass names ${passed.missing.join(', ')}, which this shell does not set to a value. Export each one first, or leave it out.`);

      if (verb === 'sh' && command.length === 0) throw new Error('sh needs a run id and a command.');
      const argv = verb === 'teamai' ? ['teamai', ...command] : command;

      return (await runOn(loadWorld(runId), target, argv, { pass: passed.keys })).exit;
    }

    // The ledger and cleanup cover the world and every member of it, whichever one names it.
    case 'ledger':
      return await runLedger(loadWorld(parseTarget(rest[0]).runId)) ? 0 : 1;
    case 'cleanup': {
      let isClean = true;

      for (const world of rest[0] === '--all' ? liveWorlds() : [loadWorld(parseTarget(rest[0]).runId)]) isClean = await cleanup(world) && isClean;

      return isClean ? 0 : 1;
    }

    case 'reap': {
      const { reap } = await import('./reap.js');

      return reap(rest, loadWorld);
    }

    case 'dir': {
      if (rest[0] === '--all') {
        for (const world of liveWorlds()) console.log(`${world.runId} ${world.dir}`);

        return 0;
      }

      const { runId, target } = parseTarget(rest[0]);
      const world = loadWorld(runId);
      console.log(target.kind === 'member' ? memberLayout(world, { name: memberOf(world, target.name).name, tmpRoot: '' }).root : world.dir);

      return 0;
    }

    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);

      return 0;
    default:
      console.error(`Unknown verb ${verb}.\n\n${HELP}`);

      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
