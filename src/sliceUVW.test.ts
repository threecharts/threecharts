import { describe, it, expect } from 'vitest'
import {
  freeAxes, fixedAxis, sliceCount, sliceExtent, sliceVoxel, sliceUVW, voxelToSliceUV,
  type SliceAxis, type VolumeDims,
} from './sliceUVW'

const DIMS: VolumeDims = [256, 200, 100]
const AXES: SliceAxis[] = ['i', 'j', 'k']

describe('the axis convention', () => {
  it('holds one axis and keeps the other two in VOLUME order', () => {
    expect(freeAxes('i')).toEqual([1, 2])
    expect(freeAxes('j')).toEqual([0, 2])
    expect(freeAxes('k')).toEqual([0, 1])
  })

  it('never lets the fixed axis appear among the free ones', () => {
    for (const a of AXES) expect(freeAxes(a)).not.toContain(fixedAxis(a))
  })

  it('reports the slice count and the quad extent from the right axes', () => {
    expect(sliceCount(DIMS, 'i')).toBe(256)
    expect(sliceCount(DIMS, 'k')).toBe(100)
    expect(sliceExtent(DIMS, 'i')).toEqual([200, 100])
    expect(sliceExtent(DIMS, 'j')).toEqual([256, 100])
    expect(sliceExtent(DIMS, 'k')).toEqual([256, 200])
  })
})

describe('sliceVoxel', () => {
  it('puts the quad corners on the volume corners', () => {
    expect(sliceVoxel(0, 0, 7, DIMS, 'i')).toEqual([7, 0, 0])
    expect(sliceVoxel(1, 1, 7, DIMS, 'i')).toEqual([7, 199, 99])
  })

  it('carries the index on the FIXED axis, whichever that is', () => {
    expect(sliceVoxel(0, 0, 12, DIMS, 'j')[1]).toBe(12)
    expect(sliceVoxel(0, 0, 12, DIMS, 'k')[2]).toBe(12)
  })

  it('clamps rather than wrapping, on every axis', () => {
    expect(sliceVoxel(-1, 2, 999, DIMS, 'i')).toEqual([255, 0, 99])
  })
})

describe('sliceUVW', () => {
  it('samples the TEXEL CENTRE on the fixed axis', () => {
    /* Not the edge. A slice landing exactly between two planes makes a linear
       sampler return their average — a blurred slice that reads as a slightly
       thick one and is actually two. */
    expect(sliceUVW(0.5, 0.5, 0, DIMS, 'i')[0]).toBeCloseTo(0.5 / 256, 12)
    expect(sliceUVW(0.5, 0.5, 128, DIMS, 'i')[0]).toBeCloseTo(128.5 / 256, 12)
  })

  it('lands every index strictly inside its own texel', () => {
    for (const axis of AXES) {
      const f = fixedAxis(axis)
      const n = DIMS[f]
      for (const idx of [0, 1, Math.floor(n / 2), n - 1]) {
        const w = sliceUVW(0, 0, idx, DIMS, axis)[f]
        expect(Math.floor(w * n)).toBe(idx)
      }
    }
  })

  it('leaves the FREE axes continuous', () => {
    /* Flooring here would quantise the image to voxels at every zoom, which
       throws away the trilinear sampling the 3D texture exists for. */
    const a = sliceUVW(0.5001, 0.25, 3, DIMS, 'k')
    const b = sliceUVW(0.5002, 0.25, 3, DIMS, 'k')
    expect(a[0]).not.toBe(b[0])
  })

  it('clamps the free axes to the texture', () => {
    const w = sliceUVW(-0.4, 1.6, 0, DIMS, 'k')
    expect(w[0]).toBe(0)
    expect(w[1]).toBe(1)
  })

  it('agrees with sliceVoxel about which voxel a uv names', () => {
    // The two are used by different consumers — the shader samples, the readout
    // indexes — and a disagreement between them is a crosshair that reports one
    // voxel while the image shows another.
    for (const axis of AXES) {
      for (const [u, v] of [[0.1, 0.9], [0.5, 0.5], [0.99, 0.01]]) {
        const vox = sliceVoxel(u, v, 5, DIMS, axis)
        const w = sliceUVW(u, v, 5, DIMS, axis)
        const [a, up] = freeAxes(axis)
        expect(Math.min(DIMS[a] - 1, Math.floor(w[a] * DIMS[a]))).toBe(vox[a])
        expect(Math.min(DIMS[up] - 1, Math.floor(w[up] * DIMS[up]))).toBe(vox[up])
        expect(Math.floor(w[fixedAxis(axis)] * DIMS[fixedAxis(axis)])).toBe(vox[fixedAxis(axis)])
      }
    }
  })
})

describe('voxelToSliceUV', () => {
  it('round-trips a voxel through the uv a crosshair would draw at', () => {
    for (const axis of AXES) {
      const vox: [number, number, number] = [10, 20, 30]
      const [u, v] = voxelToSliceUV(vox, DIMS, axis)
      const back = sliceVoxel(u, v, vox[fixedAxis(axis)], DIMS, axis)
      expect(back).toEqual(vox)
    }
  })

  it('returns the voxel CENTRE, not its lower edge', () => {
    /* A half-voxel offset is invisible on a 256³ volume and wrong in exactly the
       place a reader clicks to check it. */
    expect(voxelToSliceUV([0, 0, 0], DIMS, 'i')).toEqual([0.5 / 200, 0.5 / 100])
  })
})
