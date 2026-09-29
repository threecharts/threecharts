import { describe, it, expect } from 'vitest'
import { packBoxes, nextPow2 } from './textAtlas'

describe('nextPow2', () => {
  it('rounds up to a power of two', () => {
    expect([1, 2, 3, 5, 100, 1024, 1025].map(nextPow2)).toEqual([1, 2, 4, 8, 128, 1024, 2048])
  })
})

describe('packBoxes', () => {
  it('lays boxes along a row until the row is full', () => {
    const { origins } = packBoxes([{ w: 30, h: 10 }, { w: 30, h: 10 }, { w: 30, h: 10 }], 100)
    expect(origins).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }])
  })

  it('wraps to a new row at the row height of the row it LEFT', () => {
    /* The tall box sets the row height, so the next row starts below it — not
       below the last box, which would overlap whatever was tallest. */
    const { origins } = packBoxes(
      [{ w: 60, h: 20 }, { w: 60, h: 8 }, { w: 60, h: 8 }], 100)
    expect(origins[1]).toEqual({ x: 0, y: 20 })
    expect(origins[2]).toEqual({ x: 0, y: 28 })
  })

  it('never overlaps two boxes', () => {
    const boxes = Array.from({ length: 60 }, (_, i) => ({ w: 20 + (i % 7) * 6, h: 10 + (i % 3) * 4 }))
    const { origins } = packBoxes(boxes, 128)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = { ...origins[i], ...boxes[i] }, b = { ...origins[j], ...boxes[j] }
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x
          || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(disjoint).toBe(true)
      }
    }
  })

  it('sizes the atlas to powers of two that contain everything', () => {
    const boxes = Array.from({ length: 40 }, () => ({ w: 33, h: 17 }))
    const { origins, width, height } = packBoxes(boxes, 128)
    for (let i = 0; i < boxes.length; i++) {
      expect(origins[i].x + boxes[i].w).toBeLessThanOrEqual(width)
      expect(origins[i].y + boxes[i].h).toBeLessThanOrEqual(height)
    }
    expect(nextPow2(width)).toBe(width)
    expect(nextPow2(height)).toBe(height)
  })

  it('gives an over-wide box its own row rather than clipping it', () => {
    /* A truncated label is a WRONG label; elision is the caller's job. */
    const { origins, width } = packBoxes([{ w: 20, h: 10 }, { w: 500, h: 10 }], 100)
    expect(origins[1]).toEqual({ x: 0, y: 10 })
    expect(width).toBeGreaterThanOrEqual(500)
  })

  it('handles an empty list without producing a zero-sized texture', () => {
    expect(packBoxes([], 128)).toEqual({ origins: [], width: 1, height: 1 })
  })
})
