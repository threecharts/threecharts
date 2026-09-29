/**
 * The LUT is the whole reason an atlas renders correctly, and every property it needs
 * is invisible on screen until it is wrong: an off-by-half U hands ~7% of regions their
 * neighbour's colour, and a linear filter blends the two.
 */
import { describe, it, expect } from 'vitest'
import { NearestFilter, NoColorSpace } from 'three/webgpu'

import { buildCategoricalLut, categoricalLutU } from './categoricalLut'

const RGBA = (r: number, g: number, b: number, a = 1): [number, number, number, number] =>
  [r, g, b, a]

describe('buildCategoricalLut', () => {
  it('stores label i at texel i, exactly', () => {
    const lut = buildCategoricalLut([RGBA(0, 0, 0, 0), RGBA(1, 0, 0), RGBA(0, 0.5, 1)])
    const d = lut.texture.image.data as Uint8Array
    expect(lut.width).toBe(3)
    expect([...d.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...d.slice(4, 8)]).toEqual([255, 0, 0, 255])
    expect([...d.slice(8, 12)]).toEqual([0, 128, 255, 255])
    lut.dispose()
  })

  it('samples NEAREST with no mipmaps and no colour-space conversion', () => {
    /* All three together, because any one of them alone still corrupts a parcellation:
       a linear filter blends neighbouring regions, mipmaps blend them at distance, and
       an sRGB conversion silently shifts every Brainstorm scout colour. */
    const lut = buildCategoricalLut([RGBA(1, 0, 0)])
    expect(lut.texture.magFilter).toBe(NearestFilter)
    expect(lut.texture.minFilter).toBe(NearestFilter)
    expect(lut.texture.generateMipmaps).toBe(false)
    expect(lut.texture.colorSpace).toBe(NoColorSpace)
    lut.dispose()
  })

  it('pads a short colour list with transparent rather than throwing', () => {
    /* A store carrying fewer colours than labels is one to render honestly. */
    const lut = buildCategoricalLut([RGBA(1, 1, 1)], 3)
    const d = lut.texture.image.data as Uint8Array
    expect(d.length).toBe(12)
    expect([...d.slice(8, 12)]).toEqual([0, 0, 0, 0])
    lut.dispose()
  })
})

describe('categoricalLutU', () => {
  it('lands on the texel CENTRE for every label', () => {
    /* The property that matters: `floor(u * width)` must recover the label. At a band
       EDGE it does not — which is the defect this replaced, measured at 5 of 69 regions
       wrong on Desikan-Killiany. */
    for (const width of [3, 27, 63, 69, 149]) {
      for (let id = 0; id < width; id++) {
        expect(Math.floor(categoricalLutU(id, width) * width)).toBe(id)
      }
    }
  })
})
