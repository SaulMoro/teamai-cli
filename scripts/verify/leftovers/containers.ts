/**
 * Containers, networks and images teamai labelled (`teamai.owner`) on each container engine that is up, tied to a world by
 * the owner journal of one of its HOMEs or by a mount of one of its paths. An engine is asked, never started.
 */
import { CONTAINER_ENGINES, PROVIDER_COMMANDS } from '../../../packages/runtime-sandbox/src/options.js';
import { attributeLeftover, probeHere, type Finding, type LeftoverKind, type Observed, type WorldTies } from '../leftovers.js';

const OWNER = 'teamai.owner';

/** `ps --format` lines: id, name, owner, run and state, tab-separated. */
export function parseContainers(stdout: string): Array<{ id: string; name: string; owner: string; run: string; state: string }> {
  return stdout.split('\n').flatMap((line) => {
    const [id = '', name = '', owner = '', run = '', state = ''] = line.split('\t');

    return id === '' ? [] : [{ id, name, owner, run, state }];
  });
}

/** `inspect --format` lines: id, then the source of each mount, tab-separated. */
export function parseMounts(stdout: string): Map<string, string[]> {
  return new Map(stdout.split('\n').flatMap((line) => {
    const [id = '', ...sources] = line.split('\t');

    return id === '' ? [] : [[id.slice(0, 12), sources.filter((source) => source !== '')] as const];
  }));
}

/** `ls --format` lines of a network or an image: id, name and owner, tab-separated. */
export function parseLabelled(stdout: string): Array<{ id: string; name: string; owner: string }> {
  return stdout.split('\n').flatMap((line) => {
    const [id = '', name = '', owner = ''] = line.split('\t');

    return id === '' ? [] : [{ id, name, owner }];
  });
}

function onEngine(engine: (typeof CONTAINER_ENGINES)[number], self: WorldTies, others: readonly WorldTies[]): Observed[] {
  const command = PROVIDER_COMMANDS[engine];
  const info = probeHere([command, 'info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 });

  if (info.kind === 'missing') return [{ kind: 'observed', findings: [], notes: [`${engine}: not installed here`] }];

  if (info.code !== 0) return [{ kind: 'not_observed', what: `${engine} containers`, why: `\`${engine} info\` failed, so the engine is not up: ${info.why}` }];
  const listed = probeHere([command, 'ps', '-a', '--no-trunc', '--filter', `label=${OWNER}`, '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${OWNER}"}}\t{{.Label "teamai.run"}}\t{{.State}}`]);

  if (listed.kind !== 'ran' || listed.code !== 0) return [{ kind: 'not_observed', what: `${engine} containers`, why: `\`${engine} ps\` failed: ${listed.kind === 'ran' ? listed.why : 'not installed'}` }];
  const found = parseContainers(listed.stdout);
  const inspected = found.length === 0 ? undefined : probeHere([command, 'inspect', '--format', `{{.Id}}{{range .Mounts}}\t{{.Source}}{{end}}`, ...found.map((one) => one.id)]);
  const mounts = inspected?.kind === 'ran' && inspected.code === 0 ? parseMounts(inspected.stdout) : new Map<string, string[]>();
  const unobserved: Observed[] = inspected !== undefined && mounts.size === 0 ? [{ kind: 'not_observed', what: `mounts of ${engine} containers`, why: `\`${engine} inspect\` failed` }] : [];
  const tie = (owner: string, paths: readonly string[], runs: readonly string[]) => attributeLeftover({ paths, journals: owner === '' ? [] : [owner], runs, marked: true }, self, others);

  const findings: Finding[] = found.map((one) => ({
    what: `${engine} container ${one.name} (${one.state})`,
    attribution: tie(one.owner, mounts.get(one.id.slice(0, 12)) ?? [], one.run === '' ? [] : [one.run]),
    remove: [command, 'rm', '-f', one.id],
  }));

  for (const [kind, remove] of [['network', 'rm'], ['image', 'rm']] as const) {
    const format = kind === 'network' ? `{{.ID}}\t{{.Name}}\t{{.Label "${OWNER}"}}` : `{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Label "${OWNER}"}}`;
    const ls = probeHere([command, kind === 'network' ? 'network' : 'image', 'ls', '--filter', `label=${OWNER}`, '--format', format]);

    if (ls.kind !== 'ran' || ls.code !== 0) {
      unobserved.push({ kind: 'not_observed', what: `${engine} ${kind}s`, why: `\`${engine} ${kind} ls\` failed` });
      continue;
    }

    findings.push(...parseLabelled(ls.stdout).map((one) => ({ what: `${engine} ${kind} ${one.name}`, attribution: tie(one.owner, [], []), remove: [command, kind, remove, one.id] })));
  }

  return [{ kind: 'observed', findings, notes: [] }, ...unobserved];
}

export const containers: LeftoverKind = {
  title: 'teamai container, network or image',
  onCleanup: 'remove',
  observe({ self, others }) {
    return Promise.resolve(CONTAINER_ENGINES.flatMap((engine) => onEngine(engine, self, others)));
  },
};
