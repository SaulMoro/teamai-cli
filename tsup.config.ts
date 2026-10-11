import { defineConfig } from 'tsup';

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
  banner: {
    js: '#!/usr/bin/env node',
  },
});
