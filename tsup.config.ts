import { defineConfig } from 'tsup'

/**
 * Build — ESM + type declarations, `three` left external.
 *
 * BUNDLED rather than emitted file-per-file, and that is the whole reason this
 * config exists instead of a plain `tsc -p tsconfig.build.json`. The sources
 * import each other extensionlessly (`from './Axes'`), which `tsc` emits
 * verbatim — and real Node ESM rejects an extensionless specifier, so a
 * `tsc`-emitted build would import cleanly in a bundler and fail outright under
 * `node`. Headless operation in Node is a stated requirement, so that failure
 * mode is not acceptable.
 *
 * The alternative is adding `.js` to every relative import across 84 files. That
 * is the more standard fix and it stays available — nothing here forecloses it —
 * but it churns every source file, and doing that immediately before the domain
 * restructuring would bury a real diff in a mechanical one.
 */
export default defineConfig({
  // `testing` is a second entry, not a deep import: see src/testing/index.ts.
  entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['three', 'three/webgpu', 'three/tsl'],
})
