/**
 * sbx sandboxes teamai named (`teamai-<journal>-…`), tied to a world by the owner journal of one of its HOMEs. sbx keeps
 * its sandboxes per HOME, so each install on this machine is asked in its own, with its own environment, as teamai asks.
 */
import { PROVIDER_COMMANDS } from '../../../packages/runtime-sandbox/src/provider-commands.js';
import { journalOfSandboxName } from '../../../packages/runtime-sandbox/src/provider.js';
import { sbxNamesListed } from '../../../packages/runtime-sandbox/src/providers/sbx.js';
import { attributeLeftover, type LeftoverKind, type Observed } from '../leftovers.js';
import { captureOn, hostInstalls } from '../target.js';

export const sbxSandboxes: LeftoverKind = {
  title: 'teamai sbx sandbox',
  onCleanup: { kind: 'remove' },
  observe({ world, self, others }) {
    const command = PROVIDER_COMMANDS.sbx;

    return Promise.resolve(hostInstalls(world).map(({ at, target, commandLine }): Observed => {
      const listed = captureOn(world, target, [command, 'ls', '--json']);
      const what = at === world.runId ? 'sbx sandboxes' : `sbx sandboxes of ${at}`;

      if (listed.errno === 'ENOENT') return { kind: 'observed', findings: [], notes: [`${what}: sbx not installed here`] };
      const names = listed.code === 0 ? sbxNamesListed(listed.stdout) : undefined;

      if (names === undefined) return { kind: 'not_observed', what, why: `\`sbx ls --json\` failed or printed no list: ${listed.why}` };

      return {
        kind: 'observed',
        findings: names.flatMap((name) => {
          const journal = journalOfSandboxName(name);

          return journal === undefined ? [] : [{ what: `sbx sandbox ${name}`, attribution: attributeLeftover({ paths: [], journals: [journal], runs: [], marked: true }, self, others), remove: commandLine([command, 'rm', '--force', name]) }];
        }),
        notes: [],
      };
    }));
  },
};
