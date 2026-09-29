import { describe, it, expect } from 'vitest'
import { resolveContourInterval, AUTO_CONTOUR_BANDS } from './contour-node'

/**
 * The CPU half of the isolines. It exists so `interval: 'auto'` can follow a moving
 * clim by writing a uniform — the whole reason the clim stopped being baked into
 * the node graph — which makes its edge cases worth pinning: they are evaluated on
 * every `setClim`, i.e. potentially every frame.
 */
describe('resolveContourInterval', () => {
  it('takes a usable explicit interval unchanged', () => {
    expect(resolveContourInterval(0.25, [0, 10])).toBe(0.25)
  })

  it('splits the clim into AUTO_CONTOUR_BANDS when auto', () => {
    expect(resolveContourInterval('auto', [0, 10])).toBe(10 / AUTO_CONTOUR_BANDS)
    expect(resolveContourInterval(undefined, [0, 10])).toBe(10 / AUTO_CONTOUR_BANDS)
  })

  it('reads an INVERTED clim as a positive spacing', () => {
    // d0 > d1 legitimately flips the colormap, and a negative period would put
    // `fract` on the wrong side of every line.
    expect(resolveContourInterval('auto', [10, 0])).toBe(10 / AUTO_CONTOUR_BANDS)
  })

  it('falls back rather than returning zero on a degenerate clim', () => {
    // A zero period makes every fragment sit on a line — a solid wash that reads as
    // a broken chart, not as a missing clim.
    expect(resolveContourInterval('auto', [5, 5])).toBe(1)
  })

  it('rejects a non-positive or non-finite explicit interval', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(resolveContourInterval(bad, [0, 10])).toBe(10 / AUTO_CONTOUR_BANDS)
    }
  })

  it('survives a non-finite clim', () => {
    expect(resolveContourInterval('auto', [0, Infinity])).toBe(1)
    expect(resolveContourInterval('auto', [NaN, 1])).toBe(1)
  })

  it('splits into the requested number of bands', () => {
    // The knob the chart UI actually exposes: a COUNT reads the same on ‖J‖ (~1.3)
    // and on ∇·J (~1.8e3), where one interval in data units cannot.
    expect(resolveContourInterval('auto', [0, 10], 4)).toBe(2.5)
    expect(resolveContourInterval('auto', [-1800, 1800], 40)).toBe(90)
  })

  it('falls back to the default band count when it is unusable', () => {
    for (const bad of [0, -3, NaN, undefined]) {
      expect(resolveContourInterval('auto', [0, 10], bad as number)).toBe(10 / AUTO_CONTOUR_BANDS)
    }
  })

  it('lets an explicit interval win over the band count', () => {
    // `bands` only ever feeds `auto` — a caller that names an interval means it.
    expect(resolveContourInterval(0.5, [0, 10], 4)).toBe(0.5)
  })
})
