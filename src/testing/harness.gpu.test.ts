import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { gpuHarness, hasWebGPU, readback, type GpuHarness } from './gpu'
import { REQUIRED_STORAGE_BUFFERS } from '../deviceLimits'

/**
 * Proves the GPU suite can do the one thing it exists for: observe values the
 * library put on the device. If this file fails, every other `.gpu.test.ts` is
 * untrustworthy regardless of what it asserts.
 */
describe('gpu harness', () => {
  let h: GpuHarness

  beforeAll(async () => {
    expect(await hasWebGPU(), 'no WebGPU adapter — check the chromium flags').toBe(true)
    h = await gpuHarness()
  })
  afterAll(() => h?.dispose())

  it('gets a device meeting the limits the library requires', () => {
    expect(h.device).toBeTruthy()
    expect(h.device.limits.maxStorageBuffersPerShaderStage)
      .toBeGreaterThanOrEqual(REQUIRED_STORAGE_BUFFERS)
  })

  it('runs a compute pass and reads its output back exactly', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { attributeArray, Fn, instanceIndex, float, uint, If } = await import('three/tsl') as any

    const N = 8
    const out = attributeArray(new Float32Array(N), 'float')
    // out[i] = i * 1.5 — every value exactly representable in f32, so the
    // comparison below can be exact rather than approximate.
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(N)), () => {
        out.element(instanceIndex).assign(float(instanceIndex).mul(float(1.5)))
      })
    })().compute(N)

    await h.renderer.computeAsync(kernel)
    expect(Array.from(await readback(h, out, N))).toEqual([0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5])
  })

  /**
   * The guard above is NOT ceremony, and this test exists so nobody removes it.
   *
   * `.compute(n)` dispatches whole WORKGROUPS, so a count that is not a multiple
   * of the workgroup size over-invokes: `compute(8)` runs 64 threads. An
   * unguarded kernel therefore writes past its logical count — and where the
   * buffer is smaller than the dispatch, WGSL CLAMPS the out-of-range index to
   * the last valid element rather than dropping the write, so threads 8..63 all
   * land on slot 7 and whichever finishes last wins. The symptom is a single
   * wrong value at the end of a buffer, which reads as a rounding bug rather
   * than a dispatch bug.
   *
   * Demonstrated here against a buffer LARGER than the count, so the surplus
   * threads write in-bounds and the evidence is deterministic — asserting on the
   * clamped case instead would be asserting on which thread won a race.
   */
  it('over-dispatches past the requested count without a guard', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const { attributeArray, Fn, instanceIndex, float } = await import('three/tsl') as any

    const N = 8, CAP = 64
    const out = attributeArray(new Float32Array(CAP), 'float')
    const unguarded = Fn(() => {
      out.element(instanceIndex).assign(float(instanceIndex).add(float(1)))
    })().compute(N)

    await h.renderer.computeAsync(unguarded)
    const got = await readback(h, out, CAP)

    // The requested range is correct...
    expect(Array.from(got.subarray(0, N))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // ...and threads well beyond it ran anyway.
    expect(got[N]).toBe(N + 1)
    expect(got[CAP - 1]).toBe(CAP)
  })
})
