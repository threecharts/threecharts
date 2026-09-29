import { describe, it, expect } from 'vitest'
import { logTicks } from './Axis'

describe('logTicks — decade positions in exponent space', () => {
  it('gives one tick per decade over a multi-decade range', () => {
    expect(logTicks([-3, 1])).toEqual([-3, -2, -1, 0, 1])
  })
  it('subdivides 1-2-5 when the range is under two decades', () => {
    const t = logTicks([0, 1])
    expect(t[0]).toBe(0)
    expect(t).toContain(1)
    expect(t.some((v) => Math.abs(v - Math.log10(2)) < 1e-9)).toBe(true)
    expect(t.some((v) => Math.abs(v - Math.log10(5)) < 1e-9)).toBe(true)
    expect(t.every((v, i) => i === 0 || v > t[i - 1])).toBe(true)
  })
  it('is empty for a degenerate range', () => {
    expect(logTicks([2, 2])).toEqual([])
    expect(logTicks([3, 1])).toEqual([])
  })
})
