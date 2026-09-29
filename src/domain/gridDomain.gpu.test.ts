import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { gpuHarness, hasWebGPU, readback, type GpuHarness } from '../testing/gpu'
import { gridDomain } from './gridDomain'
import type { Domain } from './Domain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Run `positionAt` for every address and bring the results back. */
async function evalPositions(h: GpuHarness, d: Domain): Promise<Float32Array> {
  const { attributeArray, Fn, instanceIndex, uint, int, If } = await import('three/tsl') as any
  const out = attributeArray(new Float32Array(d.count * 3), 'float')
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(d.count)), () => {
      const p: any = d.positionAt(instanceIndex)
      const b: any = int(instanceIndex).mul(int(3))
      out.element(b).assign(p.x)
      out.element(b.add(int(1))).assign(p.y)
      out.element(b.add(int(2))).assign(p.z)
    })
  })().compute(d.count)
  await h.renderer.computeAsync(kernel)
  return readback(h, out, d.count * 3)
}

describe('gridDomain', () => {
  let h: GpuHarness
  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    h = await gpuHarness()
  })
  afterAll(() => h?.dispose())

  it('counts the lattice and reports the box', () => {
    const d = gridDomain({ nx: 4, ny: 3, x: [0, 8], y: [-1, 1] })
    expect(d.count).toBe(12)
    expect(d.bounds()).toEqual({ xlim: [0, 8], ylim: [-1, 1], zlim: [0, 0] })
  })

  it('places 2-D samples at cell centres, first axis fastest', async () => {
    // 2×2 over x∈[0,4], y∈[0,2] → centres at x ∈ {1,3}, y ∈ {0.5,1.5}
    const d = gridDomain({ nx: 2, ny: 2, x: [0, 4], y: [0, 2] })
    expect(Array.from(await evalPositions(h, d))).toEqual([
      1, 0.5, 0,
      3, 0.5, 0,
      1, 1.5, 0,
      3, 1.5, 0,
    ])
  })

  it('places 3-D samples at cell centres', async () => {
    const d = gridDomain({ nx: 2, ny: 1, nz: 2, x: [0, 4], y: [0, 2], z: [0, 8] })
    expect(Array.from(await evalPositions(h, d))).toEqual([
      1, 1, 2,
      3, 1, 2,
      1, 1, 6,
      3, 1, 6,
    ])
  })

  /** Nothing is allocated: a rectilinear domain computes, it does not store. */
  it('needs no GPU allocation for a large lattice', () => {
    const d = gridDomain({ nx: 2000, ny: 2000, nz: 10, x: [0, 1], y: [0, 1], z: [0, 1] })
    expect(d.count).toBe(40_000_000)
    expect(d.bounds()).toEqual({ xlim: [0, 1], ylim: [0, 1], zlim: [0, 1] })
  })

  it('rejects malformed counts', () => {
    expect(() => gridDomain({ nx: 4, ny: 0 })).toThrow(/positive integers/)
    expect(() => gridDomain({ nx: 4.5, ny: 4 })).toThrow(/positive integers/)
    /* Two whole classes of error are no longer EXPRESSIBLE, which is the point of
       named axes: a 2-D/3-D mix-up cannot happen because `nz` is present or absent,
       and a count/extent mismatch cannot happen because each extent is attached to
       its own axis. */
    expect(gridDomain({ nx: 4, ny: 4 }).shape).toEqual([4, 4])
    expect(gridDomain({ nx: 4, ny: 4 }).bounds()).toEqual({ xlim: [0, 4], ylim: [0, 4], zlim: [0, 0] })
  })
})
