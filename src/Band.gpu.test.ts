import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BufferGeometry, BufferAttribute, RenderTarget } from 'three/webgpu'
import { ChartSession, createFigure, gridDomain, meshDomain, isParametric } from './index'
import { assertWebGPU, hasWebGPU } from './testing/gpu'

/* eslint-disable @typescript-eslint/no-explicit-any */

const W = 160, H = 160

describe('Band — a region between two boundaries', () => {
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

  const ramp = (n: number, f: (t: number) => number) =>
    new Float32Array(n).map((_, i) => f(i / (n - 1)))

  it('fills the region under a curve', async () => {
    const N = 64
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const g = gridDomain({ nx: N, ny: 1, x: [0, 1], y: [0, 1] })
    ax.band(g, ramp(N, (t) => 0.2 + 0.7 * Math.sin(t * Math.PI)), { color: 0xffffff })
    // A half-sine over a unit box fills roughly half of the plot area.
    const c = await coverage(ax)
    expect(c).toBeGreaterThan(0.15)
    expect(c).toBeLessThan(0.75)
    fig.dispose()
  })

  it('fills LESS when the upper boundary is lower', async () => {
    const N = 32
    const build = async (h: number) => {
      const fig = await createFigure({ container, session })
      const ax = fig.axes()
      ax.band(gridDomain({ nx: N, ny: 1, x: [0, 1], y: [0, 1] }),
        new Float32Array(N).fill(h), { color: 0xffffff })
      const c = await coverage(ax)
      fig.dispose()
      return c
    }
    const [low, high] = [await build(0.2), await build(0.9)]
    expect(high).toBeGreaterThan(low * 2)
  })

  /**
   * The capability check earning its keep. A band across an unstructured vertex
   * set has no meaning — there is no "between" two arbitrary vertices — so this
   * must be refused rather than drawn as something plausible-looking and wrong.
   */
  it('refuses a domain that cannot be addressed between its samples', async () => {
    const geom = new BufferGeometry()
    geom.setAttribute('position', new BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3))
    const mesh = meshDomain(geom)

    expect(isParametric(mesh)).toBe(false)
    expect(isParametric(gridDomain({ nx: 4, ny: 4 }))).toBe(true)

    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    expect(() => ax.band(mesh, new Float32Array(3)))
      .toThrow(/cannot be addressed between its samples/)
    fig.dispose()
  })

  /**
   * Pins the defaulting decision, and it is a decision rather than a detail.
   *
   * `valueRange` defaults to `[0, 1]` — normalised — NOT to the domain's y extent.
   * Deriving it from the bounding box works only for Cartesian domains: a polar
   * disc of radius 1 has `ylim [-1, 1]`, so a boundary of 0 landed at v = 0.5 and
   * the fill started halfway out, leaving a hole. A default that is right for one
   * domain shape and silently wrong for another is worse than no default.
   */
  it('maps boundary values through a NORMALISED range, not the y extent', async () => {
    const N = 16
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    // y extent is [-1, 1]; a constant boundary of 1 must fill the TOP half, not
    // the whole box — which is what it would do if 1 were read against [-1, 1].
    const g = gridDomain({ nx: N, ny: 1, x: [0, 1], y: [-1, 1] })
    ax.band(g, new Float32Array(N).fill(1), { lower: 0, color: 0xffffff })
    const half = await coverage(ax)

    fig.dispose()
    const fig2 = await createFigure({ container, session })
    const ax2 = fig2.axes()
    ax2.band(gridDomain({ nx: N, ny: 1, x: [0, 1], y: [-1, 1] }),
      new Float32Array(N).fill(0.5), { lower: 0, color: 0xffffff })
    const quarter = await coverage(ax2)

    // Half the box against a quarter of it — the ratio a normalised mapping gives.
    expect(half).toBeGreaterThan(quarter * 1.6)
    fig2.dispose()
  })
})
