import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BufferGeometry, BufferAttribute } from 'three/webgpu'
import { gpuHarness, hasWebGPU, readback, type GpuHarness } from '../testing/gpu'
import { meshDomain } from './meshDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Four vertices at known, exactly-representable coordinates. */
const VERTS = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  0, 2, 0,
  0, 0, -4,
])

function geom(v: Float32Array = VERTS): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(Float32Array.from(v), 3))
  return g
}

/**
 * `positionAt` is a shader node, so the only honest way to test it is to RUN it
 * and read what it produced. Asserting on the node object would check that we
 * built the graph we meant to build, not that the graph evaluates correctly —
 * and the whole reason this suite exists is that the second question is the one
 * that has never been askable.
 */
async function evalPositions(h: GpuHarness, d: ReturnType<typeof meshDomain>): Promise<Float32Array> {
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

describe('meshDomain', () => {
  let h: GpuHarness
  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    h = await gpuHarness()
  })
  afterAll(() => h?.dispose())

  it('reports the geometry extent as its bounds', () => {
    const d = meshDomain(geom())
    expect(d.count).toBe(4)
    expect(d.bounds()).toEqual({ xlim: [0, 1], ylim: [0, 2], zlim: [-4, 0] })
  })

  it('evaluates positionAt to the actual vertex coordinates', async () => {
    const d = meshDomain(geom())
    expect(Array.from(await evalPositions(h, d))).toEqual(Array.from(VERTS))
    d.dispose()
  })

  it('follows setPositions — one write, every reader', async () => {
    const d = meshDomain(geom())
    await evalPositions(h, d)                      // force the buffer to exist
    const moved = VERTS.map((v) => v * 2)
    d.setPositions(moved)
    expect(Array.from(await evalPositions(h, d))).toEqual(Array.from(moved))
    d.dispose()
  })

  /**
   * Pins a decision, not a behaviour we happen to have. `Surface.setPositions`
   * states it: the axes framed the folded mesh, and re-deriving the extent on
   * every tick of a smoothing slider makes the surface appear to BREATHE rather
   * than to inflate. A future refactor that "fixes" bounds to track positions
   * would be reintroducing that.
   */
  it('does NOT re-derive bounds when positions move', () => {
    const d = meshDomain(geom())
    const before = d.bounds()
    d.setPositions(VERTS.map((v) => v * 10))
    expect(d.bounds()).toEqual(before)
  })

  it('rejects a position array of the wrong length', () => {
    const d = meshDomain(geom())
    expect(() => d.setPositions(new Float32Array(9))).toThrow(/3 vertices != 4/)
  })
})

describe('pointsDomain', () => {
  it('measures its own extent, so anchors handed over as values are framable', async () => {
    const { pointsDomain } = await import('./pointsDomain')
    const d = pointsDomain(VERTS)
    expect(d.count).toBe(4)
    // The case that used to return null from dataBounds(): a bare Float32Array of
    // anchors. Measuring [N × 3] floats once is cheap beside uploading them.
    expect(d.bounds()).toEqual({ xlim: [0, 1], ylim: [0, 2], zlim: [-4, 0] })
  })

  it('rejects a length that is not whole xyz triples', async () => {
    const { pointsDomain } = await import('./pointsDomain')
    expect(() => pointsDomain(new Float32Array(7))).toThrow(/whole number of xyz triples/)
  })
})
