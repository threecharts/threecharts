import { describe, it, expect } from 'vitest'
import { createCategoricalScheme, binaryScheme, schemeU } from './categorical'
import type { SurfaceCategorical } from './Surface'

const RED: [number, number, number, number] = [1, 0, 0, 1]
const GREEN: [number, number, number, number] = [0, 1, 0, 1]
const BLUE: [number, number, number, number] = [0, 0, 1, 1]

/** The texture's raw bytes, four per texel. */
function texels(s: { lut: unknown }): Uint8Array {
  return (s.lut as { image: { data: Uint8Array } }).image.data
}

describe('createCategoricalScheme', () => {
  it('is sized to the label count, not to 256', () => {
    const s = createCategoricalScheme({ id: 'three', colors: [RED, GREEN, BLUE] })
    expect(s.width).toBe(3)
    expect(texels(s)).toHaveLength(12)
    s.dispose()
  })

  it('stores each colour at its own label index, unmodified', () => {
    const s = createCategoricalScheme({ id: 'rgb', colors: [RED, GREEN, BLUE] })
    expect(Array.from(texels(s))).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ])
    s.dispose()
  })

  it('pads a short colour list with transparent rather than rejecting it', () => {
    // A store carrying fewer colours than labels is one to render honestly.
    const s = createCategoricalScheme({ id: 'short', colors: [RED], width: 3 })
    expect(s.width).toBe(3)
    expect(Array.from(texels(s)).slice(4)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    s.dispose()
  })

  it('keeps id, colours and names for a legend to read', () => {
    // The legend and the shader must read the SAME array — not two that agree.
    const names = ['background', 'left', 'right']
    const s = createCategoricalScheme({ id: 'named', colors: [RED, GREEN, BLUE], names })
    expect(s.id).toBe('named')
    expect(s.colors[1]).toEqual(GREEN)
    expect(s.names).toBe(names)
    s.dispose()
  })

  it("satisfies Surface's own categorical option, with no change to Surface", () => {
    // The real type, not a hand-written copy of it — so this test fails if `Surface`
    // ever renames `lut`, which is the only thing making the two interchangeable.
    const s = createCategoricalScheme({ id: 'x', colors: [RED] })
    const asSurfaceOption: SurfaceCategorical = s
    expect(asSurfaceOption.width).toBe(1)
    s.dispose()
  })
})

describe('binaryScheme', () => {
  it('puts the colour at 1 and leaves 0 transparent', () => {
    const s = binaryScheme([1, 1, 0, 1])
    expect(s.width).toBe(2)
    expect(Array.from(texels(s))).toEqual([0, 0, 0, 0, 255, 255, 0, 255])
    s.dispose()
  })

  it('takes an explicit off colour when the zero should be seen', () => {
    const s = binaryScheme([1, 0, 0, 1], [0, 0, 1, 1])
    expect(Array.from(texels(s)).slice(0, 4)).toEqual([0, 0, 255, 255])
    s.dispose()
  })
})

describe('schemeU', () => {
  it('addresses the texel CENTRE, never an edge', () => {
    // Every label lands strictly inside its own texel, at every width. Landing on an
    // edge is what hands ~7% of labels their neighbour's colour under rounding.
    for (const width of [1, 3, 27, 63, 69, 149]) {
      for (let id = 0; id < width; id++) {
        const u = schemeU(id, width)
        expect(Math.floor(u * width)).toBe(id)
        expect(u).toBeGreaterThan(id / width)
        expect(u).toBeLessThan((id + 1) / width)
      }
    }
  })
})
