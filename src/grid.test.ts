import { describe, it, expect } from 'vitest'
import { subplotRect } from './grid'

describe('subplotRect', () => {
  it('is 1-based with cell 1 = top-left, as MATLAB numbers them', () => {
    // rows=2 → top row has the higher bottom-origin (0.5)
    expect(subplotRect(2, 2, 1, 0)).toEqual({ left: 0, bottom: 0.5, width: 0.5, height: 0.5 })
  })

  it('is row-major: 2=top-right, 3=bottom-left, 4=bottom-right', () => {
    expect(subplotRect(2, 2, 2, 0)).toEqual({ left: 0.5, bottom: 0.5, width: 0.5, height: 0.5 })
    expect(subplotRect(2, 2, 3, 0)).toEqual({ left: 0, bottom: 0, width: 0.5, height: 0.5 })
    expect(subplotRect(2, 2, 4, 0)).toEqual({ left: 0.5, bottom: 0, width: 0.5, height: 0.5 })
  })

  it('1×2 gives left/right halves (matches the hand-written multi-plot demo)', () => {
    expect(subplotRect(1, 2, 1, 0)).toEqual({ left: 0, bottom: 0, width: 0.5, height: 1 })
    expect(subplotRect(1, 2, 2, 0)).toEqual({ left: 0.5, bottom: 0, width: 0.5, height: 1 })
  })

  it('insets each cell by gutter/2 (gap between neighbours = gutter·cell)', () => {
    const r = subplotRect(1, 2, 1, 0.1)   // cellW=0.5 → insetX=0.025
    expect(r.left).toBeCloseTo(0.025)
    expect(r.width).toBeCloseTo(0.45)
  })

  it('throws on an out-of-range index (loud, not a silent misplacement)', () => {
    expect(() => subplotRect(2, 2, 5, 0)).toThrow(/out of range/)
    // 0 is the classic mistake now, and it must be loud rather than off-by-one.
    expect(() => subplotRect(2, 2, 0, 0)).toThrow(/out of range/)
  })

  it('throws on a non-positive grid', () => {
    expect(() => subplotRect(0, 2, 1)).toThrow()
  })

  it('spans a row: [1,2] in a 2×2 is the whole top row', () => {
    expect(subplotRect(2, 2, [1, 2], 0)).toEqual({ left: 0, bottom: 0.5, width: 1, height: 0.5 })
  })

  it('spans a column: [1,3] in a 2×2 is the left column', () => {
    expect(subplotRect(2, 2, [1, 3], 0)).toEqual({ left: 0, bottom: 0, width: 0.5, height: 1 })
  })

  it('spans a block: [1,2,4,5] in a 3×3 is the top-left 2×2 block', () => {
    expect(subplotRect(3, 3, [1, 2, 4, 5], 0)).toEqual({ left: 0, bottom: 1 / 3, width: 2 / 3, height: 2 / 3 })
  })

  it('a single-element array equals the scalar form', () => {
    expect(subplotRect(2, 2, [2], 0)).toEqual(subplotRect(2, 2, 2, 0))
  })

  it('throws on an empty span or an out-of-range member', () => {
    expect(() => subplotRect(2, 2, [], 0)).toThrow(/empty/)
    expect(() => subplotRect(2, 2, [1, 5], 0)).toThrow(/out of range/)
  })
})
