import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

/**
 * TWO suites, because they answer different questions at very different costs.
 *
 * `unit` — Node, no GPU, ~0.7 s for the whole file set. Pure logic: tick
 * selection, envelope bucketing, limit arithmetic, layout rects. This is what
 * runs on every save.
 *
 * `gpu` — a real WebGPU device in headless Chromium. It exists because the
 * library's actual output is buffers written by shaders, and NOTHING in the unit
 * suite can observe one. Nothing there would catch a drawable whose positions
 * are computed wrongly, a compute pass that writes the wrong slice, or a domain
 * reporting the wrong bounds.
 *
 * **Assert on BUFFER READBACKS, not on pixels.** Rasterisation differs by driver
 * and platform, so a screenshot comparison is flaky and — more to the point —
 * usually not what is in question. What is in question is a number: where a
 * vertex landed, what a reduction summed to, what extent a domain reported.
 * Those are read back exactly and compared exactly. Pixel comparison is reserved
 * for the few regressions that are genuinely about appearance, and it belongs
 * behind a tolerance.
 *
 * The flags are not optional: WebGPU requires a SECURE CONTEXT (Vite serves over
 * localhost, which qualifies — `about:blank` does not), and headless Chromium
 * hands out no adapter without `--enable-unsafe-webgpu`.
 */
/**
 * WebGPU needs a SECURE CONTEXT (Vite's localhost qualifies; `about:blank` does
 * not) and headless Chromium hands out no adapter without `--enable-unsafe-webgpu`.
 *
 * `WEBGPU_SOFTWARE=1` swaps the hardware adapter for SwiftShader, Chromium's
 * software rasteriser. CI runners have no GPU, and a GPU suite that can only run
 * on a developer's machine is a suite that rots — so the flag exists to keep the
 * same tests meaningful there. Verified to report the same limits and pass the
 * same assertions as the Metal adapter, at lower speed.
 */
const CHROMIUM_ARGS = process.env.WEBGPU_SOFTWARE
  /* `--enable-unsafe-swiftshader` ALONE. Adding `--use-angle=swiftshader
     --use-gl=angle` also produces a SwiftShader adapter, but it routes Chromium
     through the GL path and WebGPU stops initialising — three then silently falls
     back to its WebGL2 backend and the whole suite passes on a renderer it was
     never meant to test. `gpuHarness` now refuses that fallback outright; these
     flags are what make it unnecessary. */
  ? ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader']
  : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal']

/* `contrib/` imports the package BY NAME, never by a relative path into `src/`.
   That is the whole point of it: if a contributed extension needs something the
   public entry does not export, the import fails and the extensibility claim is
   falsified — rather than being quietly rescued by a deep import nobody outside
   this repo could write.

   **It resolves to `dist/`, not to `src/`** — through this package's own `exports`
   map, exactly as a consumer's would. (A top-level `resolve.alias` does NOT reach
   here: with `projects`, each project gets its own resolver. `vite.config.ts` keeps
   an alias so `examples/` hot-reloads from source; this suite deliberately does
   not.) Testing the built bundle is the MORE faithful choice for `contrib/`, since
   it exercises the real exports map, the declared subpaths and the generated types.

   It also makes the build a PREREQUISITE, which `test:gpu` now runs — and that is
   not optional. Without it, a renamed method kept resolving to the old one and
   every test stayed green. A suite that silently tests a frozen copy is worse than
   one that fails. */

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.gpu.test.ts'],
        },
      },
      {
        test: {
          name: 'gpu',
          include: ['src/**/*.gpu.test.ts', 'contrib/**/*.gpu.test.ts'],
          browser: {
            enabled: true,
            provider: playwright({ launchOptions: { args: CHROMIUM_ARGS } }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
