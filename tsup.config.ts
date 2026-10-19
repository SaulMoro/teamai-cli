import { readFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

// simple-git settles a command on `close`, or 50 ms after `exit` when `close`
// never comes (a grandchild such as an ssh ControlPersist master holding the
// pipe). That 50 ms timer is left running after `close` wins, so a command
// that ends on its own waited up to 50 ms after its last git call. Unref'd, it
// no longer holds the process; a held pipe still keeps it alive until it fires.
const SIMPLE_GIT_EXIT_FALLBACK = '(flag === true ? event.promise : event.promise.then(() => delay(flag))).then(timeout.done);';
const simpleGitExitFallbackUnref: Plugin = {
  name: 'simple-git-exit-fallback-unref',
  setup(build) {
    build.onLoad({ filter: /[\\/]simple-git[\\/]dist[\\/]esm[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (!source.includes(SIMPLE_GIT_EXIT_FALLBACK)) {
        throw new Error(`simple-git changed its completion plugin: re-check the exit fallback patch in tsup.config.ts (${args.path})`);
      }
      return {
        contents: source.replace(SIMPLE_GIT_EXIT_FALLBACK, '(flag === true ? event.promise : event.promise.then(() => new Promise((done) => setTimeout(done, flag).unref()))).then(timeout.done);'),
        loader: 'js',
      };
    });
  },
};

export default defineConfig({
  // `index` is the executable: it turns on Node's compile cache, then loads
  // `cli`, the CLI itself, which the cache can only cover as a separate file.
  entry: { index: 'src/bin.ts', cli: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  // Dependencies go into the bundle too: loading each from node_modules
  // (resolve, read, compile) was about a third of a short command's startup,
  // and the compile cache covers one file whole. web-tree-sitter stays out:
  // it loads its .wasm from its own package directory.
  noExternal: [/^(?!web-tree-sitter$)/],
  esbuildPlugins: [simpleGitExitFallbackUnref],
  banner: {
    // `require` for the CommonJS dependencies bundled into this ES module.
    js: "#!/usr/bin/env node\nimport { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);",
  },
});
