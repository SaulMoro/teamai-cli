import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/launcher-conformance', { filename: 'packages/runtime-box/src/step.ts' });
rule.invalid('rejects a launcher a function returns outside the adapters that run the suite', `export function boxProcess(): ToolLauncher { return start; }`);
rule.invalid('rejects a launcher a constant holds outside them', `const start: ToolLauncher = (launch) => run(launch);`);
rule.invalid('rejects a launcher an arrow returns outside them', `export const boxProcess = (): ToolLauncher => start;`);
rule.invalid('rejects a launcher written inline into a launch, which no suite reaches', `await runStepLaunch({ tool, input, start: (launch) => run(launch) });`, undefined, { filename: 'packages/runtime-tools/src/step.ts' });
rule.valid('allows an adapter the suite runs on', `export function hostProcess(): ToolLauncher { return start; }`, { filename: 'packages/runtime-tools/src/step.ts' });
rule.valid('allows a launcher passed on by name', `export async function run({ start }: { start: ToolLauncher }) { return runStepLaunch({ tool, input, start }); }`);
rule.valid('leaves tests alone', `const start: ToolLauncher = (launch) => run(launch);`, { filename: 'packages/runtime-box/src/step.test.ts' });
