import { build } from 'esbuild';

/**
 * Builds the runtime whose entry is `entry` into `outfile`, as tsup bundles it into teamai-cli, and returns its path:
 * one ESM file with its packages inside, which `require` still works in.
 */
export async function bundleRuntime({ entry, outfile }: { entry: string; outfile: string }): Promise<string> {
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });

  return outfile;
}
