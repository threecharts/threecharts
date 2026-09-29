import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RenderTarget } from 'three/webgpu'
import { ChartSession, createFigure } from 'threecharts'
import { assertWebGPU, hasWebGPU } from 'threecharts/testing'
import { boxPlot, type BoxStats } from './boxPlot'

/* eslint-disable @typescript-eslint/no-explicit-any */

const W = 200, H = 200

/**
 * The THIRD extension axis, and the last one without evidence.
 *
 * `contrib/polar` proved a third party can add a geometry; `contrib/ring` proved
 * they can author a visual mark. This asks whether they can compose a CHART —
 * several drawables plus arrangement logic — from the public entry alone.
 */
describe('boxPlot — a chart composed outside the library', () => {
  let session: ChartSession
  let container: HTMLElement
  let target: RenderTarget

  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    session = new ChartSession()
    await session.init()
    assertWebGPU(session.renderer)
    container = document.createElement('div')
    Object.assign(container.style, { width: `${W}px`, height: `${H}px` })
    document.body.appendChild(container)
    target = new RenderTarget(W, H)
  })
  afterAll(() => { target?.dispose(); session?.dispose(); container?.remove() })

  async function coverage(ax: any): Promise<number> {
    const r = session.renderer
    ax.syncFrame()
    r.setRenderTarget(target); r.clear(); r.render(ax.scene, ax.camera); r.setRenderTarget(null)
    const px = await (r as any).readRenderTargetPixelsAsync(target, 0, 0, W, H)
    const scale = px instanceof Float32Array ? 255 : 1
    let lit = 0, n = 0
    for (let i = 0; i < px.length; i += 4, n++) {
      if (Math.max(px[i], px[i + 1], px[i + 2]) * scale > 8) lit++
    }
    return lit / n
  }

  const stats: BoxStats[] = [
    { low: 0.5, q1: 1.8, median: 2.6, q3: 3.4, high: 4.6 },
    { low: 1.2, q1: 2.6, median: 3.1, q3: 3.9, high: 5.4 },
    { low: 0.2, q1: 1.1, median: 2.0, q3: 3.2, high: 4.9 },
    { low: 2.0, q1: 3.0, median: 3.6, q3: 4.2, high: 5.1 },
  ]

  it('composes four layers and draws them', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const plot = boxPlot(ax, stats)

    // Five drawables, all on one lattice — the composition itself.
    expect(ax.drawables).toHaveLength(5)
    expect(plot.boxes.domain).toBe(plot.whiskers.domain)

    expect(await coverage(ax)).toBeGreaterThan(0.03)
    fig.dispose()
  })

  it('frames the axes across the whole whisker range', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    boxPlot(ax, stats)
    ax.syncFrame()
    // The lattice was built over min(low)..max(high), so the axes frames the data
    // rather than the boxes alone.
    expect(ax.ylim[0]).toBeCloseTo(0.2, 5)
    expect(ax.ylim[1]).toBeCloseTo(5.4, 5)
    fig.dispose()
  })

  it('draws wider boxes as more ink', async () => {
    const build = async (width: number) => {
      const fig = await createFigure({ container, session })
      const ax = fig.axes()
      boxPlot(ax, stats, { width })
      const c = await coverage(ax)
      fig.dispose()
      return c
    }
    expect(await build(0.9)).toBeGreaterThan(await build(0.3))
  })
})
