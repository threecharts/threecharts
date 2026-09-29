import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

/**
 * Dev server for `examples/`.
 *
 * The alias resolves the package by NAME, so the examples import exactly what a
 * consumer would and a missing export breaks them here rather than after
 * publishing. `publicDir` points at the colormap atlas the package ships, which is
 * what `loadAllColormapLibraries('/colormaps')` fetches.
 */
export default defineConfig({
  root: 'examples',
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  // See vitest.config.ts: without this, the alias is baked into a pre-bundled copy
  // and `examples/` renders a stale library.
  optimizeDeps: { exclude: ['threecharts', 'threecharts/testing'] },
  resolve: {
    alias: {
      'threecharts/testing': fileURLToPath(new URL('./src/testing/index.ts', import.meta.url)),
      'threecharts': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
})
