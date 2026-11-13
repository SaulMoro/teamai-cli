/**
 * sbx sandboxes teamai named (`teamai-<journal>-…`), tied to a world by the owner journal of one of its HOMEs, and the warm
 * templates teamai saved (`teamai-warm:<key>`), tied to a world by the HOME whose image store holds them. sbx keeps both
 * per HOME, so each install on this machine is asked in its own, with its own environment, as teamai asks.
 */
import { PROVIDER_COMMANDS } from '../../../packages/runtime-sandbox/src/provider-commands.js';
import { journalOfSandboxName } from '../../../packages/runtime-sandbox/src/provider.js';
import { sbxNamesListed, sbxWarmTemplatesListed } from '../../../packages/runtime-sandbox/src/providers/sbx.js';
import { attributeLeftover, type LeftoverContext, type LeftoverKind, type Observed } from '../leftovers.js';
import { captureOn, hostInstalls } from '../target.js';

const command = PROVIDER_COMMANDS.sbx;

type Install = ReturnType<typeof hostInstalls>[number];

/** The sandboxes `sbx ls --json` lists in the install's HOME, or that it could not list them. */
function sandboxesOn({ self, others }: LeftoverContext, { commandLine }: Install, listed: ReturnType<typeof captureOn>, of: string): Observed {
  const names = listed.code === 0 ? sbxNamesListed(listed.stdout) : undefined;

  if (names === undefined) return { kind: 'not_observed', what: `sbx sandboxes${of}`, why: `\`sbx ls --json\` failed or printed no list: ${listed.why}` };

  return {
    kind: 'observed',
    findings: names.flatMap((name) => {
      const journal = journalOfSandboxName(name);

      return journal === undefined ? [] : [{ what: `sbx sandbox ${name}`, attribution: attributeLeftover({ paths: [], journals: [journal], runs: [], marked: true }, self, others), remove: commandLine([command, 'rm', '--force', name]) }];
    }),
    notes: [],
  };
}

/** teamai's warm templates `sbx template ls --json` lists in the install's HOME, or that it could not list them. */
function templatesOn({ world, self, others }: LeftoverContext, { target, home, commandLine }: Install, of: string): Observed {
  const listed = captureOn(world, target, [command, 'template', 'ls', '--json']);
  const saved = listed.code === 0 ? sbxWarmTemplatesListed(listed.stdout) : undefined;

  if (saved === undefined) return { kind: 'not_observed', what: `sbx templates${of}`, why: `\`sbx template ls --json\` failed or printed no list: ${listed.why}` };

  return {
    kind: 'observed',
    findings: saved.map(({ ref }) => ({ what: `sbx template ${ref}`, attribution: attributeLeftover({ paths: [home], journals: [], runs: [], marked: true }, self, others), remove: commandLine([command, 'template', 'rm', '--force', ref]) })),
    notes: [],
  };
}

export const sbxLeftovers: LeftoverKind = {
  title: 'teamai sbx sandbox or template',
  onCleanup: { kind: 'remove' },
  observe(context) {
    return Promise.resolve(hostInstalls(context.world).flatMap((install): Observed[] => {
      const listed = captureOn(context.world, install.target, [command, 'ls', '--json']);
      const of = install.at === context.world.runId ? '' : ` of ${install.at}`;

      if (listed.errno === 'ENOENT') return [{ kind: 'observed', findings: [], notes: [`sbx sandboxes${of}: sbx not installed here`] }];

      // Sandboxes go first: cleanup removes in this order, and a template a sandbox still runs from may not go before it.
      return [sandboxesOn(context, install, listed, of), templatesOn(context, install, of)];
    }));
  },
};
