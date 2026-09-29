import { describe, it, expect } from 'vitest'
import { Axes } from './Axes'
import type { Limits } from './limits'

/**
 * `Axes.dataAspect` — the 2D data-to-pixel scale lock.
 *
 * Its failure mode is the reason it is tested at all: an axes with NO lock draws
 * a perfectly sharp, perfectly plausible picture in the wrong proportions, and
 * nothing on screen says so. The distortion is set by the VIEWPORT, so it also
 * changes as the window is resized — which is what a reader notices, long after
 * having measured something off it.
 *
 * A real `Axes` needs a WebGPU device, so — following `Axes.dispose.test.ts` and
 * `Figure.removeAxes.test.ts` — this invokes the real prototype methods against a
 * stand-in holding only the fields `framed()` reads. `dataToScreen` is the
 * observable: it runs through `framed()`, which is the one place the lock is
 * applied, and it is what the crosshair, the click handler and `attachPanZoom`
 * all go through, so an assertion here covers every consumer.
 */
const MARGINS = { top: 16, right: 18, bottom: 44, left: 52 }

function host(o: {
  w: number; h: number; xlim: Limits; ylim: Limits
  dataAspect?: number | null; projection?: '2d' | '3d'
}) {
  /* Object.create(Axes.prototype), so the real private `framed`/`aspectFitted`
     are reached — the stand-in supplies only the fields they read. */
  return Object.assign(Object.create(Axes.prototype) as object, {
    margins: MARGINS,
    colorbar: false,
    title: '',
    titleVisible: false,
    projection: o.projection ?? '2d',
    dataAspect: o.dataAspect ?? null,
    _xdata: o.xlim,
    _ydata: o.ylim,
    viewportPx: () => ({ left: 0, top: 0, w: o.w, h: o.h }),
  }) as unknown as Axes
}

const at = (h: Axes, x: number, y: number): [number, number] =>
  (Axes.prototype.dataToScreen as (this: Axes, x: number, y: number) => [number, number]).call(h, x, y)

/** Pixels per data unit along each axis, measured off the mapping itself. */
function scale(h: Axes, xlim: Limits, ylim: Limits): { sx: number; sy: number } {
  const [x0, y0] = at(h, xlim[0], ylim[0])
  const [x1, y1] = at(h, xlim[1], ylim[1])
  return { sx: (x1 - x0) / (xlim[1] - xlim[0]), sy: (y0 - y1) / (ylim[1] - ylim[0]) }
}

const SQ: Limits = [0, 256]

describe('Axes.dataAspect', () => {
  it('is OFF by default, and the picture stretches to the viewport', () => {
    // The control arm. Without it a lock that silently did nothing would pass
    // every assertion below that only checks the locked case.
    const h = host({ w: 600, h: 300, xlim: SQ, ylim: SQ })
    const { sx, sy } = scale(h, SQ, SQ)
    expect(sx / sy).toBeGreaterThan(1.5)
  })

  it('equalises pixels-per-unit on both axes when 1', () => {
    for (const [w, hh] of [[600, 300], [300, 600], [512, 512], [901, 337]]) {
      const h = host({ w, h: hh, xlim: SQ, ylim: SQ, dataAspect: 1 })
      const { sx, sy } = scale(h, SQ, SQ)
      expect(sx).toBeCloseTo(sy, 9)
    }
  })

  it('equalises them for an ANISOTROPIC data box too', () => {
    // 256 x 128 mm — a volume with non-cubic voxels. The lock is about data
    // units per pixel, not about the box being square, so `1` is still the
    // right value and the box must render 2:1.
    const ylim: Limits = [0, 128]
    const h = host({ w: 600, h: 300, xlim: SQ, ylim, dataAspect: 1 })
    const { sx, sy } = scale(h, SQ, ylim)
    expect(sx).toBeCloseTo(sy, 9)
    const [x0, y0] = at(h, SQ[0], ylim[0])
    const [x1, y1] = at(h, SQ[1], ylim[1])
    expect((x1 - x0) / (y0 - y1)).toBeCloseTo(2, 6)
  })

  it('FITS rather than crops — the whole data box stays inside the plot box', () => {
    // The direction that matters: cropping would mean a window resize could hide
    // anatomy, with nothing saying it had.
    for (const [w, hh] of [[600, 300], [300, 600], [1200, 200]]) {
      const h = host({ w, h: hh, xlim: SQ, ylim: SQ, dataAspect: 1 })
      const [lx, by] = at(h, SQ[0], SQ[0])
      const [rx, ty] = at(h, SQ[1], SQ[1])
      expect(lx).toBeGreaterThanOrEqual(MARGINS.left - 1e-6)
      expect(rx).toBeLessThanOrEqual(w - MARGINS.right + 1e-6)
      expect(ty).toBeGreaterThanOrEqual(MARGINS.top - 1e-6)
      expect(by).toBeLessThanOrEqual(hh - MARGINS.bottom + 1e-6)
    }
  })

  it('keeps the data box CENTRED in the direction it widened', () => {
    const h = host({ w: 800, h: 300, xlim: SQ, ylim: SQ, dataAspect: 1 })
    const [lx] = at(h, SQ[0], 0)
    const [rx] = at(h, SQ[1], 0)
    const plotL = MARGINS.left, plotR = 800 - MARGINS.right
    expect(lx - plotL).toBeCloseTo(plotR - rx, 6)
  })

  it('honours a non-1 ratio', () => {
    // x-units-per-pixel / y-units-per-pixel = 2 ⇒ x renders at HALF the
    // pixels-per-unit of y.
    const h = host({ w: 600, h: 600, xlim: SQ, ylim: SQ, dataAspect: 2 })
    const { sx, sy } = scale(h, SQ, SQ)
    expect(sx / sy).toBeCloseTo(0.5, 9)
  })

  it('leaves 3D alone — syncFrame3D aspect-corrects the cube itself', () => {
    const h = host({ w: 600, h: 300, xlim: SQ, ylim: SQ, dataAspect: 1, projection: '3d' })
    const { sx, sy } = scale(h, SQ, SQ)
    expect(sx / sy).toBeGreaterThan(1.5)
  })

  it('does not divide by a degenerate span or a zero viewport', () => {
    for (const o of [
      { w: 600, h: 300, xlim: [5, 5] as Limits, ylim: SQ },
      { w: 600, h: 300, xlim: SQ, ylim: [0, 0] as Limits },
      { w: 0, h: 0, xlim: SQ, ylim: SQ },
    ]) {
      const [x, y] = at(host({ ...o, dataAspect: 1 }), 1, 1)
      expect(Number.isFinite(x) || Number.isNaN(x)).toBe(true)
      expect(Number.isFinite(y) || Number.isNaN(y)).toBe(true)
    }
  })
})
