import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RenderTarget } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray } from 'three/tsl'
import { assertWebGPU, hasWebGPU } from './testing/gpu'
import { ChartSession } from './ChartSession'
import { createFigure } from './Figure'
import { gridDomain } from './domain/gridDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Does anything actually appear?
 *
 * Every other GPU test here reads a BUFFER — where a vertex landed, what a
 * reduction summed to — which is the right way to ask most questions, because the
 * answers are numbers and compare exactly. But it leaves one question unasked, and
 * it is the one a user notices first: after a refactor, does the scene still draw?
 * A drawable can compute perfect positions into a scene that never renders, and
 * every buffer assertion would still pass.
 *
 * **Rendered into a RenderTarget, not read off the canvas.** A WebGPU canvas is
 * PRESENTED: its texture belongs to the compositor, so reading it back races the
 * browser. Drawing it into a 2-D canvas immediately after `renderFrame()` happened
 * to work on a discrete adapter and returned an empty image every time under
 * SwiftShader — and adding an `await` to fix that made it empty on BOTH, because
 * the wait is precisely when the swap occurs. A render target is owned by us and
 * has no such race. The cost is that this covers the drawable, scene and camera
 * rather than the figure's viewport composition; the regression it exists to catch
 * — "nothing draws any more" — lives in the part it does cover.
 *
 * It deliberately does not compare against a stored baseline. Rasterisation
 * differs by driver, so a baseline is either per-machine or perpetually stale, and
 * "2,317 pixels differ" rarely says what broke. It asserts properties a gross
 * regression violates and a legitimate change does not.
 */
const W = 128, H = 128

interface Ink {
  /** Fraction of pixels differing from the clear colour. */
  coverage: number
  /** Brightest channel seen, 0..255. */
  peak: number
}

function ink(px: Uint8Array | Float32Array): Ink {
  const scale = px instanceof Float32Array ? 255 : 1
  let lit = 0, n = 0, peak = 0
  for (let i = 0; i < px.length; i += 4, n++) {
    const r = px[i] * scale, g = px[i + 1] * scale, b = px[i + 2] * scale
    const m = Math.max(r, g, b)
    if (m > peak) peak = m
    if (m > 8) lit++
  }
  return { coverage: lit / n, peak }
}

describe('rendering', () => {
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

  /** Draw one axes into our own target and bring the pixels back. */
  async function draw(ax: any): Promise<Ink> {
    const r = session.renderer
    ax.syncFrame()
    r.setRenderTarget(target)
    r.clear()
    r.render(ax.scene, ax.camera)
    r.setRenderTarget(null)
    return ink(await (r as any).readRenderTargetPixelsAsync(target, 0, 0, W, H))
  }

  it('draws a colormapped raster', async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    ax.colormap = 'viridis'

    // A ramp across the grid, so the raster cannot be a single flat colour.
    const R = 16, C = 16
    const values = new Float32Array(R * C)
    for (let i = 0; i < values.length; i++) values[i] = i / (values.length - 1)
    ax.image(attributeArray(values, 'float'), gridDomain({ nx: C, ny: R, x: [0, C], y: [0, R] }), { clim: [0, 1] })

    const { coverage, peak } = await draw(ax)
    /* ~0.24, and identical on Metal and SwiftShader — the render target is what
       makes that reproducible. It is not ~0.6 because the axes insets the plot box
       by its ruler margins AND because viridis's low end is dark enough to fall
       under the 8/255 cutoff, so the bottom of the ramp reads as background. */
    expect(coverage).toBeGreaterThan(0.15)
    /* Coverage alone would pass on a flat fill. The peak proves the ramp reached
       the BRIGHT end of the colormap — that values were mapped, not merely that
       geometry was drawn. */
    expect(peak).toBeGreaterThan(200)
    fig.dispose()
  })

  /**
   * The control. Without it, a coverage threshold could be measuring a background, a
   * clear colour, or an uninitialised target rather than a drawable.
   */
  it('renders an empty axes as clear colour', async () => {
    const fig = await createFigure({ container, session })
    const { coverage } = await draw(fig.axes())
    expect(coverage).toBeLessThan(0.02)
    fig.dispose()
  })
})
