import { describe, it, expect } from 'vitest'
import { unionBounds, padLimits } from './limits'

describe('limits', () => {
  it('unions data bounds', () => {
    expect(unionBounds([
      { xlim: [0, 10], ylim: [-1, 1] },
      { xlim: [5, 20], ylim: [-3, 0.5] },
    ])).toEqual({ xlim: [0, 20], ylim: [-3, 1] })
  })
  it('returns null for no bounds', () => {
    expect(unionBounds([])).toBeNull()
  })
  it('pads about the center by a factor', () => {
    // [0,10] center 5, half-width 5 → ×1.2 → half 6 → [-1, 11]
    expect(padLimits([0, 10], 1.2)).toEqual([-1, 11])
  })
  it('pads a degenerate interval to a unit-ish span', () => {
    const [lo, hi] = padLimits([7, 7], 1.2)
    expect(hi).toBeGreaterThan(lo)
    expect((lo + hi) / 2).toBeCloseTo(7)
  })
})
