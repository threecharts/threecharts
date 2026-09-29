import { describe, it, expect } from 'vitest'
import { createVolumeTexture, volumeUVW } from './volumeTexture'
import { NearestFilter, LinearFilter, NoColorSpace, RedFormat } from 'three/webgpu'
import { sliceUVW } from './sliceUVW'

const DIMS = [4, 3, 2] as const

function cube(): Uint8Array {
  return Uint8Array.from({ length: 4 * 3 * 2 }, (_, n) => n)
}

describe('createVolumeTexture', () => {
  it('sizes the texture (x=k, y=j, z=i) — the volume order reversed', () => {
    const t = createVolumeTexture(cube(), DIMS, 'anatomical')
    expect([t.image.width, t.image.height, t.image.depth]).toEqual([2, 3, 4])
  })

  it('samples an ATLAS nearest and an anatomical volume linearly', () => {
    /* Not a preference. Interpolating labels invents regions between them. */
    expect(createVolumeTexture(cube(), DIMS, 'atlas').magFilter).toBe(NearestFilter)
    expect(createVolumeTexture(cube(), DIMS, 'anatomical').magFilter).toBe(LinearFilter)
  })

  it('leaves the bytes in their own colour space and builds no mipmaps', () => {
    const t = createVolumeTexture(cube(), DIMS, 'anatomical')
    expect(t.colorSpace).toBe(NoColorSpace)
    expect(t.generateMipmaps).toBe(false)
    expect(t.format).toBe(RedFormat)
  })

  it('hands the array over without copying it', () => {
    const c = cube()
    expect(createVolumeTexture(c, DIMS, 'anatomical').image.data).toBe(c)
  })

  it('refuses a cube whose length disagrees with its dims', () => {
    expect(() => createVolumeTexture(new Uint8Array(5), DIMS, 'anatomical'))
      .toThrow(/5 voxels/)
  })
})

describe('volumeUVW', () => {
  it('reverses the axis order, and only that', () => {
    expect(volumeUVW([0.1, 0.2, 0.3])).toEqual([0.3, 0.2, 0.1])
  })

  it('sends a slice index to the texture axis that actually holds it', () => {
    /* The composition that matters: `sliceUVW` answers in VOLUME order and the
       texture is indexed in reverse. Getting this wrong transposes the volume —
       a brain-shaped object no window level can reveal as wrong. */
    const w = volumeUVW(sliceUVW(0.5, 0.5, 2, [8, 8, 8], 'i'))
    expect(w[2]).toBeCloseTo(2.5 / 8, 12)   // i ended up on the texture's z
    const wk = volumeUVW(sliceUVW(0.5, 0.5, 2, [8, 8, 8], 'k'))
    expect(wk[0]).toBeCloseTo(2.5 / 8, 12)  // k ended up on the texture's x
  })
})
