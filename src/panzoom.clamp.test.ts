import { describe, it, expect } from 'vitest'
import { clampView } from './panzoom'
import type { Limits } from './limits'

/**
 * `clampView` is the "this data has an EDGE" rule — an MRI slice, a photograph,
 * anything where outside the data is not empty space but nothing at all.
 *
 * Tested rather than eyeballed because its failure mode is slow: a view that can
 * creep one tick past the edge per gesture looks fine on the first wheel click
 * and has the head in a corner of background after ten.
 */
const B: Limits = [0, 256]

describe('clampView', () => {
  it('leaves a view that already fits alone', () => {
    expect(clampView([10, 90], B)).toEqual([10, 90])
  })

  it('SNAPS to the bound when asked for more than there is', () => {
    /* Not "clamp each end" — the whole point is that zoomed-all-the-way-out is a
       definite state, so a request for 400 units of a 256-unit image is the
       image, not the image plus 144 of background. */
    expect(clampView([-100, 300], B)).toEqual(B)
    expect(clampView([-1e6, 1e6], B)).toEqual(B)
  })

  it('keeps the SPAN when a pan runs off an edge, rather than squashing it', () => {
    /* A pan that hits the wall should stop, not shrink. Clamping the ends
       independently would narrow the view every time it touched an edge — the
       image would appear to zoom in as you dragged into a corner. */
    expect(clampView([-30, 70], B)).toEqual([0, 100])
    expect(clampView([200, 300], B)).toEqual([156, 256])
  })

  it('preserves the midpoint where it can — a wheel tick still moves toward the cursor', () => {
    const [lo, hi] = clampView([100, 140], B)
    expect((lo + hi) / 2).toBeCloseTo(120)
    expect(hi - lo).toBeCloseTo(40)
  })

  it('is idempotent — clamping a clamped view changes nothing', () => {
    const once = clampView([-500, 900], B)
    expect(clampView(once, B)).toEqual(once)
  })

  it('never returns a view outside the bound, over a sweep of proposals', () => {
    for (let lo = -300; lo <= 300; lo += 37) {
      for (const span of [1, 10, 100, 256, 500]) {
        const [a, b] = clampView([lo, lo + span], B)
        expect(a).toBeGreaterThanOrEqual(B[0] - 1e-9)
        expect(b).toBeLessThanOrEqual(B[1] + 1e-9)
        expect(b - a).toBeLessThanOrEqual(B[1] - B[0] + 1e-9)
      }
    }
  })

  it('degenerate spans fall back to the bound rather than to NaN', () => {
    expect(clampView([5, 5], B)).toEqual(B)
    expect(clampView([0, 10], [7, 7])).toEqual([7, 7])
  })
})
