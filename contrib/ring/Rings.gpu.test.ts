import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RenderTarget } from 'three/webgpu'
import { ChartSession, createFigure, gridDomain } from 'threecharts'
import { assertWebGPU, hasWebGPU } from 'threecharts/testing'
import { Rings } from './Rings'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The second extension axis, answered.
 *
 * `contrib/polar` proved a third party can add a GEOMETRY. This proves they can
 * author a DRAWABLE — a visual mark the library does not contain — using nothing
 * but the public entry, and that an `Axes` will render it alongside built-in marks
 * without knowing what it is.
 */
const W = 128, H = 128

describe('Rings — a visual mark authored outside the library', () => {
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

  it('draws, and the axes frames on it without knowing what it is', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const grid = gridDomain({ nx: 5, ny: 5, x: [0, 10], y: [0, 10] })

    // A plain Float32Array of radii — the same entry a built-in mark accepts.
    const radii = new Float32Array(grid.count).map((_, i) => 0.4 + (i % 5) * 0.18)
    const rings = ax.addDrawable(new Rings(ax, grid, { radii, radius: 1 }))

    // The axes treats it as any other drawable: it contributes auto-limits...
    expect(rings.dataBounds()).toEqual(grid.bounds())
    ax.syncFrame()
    expect(ax.xlim).toEqual([0, 10])

    // ...and it actually renders.
    expect(await coverage(ax)).toBeGreaterThan(0.02)
    fig.dispose()
  })

  it('participates in disposal like any other drawable', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const rings = ax.addDrawable(new Rings(ax, gridDomain({ nx: 3, ny: 3 })))
    expect(ax.drawables).toContain(rings)
    ax.removeDrawable(rings)
    expect(ax.drawables).not.toContain(rings)
    fig.dispose()
  })
})
