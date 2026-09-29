import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { gpuHarness, hasWebGPU, type GpuHarness } from '../testing/gpu'
import { reduce, readValue, extent } from './reduce'

/**
 * The first piece of the compute half, and it is the one everything else needs:
 * nearly every analysis contains a reduction.
 */
describe('reduce', () => {
  let h: GpuHarness
  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    h = await gpuHarness()
  })
  afterAll(() => h?.dispose())

  const ramp = (n: number) => new Float32Array(n).map((_, i) => i + 1)

  it('sums a small array', async () => {
    const v = ramp(100)                                   // 1..100
    const r = await reduce(h.renderer, v, v.length, 'sum')
    expect(await readValue(h.renderer, r)).toBeCloseTo(5050, 3)
  })

  /** More than one workgroup, so the multi-pass tree is actually exercised. */
  it('sums across many workgroups', async () => {
    const n = 100_000
    const v = new Float32Array(n).fill(1)
    const r = await reduce(h.renderer, v, n, 'sum')
    expect(await readValue(h.renderer, r)).toBe(n)
  })

  it('finds min and max', async () => {
    const v = new Float32Array([3, -7.5, 0, 42, 1e-6, -0.25])
    const lo = await reduce(h.renderer, v, v.length, 'min')
    const hi = await reduce(h.renderer, v, v.length, 'max')
    expect(await readValue(h.renderer, lo)).toBeCloseTo(-7.5, 6)
    expect(await readValue(h.renderer, hi)).toBeCloseTo(42, 6)
  })

  /** A count that is not a multiple of the workgroup size — the lanes past the end
   *  must seed the identity, or they fold stale memory into the answer. */
  it('handles a ragged tail', async () => {
    for (const n of [1, 2, 255, 257, 1000, 1023, 1025]) {
      const v = new Float32Array(n).fill(2)
      const r = await reduce(h.renderer, v, n, 'sum')
      expect(await readValue(h.renderer, r), `n=${n}`).toBeCloseTo(2 * n, 2)
    }
  })

  /**
   * The property that matters for science, and the reason for a fixed tree shape
   * rather than atomics: the same input gives the same answer, every time. Atomic
   * accumulation varies with completion order, so a result would drift between
   * runs — which is exactly what makes a tool untrustworthy.
   */
  it('is deterministic across repeated runs', async () => {
    const v = new Float32Array(50_000).map((_, i) => Math.sin(i) * 1e3)
    const runs: number[] = []
    for (let k = 0; k < 5; k++) {
      runs.push(await readValue(h.renderer, await reduce(h.renderer, v, v.length, 'sum')))
    }
    expect(new Set(runs).size, `values: ${runs.join(', ')}`).toBe(1)
  })

  it('reports an extent, which is the auto-clim case', async () => {
    const v = new Float32Array([5, -2, 9.5, 0.1])
    const [lo, hi] = await extent(h.renderer, v, v.length)
    expect(lo).toBeCloseTo(-2, 6)
    expect(hi).toBeCloseTo(9.5, 6)
  })

  /** The default keeps the answer on the DEVICE — a one-element field that can
   *  feed another kernel without ever becoming a JavaScript number. */
  it('returns a device-resident field, not a number', async () => {
    const r = await reduce(h.renderer, ramp(64), 64, 'max')
    expect(r.node).toBeTruthy()
    expect(typeof r).toBe('object')
    expect(await readValue(h.renderer, r)).toBeCloseTo(64, 5)
  })

  /**
   * At a size where a CPU loop would be the wrong tool, and where f32 accumulation
   * order genuinely matters: four million values summed in three passes.
   */
  it('reduces four million values, accurately', async () => {
    const n = 4_000_000
    const v = new Float32Array(n).fill(0.25)
    const t0 = performance.now()
    const got = await readValue(h.renderer, await reduce(h.renderer, v, n, 'sum'))
    const ms = performance.now() - t0
    // 1,000,000 exactly. A naive sequential f32 sum drifts badly here; the tree
    // keeps the error at O(log n) and lands on the integer.
    expect(got).toBeCloseTo(1_000_000, 0)
    expect(ms).toBeLessThan(2000)
  })
})
