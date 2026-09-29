import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { gpuHarness, hasWebGPU, type GpuHarness } from '../testing/gpu'
import { mean, variance, std, readValue, reduce, mapField } from './reduce'

describe('mean, variance, std', () => {
  let h: GpuHarness
  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    h = await gpuHarness()
  })
  afterAll(() => h?.dispose())

  const read = (f: Promise<any>) => f.then((r) => readValue(h.renderer, r))

  it('means a ramp', async () => {
    const n = 1000
    const v = new Float32Array(n).map((_, i) => i)      // 0..999 → mean 499.5
    expect(await read(mean(h.renderer, v, n))).toBeCloseTo(499.5, 2)
  })

  it('matches a CPU reference for std', async () => {
    const v = new Float32Array([2, 4, 4, 4, 5, 5, 7, 9])
    const n = v.length
    const mu = v.reduce((a, b) => a + b, 0) / n
    const ref = Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / (n - 1))
    expect(await read(std(h.renderer, v, n))).toBeCloseTo(ref, 5)
  })

  it('defaults to the sample convention, n − 1, as MATLAB does', async () => {
    const v = new Float32Array([2, 4, 4, 4, 5, 5, 7, 9])
    const n = v.length
    const mu = v.reduce((a, b) => a + b, 0) / n
    const ss = v.reduce((a, x) => a + (x - mu) ** 2, 0)
    expect(await read(variance(h.renderer, v, n))).toBeCloseTo(ss / (n - 1), 4)
    expect(await read(variance(h.renderer, v, n, { sample: false }))).toBeCloseTo(ss / n, 4)
  })

  /**
   * The reason variance is two-pass.
   *
   * `E[x²] − E[x]²` is algebraically right and numerically catastrophic: with a
   * large offset both terms are huge and nearly equal, so f32 subtracts away every
   * significant digit. This field sits at 10⁶ with a spread of 1 — the naive form
   * loses the answer entirely; the two-pass form recovers it.
   */
  it('survives a large offset, where the one-pass identity does not', async () => {
    const n = 20_000
    const OFFSET = 1e6
    const v = new Float32Array(n).map((_, i) => OFFSET + ((i % 3) - 1))   // −1, 0, +1
    const mu = OFFSET
    const ref = Math.sqrt(
      Array.from(v).reduce((a, x) => a + (x - mu) ** 2, 0) / (n - 1),
    )

    const got = await read(std(h.renderer, v, n))
    expect(got).toBeCloseTo(ref, 2)

    // And demonstrate the trap: the naive identity, computed the same way.
    const sum = await readValue(h.renderer, await reduce(h.renderer, v, n, 'sum'))
    const sumSq = await readValue(
      h.renderer,
      await reduce(h.renderer, v, n, 'sum', { map: (x: any) => x.mul(x) }),
    )
    const naive = Math.sqrt(Math.abs(sumSq / n - (sum / n) ** 2))
    // Off by a wide margin — or NaN — where the two-pass form is within 1%.
    expect(Math.abs(naive - ref) / ref).toBeGreaterThan(0.1)
  })

  /**
   * The composition the design exists for: `mean` returns a device FIELD, and
   * `variance` consumes it inside a kernel — no readback, no JavaScript number in
   * the middle. Only the final assertion pays a round trip.
   */
  it('composes on the device without a round trip', async () => {
    const n = 4096
    const v = new Float32Array(n).map((_, i) => Math.sin(i))
    const mu = await mean(h.renderer, v, n)
    // Centre the field using the mean field itself, then check it means ~0.
    const centred = await mapField(h.renderer, v, n,
      (x: any, i: any) => { void i; return x.sub((mu.node as any).element(0)) })
    expect(await read(mean(h.renderer, centred.node as any, n))).toBeCloseTo(0, 4)
  })
})
