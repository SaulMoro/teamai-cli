import type { Command, Option } from 'commander';

// ─── Generated command reference ─────────────────────────
//
//  The `core` skill used to carry a hand-written cheat sheet
//  labelled "ground truth". It drifted four times (e151d43,
//  1ca43ac, 8bb0548, 2ddb546), each time after a command
//  changed under it.
//
//  The command table is the only real ground truth, so the
//  reference is rendered from it and checked by a test that
//  regenerates and diffs. Adding a command without updating
//  the reference now fails the build.
//

/** Where the rendered reference is written, relative to the package root. */
export const COMMANDS_REFERENCE_PATH = 'skill-data/core/references/commands.md';

const HEADER = `# teamai command reference

Every command the installed CLI accepts, rendered from its own command table.
Flags marked \`(hidden)\` work but are absent from \`--help\`, so treat this file —
not \`--help\` — as the complete list.

Generated: do not edit by hand. Regenerate with
\`npx vitest run commands-reference -u\` after changing a command or a flag.
`;

function renderOption(option: Option): string {
  const hidden = option.hidden ? ' (hidden)' : '';
  const description = option.description ? ` — ${option.description}` : '';
  return `  - \`${option.flags}\`${hidden}${description}`;
}

function visibleOptions(command: Command): Option[] {
  // `-h, --help` is on every command and says nothing about the command.
  return command.options.filter((option) => option.long !== '--help');
}

function renderCommand(command: Command, parents: string[]): string[] {
  const path = [...parents, command.name()];
  const args = command.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`));
  const usage = ['teamai', ...path, ...args].join(' ');

  const lines: string[] = [];
  const description = command.description();
  lines.push(`- \`${usage}\`${description ? ` — ${description}` : ''}`);
  for (const option of visibleOptions(command)) {
    lines.push(renderOption(option));
  }
  for (const sub of command.commands as Command[]) {
    lines.push(...renderCommand(sub, path).map((line) => `  ${line}`));
  }
  return lines;
}

/** Render the whole command table as the markdown the `core` skill serves. */
export function renderCommandsReference(program: Command): string {
  const sections: string[] = [HEADER];

  const globalOptions = visibleOptions(program);
  if (globalOptions.length > 0) {
    sections.push(['## Global options', '', ...globalOptions.map(renderOption).map((l) => l.slice(2))].join('\n'));
  }

  for (const command of program.commands as Command[]) {
    sections.push([`## ${command.name()}`, '', ...renderCommand(command, [])].join('\n'));
  }

  return sections.join('\n\n') + '\n';
}
