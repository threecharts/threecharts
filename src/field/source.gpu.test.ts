import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RenderTarget } from 'three/webgpu'
import { assertWebGPU, hasWebGPU } from '../testing/gpu'
import { ChartSession } from '../ChartSession'
import { createFigure } from '../Figure'
import { gridDomain } from '../domain/gridDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The point of `FieldSource`, tested the way a user would meet it.
 *
 * **This file imports nothing from `three/tsl`.** That is the assertion — not a
 * stylistic choice. Until now, drawing anything meant calling
 * `attributeArray(v, 'float')` from a package the user never installed, using an
 * element-type string whose wrong value corrupts silently on rewrite. TSL remains
 * the implementation; it is simply no longer the entry fee.
 */
const W = 96, H = 96

describe('a chart from a plain typed array', () => {
  let session: ChartSession
  let container: HTMLElement
  let target: RenderTarget

  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    session = new ChartSession()
    await session.init()
    /* CALLED for its refusal, not its value: assertWebGPU throws on the WebGL2
       fallback, and a suite that silently ran there would pass on a renderer it was
       never meant to test. */
    assertWebGPU(session.renderer)
    container = document.createElement('div')
    Object.assign(container.style, { width: `${W}px`, height: `${H}px` })
    document.body.appendChild(container)
    target = new RenderTarget(W, H)
  })
  afterAll(() => { target?.dispose(); session?.dispose(); container?.remove() })

  const ramp = (n: number) => new Float32Array(n).map((_, i) => i / (n - 1))

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
   * The control, and it is what makes every threshold below mean something:
   * without it, "coverage > 0.04" could be measuring chrome, a clear colour, or an
   * uninitialised target rather than a raster.
   */
  it('renders an empty axes as clear colour', async () => {
    const fig = await createFigure({ container, session })
    expect(await coverage(fig.axes())).toBeLessThan(0.01)
    fig.dispose()
  })

  it('draws, with no GPU vocabulary anywhere in the caller', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    ax.colormap = 'viridis'
    ax.image(ramp(32 * 32), gridDomain({ nx: 32, ny: 32, x: [0, 32], y: [0, 32] }), { clim: [0, 1] })
    /* Measured 0.0764 against 0.0000 for the empty control. Lower than the
       render smoke test's figure because a LINEAR ramp puts half its values in
       viridis's dark end, under the 8/255 ink cutoff — the threshold is set from
       the measurement rather than from an intuition about how full the plot looks. */
    expect(await coverage(ax)).toBeGreaterThan(0.04)
    fig.dispose()
  })

  /**
   * A caller's array is COPIED, not referenced. Mutating it afterwards must not
   * silently change what is drawn — the same decision MATLAB makes when `plot`
   * captures its arguments, and what makes a chart's data predictable.
   */
  it('copies the caller array rather than aliasing it', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const mine = ramp(16 * 16)
    const img = ax.image(mine, gridDomain({ nx: 16, ny: 16, x: [0, 16], y: [0, 16] }), { clim: [0, 1] })
    mine.fill(0)                                  // vandalise the caller's copy
    expect(await coverage(ax)).toBeGreaterThan(0.04)   // the chart is unaffected
    expect(img.ownsData).toBe(true)
    fig.dispose()
  })

  it('lets an owner rewrite the values in place', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const img = ax.image(new Float32Array(16 * 16), gridDomain({ nx: 16, ny: 16, x: [0, 16], y: [0, 16] }), { clim: [0, 1] })
    img.setData(ramp(16 * 16))
    expect(await coverage(ax)).toBeGreaterThan(0.04)
    fig.dispose()
  })

  it('refuses to write a buffer it does not own', async () => {
    // The only place a test needs the expert path — and it is still available.
    const { attributeArray } = await import('three/tsl') as any
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const img = ax.image(attributeArray(ramp(64), 'float'), gridDomain({ nx: 8, ny: 8, x: [0, 8], y: [0, 8] }))
    expect(img.ownsData).toBe(false)
    expect(() => img.setData(new Float32Array(64))).toThrow(/externally owned/)
    fig.dispose()
  })

  /**
   * A type that says `FieldSource` must be backed by an implementation that
   * resolves one. Declaring the option and then calling `asReadOnly` on it would
   * compile perfectly and hand the shader a raw `Float32Array` — a promise made in
   * the signature and broken in the body, which is a worse failure than `unknown`
   * because the caller has been told it works.
   */
  it('honours FieldSource on the OPTIONAL fields too', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes({ projection: '3d' })
    const N = 24
    /* Real values, not zeros. All-zero vectors draw zero-length arrows and all-zero
       positions stack every point on the origin — the constructors would still
       accept the arrays and the coverage assertion would still read 0, testing
       nothing. */
    const spread = new Float32Array(N * 3)
    const vectors = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      spread[i * 3] = Math.cos(a); spread[i * 3 + 1] = Math.sin(a); spread[i * 3 + 2] = 0
      vectors[i * 3] = -Math.sin(a); vectors[i * 3 + 1] = Math.cos(a); vectors[i * 3 + 2] = 0
    }
    const ones = new Float32Array(N).fill(1)

    // Quiver: vectors, plus a separate colour field and length field.
    expect(() => ax.quiver(vectors, N, 1, {
      dims: 3, values: ones, lengths: ones, clim: [0, 1], scale: 0.4,
      xExtent: [-1, 1], yExtent: [-1, 1], zExtent: [-1, 1],
    })).not.toThrow()

    // Particles: positions, plus per-point size and colour fields.
    expect(() => ax.particles(spread, N, {
      dims: 3, sizes: ones, values: ones,
      xExtent: [-1, 1], yExtent: [-1, 1], zExtent: [-1, 1],
    })).not.toThrow()

    expect(await coverage(ax)).toBeGreaterThan(0.01)
    fig.dispose()
  })
})
