import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray } from 'three/tsl'
import { ChartSession, createFigure, type Domain } from 'threecharts'
import { gpuHarness, hasWebGPU, readback, assertWebGPU, type GpuHarness } from 'threecharts/testing'
import { polarDomain } from './polarDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

const TAU = Math.PI * 2

async function evalPositions(h: GpuHarness, d: Domain): Promise<Float32Array> {
  const { attributeArray: aa, Fn, instanceIndex, uint, int, If } = await import('three/tsl') as any
  const out = aa(new Float32Array(d.count * 3), 'float')
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

describe('polarDomain — a geometry contributed from outside core', () => {
  let h: GpuHarness
  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    h = await gpuHarness()
  })
  afterAll(() => h?.dispose())

  it('embeds (r, θ) into the plane', async () => {
    // One radial ring at r = 1, four angular cells centred at 45°, 135°, 225°, 315°.
    const d = polarDomain([4, 1], { radius: [0, 2], angle: [0, TAU] })
    const p = await evalPositions(h, d)
    const s = Math.SQRT1_2
    const expected = [s, s, 0, -s, s, 0, -s, -s, 0, s, -s, 0]
    /* Tolerance is 1e-3, not the 1e-6 an f32 round-trip would allow. WGSL does not
       specify accuracy bounds for `sin`/`cos`, so they differ between
       implementations: Metal and SwiftShader disagree here by ~4.5e-5, which is
       correct behaviour from both and would make a tighter assertion a test of
       which GPU ran it. */
    expected.forEach((v, i) => expect(p[i]).toBeCloseTo(v, 3))
  })

  it('bounds a full disc', () => {
    const d = polarDomain([16, 4], { radius: [0, 3], angle: [0, TAU], center: [1, -2] })
    const b = d.bounds()
    expect(b.xlim[0]).toBeCloseTo(-2, 5)
    expect(b.xlim[1]).toBeCloseTo(4, 5)
    expect(b.ylim[0]).toBeCloseTo(-5, 5)
    expect(b.ylim[1]).toBeCloseTo(1, 5)
  })

  /** A wedge must not be framed as a disc, or three quadrants are empty space. */
  it('bounds a wedge tightly, including its axis crossing', () => {
    // 0 → π/2: x ∈ [0, 1], y ∈ [0, 1]. The maxima are AT the axis crossings, which
    // no corner of the sector records.
    const b = polarDomain([8, 2], { radius: [0, 1], angle: [0, Math.PI / 2] }).bounds()
    expect(b.xlim[0]).toBeCloseTo(0, 5)
    expect(b.xlim[1]).toBeCloseTo(1, 5)
    expect(b.ylim[0]).toBeCloseTo(0, 5)
    expect(b.ylim[1]).toBeCloseTo(1, 5)
  })

  /**
   * THE claim. A primitive that predates polar by every commit, given a domain
   * defined outside the library, in a package that was not modified to allow it.
   */
  describe('an existing primitive, unmodified, on a contributed geometry', () => {
    let session: ChartSession
    let container: HTMLElement

    beforeAll(async () => {
      session = new ChartSession()
      await session.init()
      assertWebGPU(session.renderer)
      container = document.createElement('div')
      Object.assign(container.style, { width: '400px', height: '300px' })
      document.body.appendChild(container)
    })
    afterAll(() => { session?.dispose(); container?.remove() })

    it('places a quiver on a polar lattice and frames the axes from it', async () => {
      const fig = await createFigure({ container, session })
      const ax = fig.axes({ projection: '3d' })
      const polar = polarDomain([12, 3], { radius: [0.5, 2], angle: [0, TAU] })

      const vectors = attributeArray(new Float32Array(polar.count * 3), 'vec3')
      const q = ax.quiver(vectors, polar.count, 1, { dims: 3, domain: polar })

      expect(q.domain).toBe(polar)
      expect(q.dataBounds()).toEqual(polar.bounds())

      ax.syncFrame()
      expect(ax.xlim[0]).toBeCloseTo(-2, 5)
      expect(ax.xlim[1]).toBeCloseTo(2, 5)
      fig.dispose()
    })
  })
})
