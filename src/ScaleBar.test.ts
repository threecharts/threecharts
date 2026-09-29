import { describe, it, expect } from 'vitest'
import { pickScaleValue, formatScale } from './ScaleBar'

describe('pickScaleValue', () => {
  it('snaps to the 1-2-5 ladder within the decade', () => {
    expect(pickScaleValue(1)).toBe(1)
    expect(pickScaleValue(1.9)).toBe(1)
    expect(pickScaleValue(2)).toBe(2)
    expect(pickScaleValue(4.9)).toBe(2)
    expect(pickScaleValue(5)).toBe(5)
    expect(pickScaleValue(9.9)).toBe(5)
  })

  it('works across decades, including sub-unit lengths (metres)', () => {
    expect(pickScaleValue(30)).toBe(20)
    expect(pickScaleValue(700)).toBe(500)
    expect(pickScaleValue(0.06)).toBeCloseTo(0.05, 12)
    expect(pickScaleValue(0.011)).toBeCloseTo(0.01, 12)
  })

  it('never returns a non-positive length', () => {
    expect(pickScaleValue(0)).toBe(1)
    expect(pickScaleValue(-5)).toBe(1)
    expect(pickScaleValue(NaN)).toBe(1)
  })
})

describe('formatScale', () => {
  it('adapts the SI prefix to the magnitude when the data unit is metres', () => {
    expect(formatScale(2, 'm')).toBe('2 m')
    expect(formatScale(0.05, 'm')).toBe('5 cm')      // a cortex-sized bar
    expect(formatScale(0.002, 'm')).toBe('2 mm')
    expect(formatScale(2e-5, 'm')).toBe('20 µm')
    expect(formatScale(2000, 'm')).toBe('2 km')
  })

  it('leaves a non-metre unit alone', () => {
    expect(formatScale(20, 'px')).toBe('20 px')
    expect(formatScale(2, 'au')).toBe('2 au')
  })

  it('renders unitless values without a suffix', () => {
    expect(formatScale(50, '')).toBe('50')
  })
})
