import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleRuntime } from '@teamai/runtime-testing/bundle';

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'runtime-sandbox', 'src');

/**
 * teamai-runtime-sandbox built as it ships, on a fake `docker` and a fake `sbx` (packages/runtime-sandbox/src/testing/
 * fake-engine.mjs) whose sandboxes run on the host. `command` and `args` start it with its journal under `state`;
 * `options` choose the fake docker's one image, or the fake sbx's one agent, whose tools are the executables in `bin`.
 */
export async function sandboxOnFake(provider: 'docker' | 'sbx'): Promise<{ command: string; bin: string; args: (state: string) => string[]; options: { provider: 'docker'; image: string } | { provider: 'sbx'; agent: string } }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-runtime-')));
  const executable = await bundleRuntime({ entry: path.join(PACKAGE, 'main.ts'), outfile: path.join(dir, 'teamai-runtime-sandbox.mjs') });

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, provider), `#!/bin/sh\nFAKE_ENGINE_NAME=${provider} exec "${process.execPath}" "${path.join(PACKAGE, 'testing', 'fake-engine.mjs')}" "$@"\n`, { mode: 0o755 });
  // The fake docker's image, or the fake sbx's agent template: either holds the tools in `bin`.
  const template = provider === 'docker' ? 'scenario/agent:1' : 'claude';

  return {
    command: '/usr/bin/env',
    bin,
    args: (state) => [
      `PATH=${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, `HOME=${path.join(state, 'home')}`, `FAKE_ENGINE_STATE=${path.join(state, 'engine')}`,
      `FAKE_ENGINE_IMAGES=${JSON.stringify({ [template]: bin })}`, process.execPath, executable,
    ],
    options: provider === 'docker' ? { provider, image: template } : { provider, agent: template },
  };
}
