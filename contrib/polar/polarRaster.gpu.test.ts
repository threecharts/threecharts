import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RenderTarget } from 'three/webgpu'
import { ChartSession, createFigure, gridDomain } from 'threecharts'
import { assertWebGPU, hasWebGPU } from 'threecharts/testing'
import { polarDomain } from './polarDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

const S = 128

/**
 * The same `Image` on a contributed polar domain — a radial heatmap, which is a
 * standard time-frequency figure and was impossible while a raster was one quad.
 */
describe('Image on a polar domain', () => {
  let session: ChartSession
  let container: HTMLElement
  let target: RenderTarget

  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    session = new ChartSession()
    await session.init()
    assertWebGPU(session.renderer)
    container = document.createElement('div')
    Object.assign(container.style, { width: `${S}px`, height: `${S}px` })
    document.body.appendChild(container)
    target = new RenderTarget(S, S)
  })
  afterAll(() => { target?.dispose(); session?.dispose(); container?.remove() })

  /** Render and return the pixel buffer plus a helper to test a point. */
  async function shot(ax: any) {
    const r = session.renderer
    ax.syncFrame()
    r.setRenderTarget(target); r.clear(); r.render(ax.scene, ax.camera); r.setRenderTarget(null)
    const px = await (r as any).readRenderTargetPixelsAsync(target, 0, 0, S, S)
    const sc = px instanceof Float32Array ? 255 : 1
    const lit = (x: number, y: number) => {
      const i = ((y * S) + x) * 4
      return Math.max(px[i], px[i + 1], px[i + 2]) * sc > 8
    }
    let n = 0
    for (let i = 0; i < px.length; i += 4) {
      if (Math.max(px[i], px[i + 1], px[i + 2]) * sc > 8) n++
    }
    return { lit, coverage: n / (px.length / 4) }
  }

  /** `[nRadius][nTheta]` row-major — rows are radii, columns are angles. */
  const values = (nr: number, nt: number) =>
    new Float32Array(nr * nt).map((_, i) => (i % nt) / nt)

  it('draws a DISC, not a bowtie — the corners stay empty', async () => {
    const nr = 24, nt = 96
    const fig = await createFigure({ container, session })
    // dataAspect 1 so the disc is round and the corner test means something.
    const ax = fig.axes({ dataAspect: 1, xlim: [-1, 1], ylim: [-1, 1] })
    ax.colormap = 'viridis'
    ax.image(values(nr, nt), polarDomain([nt, nr], { radius: [0, 1], angle: [0, Math.PI * 2] }) as any,
      { clim: [0, 1] })

    const { lit, coverage } = await shot(ax)

    // Centre filled; all four corners of the plot box empty. A bowtie or a quad
    // would light at least one corner, and a blank render would fail the centre.
    expect(lit(S >> 1, S >> 1)).toBe(true)
    const m = 6
    for (const [x, y] of [[m, m], [S - m, m], [m, S - m], [S - m, S - m]]) {
      expect(lit(x, y), `corner ${x},${y} should be empty`).toBe(false)
    }
    /* Measured 0.161. A disc inscribed in the plot box is π/4 of it, and on a
       128 px canvas the ruler margins (52 left, 18 right, 44 bottom) leave only
       about a quarter of the frame — so ~0.19 expected, ~0.16 observed. The
       CORNER test above is what discriminates a disc from a rectangle; this only
       has to rule out "nothing drew" and "everything drew". */
    expect(coverage).toBeGreaterThan(0.08)
    expect(coverage).toBeLessThan(0.45)
    fig.dispose()
  })

  it('still draws a rectangle on a lattice — one quad remains exact', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes({ xlim: [0, 1], ylim: [0, 1] })
    ax.colormap = 'viridis'
    ax.image(values(8, 8), gridDomain({ nx: 8, ny: 8, x: [0, 1], y: [0, 1] }), { clim: [0, 1] })
    const { lit } = await shot(ax)
    // A rectangle DOES reach its corners — the affine path is unchanged.
    expect(lit(S >> 1, S >> 1)).toBe(true)
    fig.dispose()
  })
})
