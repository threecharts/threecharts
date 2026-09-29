import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PlaneGeometry, RenderTarget } from 'three/webgpu'
import { ChartSession, createFigure, gridDomain } from './index'
import { assertWebGPU, hasWebGPU } from './testing/gpu'

/* eslint-disable @typescript-eslint/no-explicit-any */

const W = 160, H = 160

/** A unit quad growing UPWARD from its address — a bar. */
function barGeometry(width = 0.7): PlaneGeometry {
  const g = new PlaneGeometry(width, 1)
  g.translate(0, 0.5, 0)          // origin at the base, so scaling y grows upward
  return g
}

describe('Glyphs — the general mark', () => {
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

  /**
   * The worked case: a user hands over `[rows × time]`, values in rows and time
   * along columns — how a recording is stored. Producing a time-varying bar chart
   * must be ONE upload plus one uniform write per frame, not a re-upload.
   */
  it('draws a time-varying bar chart from [rows × time] data', async () => {
    const R = 6, T = 20
    const v = new Float32Array(R * T)
    for (let r = 0; r < R; r++) {
      for (let t = 0; t < T; t++) v[r * T + t] = 0.2 + 0.8 * Math.abs(Math.sin((r + t) * 0.4))
    }

    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const bars = ax.glyphs(barGeometry(), gridDomain({ nx: R, ny: 1, x: [0, R], y: [0, 1] }), {
      baseline: 0, size: v, frames: T, layout: 'row-major',
      values: v, clim: [0, 1], timepoint: 0,
    })

    expect(bars.domain.count).toBe(R)
    const first = await coverage(ax)
    expect(first).toBeGreaterThan(0.02)

    fig.dispose()
  })

  /**
   * The animation, and the property that makes this worth building this way:
   * moving ONE uniform changes what every glyph reads. Nothing is re-uploaded and
   * no node is rebuilt — the picture changes because a number changed.
   */
  it('animates by moving a uniform, not by re-uploading', async () => {
    const R = 8, T = 4
    // Short bars in the first two slices, tall ones in the last two, so the two
    // readings below cannot coincidentally agree.
    const v = new Float32Array(R * T)
    for (let r = 0; r < R; r++) {
      v[r * T + 0] = 0.05; v[r * T + 1] = 0.05
      v[r * T + 2] = 1.00; v[r * T + 3] = 1.00
    }

    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const bars = ax.glyphs(barGeometry(), gridDomain({ nx: R, ny: 1, x: [0, R], y: [0, 1] }), {
      baseline: 0, size: v, frames: T, layout: 'row-major', color: 0xffffff, timepoint: 0,
    })

    const short = await coverage(ax)
    bars.timepoint.value = 3          // the entire per-frame cost
    const tall = await coverage(ax)

    expect(short).toBeGreaterThan(0)
    expect(tall).toBeGreaterThan(short * 3)
    fig.dispose()
  })

  /**
   * The bug the box-plot exercise found, pinned.
   *
   * Without `baseline`, a glyph sits at `positionAt(i)` — the cell CENTRE of the
   * second extent. For a bar over `y: [0, 1]` that is 0.5, so the bars floated in
   * the upper half and nothing said so. With `baseline: 0` they sit on the axis.
   *
   * Measured as coverage: bars rising from zero cover strictly more than the same
   * bars rising from the middle, because the lower half is now filled.
   */
  it('sits on a baseline rather than on the cell centre', async () => {
    const R = 8
    const v = new Float32Array(R).fill(0.9)
    const g = () => gridDomain({ nx: R, ny: 1, x: [0, R], y: [0, 1] })

    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    ax.glyphs(barGeometry(), g(), { baseline: 0, size: v, color: 0xffffff })
    const fromZero = await coverage(ax)
    fig.dispose()

    const fig2 = await createFigure({ container, session })
    const ax2 = fig2.axes()
    ax2.glyphs(barGeometry(), g(), { size: v, sizeMode: 'y', color: 0xffffff })
    const fromCentre = await coverage(ax2)
    fig2.dispose()

    expect(fromZero).toBeGreaterThan(fromCentre * 1.5)
  })

  /** `baseline` places at a VALUE, which a mesh has no way to express. */
  it('refuses a baseline on a domain it cannot address continuously', async () => {
    const { BufferGeometry, BufferAttribute } = await import('three/webgpu')
    const { meshDomain } = await import('./index')
    const geom = new BufferGeometry()
    geom.setAttribute('position', new BufferAttribute(new Float32Array(9), 3))

    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    expect(() => ax.glyphs(barGeometry(), meshDomain(geom), { baseline: 0 }))
      .toThrow(/needs a domain that can be addressed between its samples/)
    fig.dispose()
  })
})
