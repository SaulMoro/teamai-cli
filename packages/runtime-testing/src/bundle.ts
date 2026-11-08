import { build, type BuildOptions } from 'esbuild';

/**
 * Builds the runtime whose entry is `entry` into `outfile`, as tsup bundles it into teamai-cli, and returns its path:
 * one ESM file with its packages inside, which `require` still works in. What a test swaps in: `alias` replaces a
 * package with a stand-in, and `plugins` a module of the runtime's own, which an alias cannot name.
 */
export async function bundleRuntime({ entry, outfile, alias, plugins }: { entry: string; outfile: string } & Pick<BuildOptions, 'alias' | 'plugins'>): Promise<string> {
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    ...(alias && { alias }), ...(plugins && { plugins }),
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });

  return outfile;
}
