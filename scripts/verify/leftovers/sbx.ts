/** sbx sandboxes teamai named (`teamai-<journal>-…`), tied to a world by the owner journal of one of its HOMEs. */
import { PROVIDER_COMMANDS } from '../../../packages/runtime-sandbox/src/provider-commands.js';
import { sbxNamesListed } from '../../../packages/runtime-sandbox/src/providers/sbx.js';
import { attributeLeftover, probeHere, type LeftoverKind } from '../leftovers.js';

/** The journal id an sbx name teamai gave starts with, or undefined for a name teamai does not give. */
export function journalOfSbxName(name: string): string | undefined {
  return /^teamai-([0-9a-f]{16})-/.exec(name)?.[1];
}

export const sbxSandboxes: LeftoverKind = {
  title: 'teamai sbx sandbox',
  onCleanup: 'remove',
  observe({ self, others }) {
    const command = PROVIDER_COMMANDS.sbx;
    const listed = probeHere([command, 'ls', '--json']);

    if (listed.kind === 'missing') return Promise.resolve([{ kind: 'observed', findings: [], notes: ['sbx: not installed here'] }]);
    const names = listed.code === 0 ? sbxNamesListed(listed.stdout) : undefined;

    if (names === undefined) return Promise.resolve([{ kind: 'not_observed', what: 'sbx sandboxes', why: `\`sbx ls --json\` failed or printed no list: ${listed.why}` }]);

    return Promise.resolve([{
      kind: 'observed',
      findings: names.flatMap((name) => {
        const journal = journalOfSbxName(name);

        return journal === undefined ? [] : [{ what: `sbx sandbox ${name}`, attribution: attributeLeftover({ paths: [], journals: [journal], runs: [], marked: true }, self, others), remove: [command, 'rm', '--force', name] }];
      }),
      notes: [],
    }]);
  },
};
