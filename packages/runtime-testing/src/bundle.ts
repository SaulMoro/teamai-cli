import { build, stop, type BuildOptions } from 'esbuild';

/** Builds of this module still running: esbuild's service, which they share, stops once none is. */
let building = 0;

/**
 * Builds the runtime whose entry is `entry` into `outfile`, as tsup bundles it into teamai-cli, and returns its path:
 * one ESM file with its packages inside, which `require` still works in. What a test swaps in: `alias` replaces a
 * package with a stand-in, and `plugins` a module of the runtime's own, which an alias cannot name. It leaves no
 * process running: esbuild keeps its service for the next build, which would outlive the test that bundled.
 */
export async function bundleRuntime({ entry, outfile, alias, plugins }: { entry: string; outfile: string } & Pick<BuildOptions, 'alias' | 'plugins'>): Promise<string> {
  building += 1;

  try {
    await build({
      entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
      ...(alias && { alias }), ...(plugins && { plugins }),
      banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
    });
  } finally {
    building -= 1;

    if (building === 0) await stop();
  }

  return outfile;
}
