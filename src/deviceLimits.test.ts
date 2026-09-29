/**
 * THE DEVICE-LIMIT BUDGET, pinned.
 *
 * This exists because the number it guards was wrong for months in a way no
 * test could see: `REQUIRED_STORAGE_BUFFERS` was 10, inherited from a kernel
 * (`computeDivergence`, in the archived `charts-mesh`) that no longer exists.
 * Every desktop the team owned reported 10, so everything worked here while the
 * app refused to start on any adapter reporting the spec default of 8 — which is
 * most phones.
 *
 * The rule is therefore not "the number is 8" but "we never require more than
 * every adapter must provide". A device request is refused outright when ANY
 * required limit exceeds the adapter's, so the moment this ceiling is raised the
 * app stops starting somewhere — and the failure lands on a user, not on CI.
 */
import { describe, it, expect } from 'vitest'
import { REQUIRED_STORAGE_BUFFERS, WEBGPU_DEFAULT_STORAGE_BUFFERS } from './deviceLimits'

describe('device limits', () => {
  it('never requires more storage buffers than the WebGPU guaranteed floor', () => {
    expect(REQUIRED_STORAGE_BUFFERS).toBeLessThanOrEqual(WEBGPU_DEFAULT_STORAGE_BUFFERS)
  })

  /**
   * The live maximum is 8 — `flowField.ts`'s vertex-gather pass spends the budget
   * exactly (6 read + 2 written). So this is not headroom: a kernel that adds a
   * ninth buffer is a validation error on EVERY GPU, and the fix is to pack
   * (`div`+`curl` as `vec2`), never to raise the ceiling. Asserting equality
   * rather than a bound makes lowering it a deliberate act too.
   */
  it('asks for exactly the floor — the budget is spent, not padded', () => {
    expect(REQUIRED_STORAGE_BUFFERS).toBe(8)
  })
})
