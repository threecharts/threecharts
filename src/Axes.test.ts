import { describe, it, expect } from 'vitest'
import { niceTicks } from './Axis'

describe('niceTicks', () => {
  it('produces round, in-range, ascending ticks', () => {
    const t = niceTicks([0, 100], 5)
    expect(t.length).toBeGreaterThanOrEqual(3)
    expect(t[0]).toBeGreaterThanOrEqual(0)
    expect(t[t.length - 1]).toBeLessThanOrEqual(100)
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1])   // ascending
    const step = t[1] - t[0]
    for (const v of t) expect(Math.abs(v / step - Math.round(v / step))).toBeLessThan(1e-9)  // round multiples
  })
  it('handles non-zero offsets', () => {
    const t = niceTicks([13, 87], 5)
    expect(t[0]).toBeGreaterThanOrEqual(13)
    expect(t[t.length - 1]).toBeLessThanOrEqual(87)
  })
  it('is empty for a degenerate range', () => {
    expect(niceTicks([5, 5], 5)).toEqual([])
  })
})
