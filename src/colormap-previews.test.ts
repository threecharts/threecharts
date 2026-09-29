// @vitest-environment node
/**
 * Wire-format guard for the colormap atlas that SHIPS WITH THIS PACKAGE
 * (`public/colormaps`). A row index is the wire format — every stored layer
 * config pins to it — so the head of the library may never shift.
 *
 * Lives here because the atlas lives here. It moved from `@nxr/charts-webgpu`
 * along with the atlas itself when the frontend-root mirror was retired.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DEFAULT_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/colormaps/default/colormaps.json',
)
/** The v1 palette, indices 0-19. Row index IS the wire format — every
 *  layer config pins to it — so these must never move. The library is
 *  APPEND-only: entries beyond 19 may grow, these may not shift. */
const PINNED_HEAD = [
  'viridis','magma','plasma','inferno','cividis','turbo','thermal','haline','ice','amp',
  'coolwarm','RdBu_r','BrBG','balance','delta','curl','twilight','phase','tab10','Set2',
]

describe('default colormap library — stored previews', () => {
  const manifest = JSON.parse(readFileSync(DEFAULT_JSON, 'utf8'))

  it('keeps the v1 palette pinned at indices 0-19', () => {
    expect(manifest.colormaps.length).toBeGreaterThanOrEqual(PINNED_HEAD.length)
    for (let i = 0; i < PINNED_HEAD.length; i++) {
      expect(manifest.colormaps[i].index).toBe(i)
      expect(manifest.colormaps[i].name).toBe(PINNED_HEAD[i])
    }
  })

  it('indices are contiguous from 0 and match the baked row count', () => {
    manifest.colormaps.forEach((e: { index: number }, i: number) => expect(e.index).toBe(i))
    expect(manifest.rows).toBe(manifest.colormaps.length)
  })

  it('every row declares one of the four known types', () => {
    const types = new Set(['sequential', 'diverging', 'cyclic', 'categorical'])
    for (const e of manifest.colormaps) expect(types.has(e.type), `${e.name}: ${e.type}`).toBe(true)
  })

  it('every row has a 12-stop linear-gradient preview', () => {
    for (const e of manifest.colormaps) {
      expect(e.preview, e.name).toMatch(/^linear-gradient\(90deg, /)
      expect(e.preview.match(/rgb\(/g)).toHaveLength(12)
      expect(e.preview).toMatch(/0%/)
      expect(e.preview).toMatch(/100%\)$/)
    }
  })
})
