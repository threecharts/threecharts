import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BufferGeometry, BufferAttribute } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray } from 'three/tsl'
import { assertWebGPU, hasWebGPU } from '../testing/gpu'
import { ChartSession } from '../ChartSession'
import { createFigure } from '../Figure'
import { meshDomain } from './meshDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A four-vertex mesh at exactly-representable coordinates. */
const VERTS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, -4])
const V = 4

function mesh(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(Float32Array.from(VERTS), 3))
  g.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1))
  return g
}

/**
 * The defect this whole slice exists for, exercised through the real object graph
 * rather than against the domain in isolation.
 *
 * `Quiver` and `Particles` both carried a `_boundsNull` flag, commented "defer
 * framing to the surface" — a relationship the code could describe but not name,
 * so it was implemented as a `null` and the axes simply could not see those
 * layers. Sharing a domain gives them something to defer TO.
 */
describe('a surface and its glyphs sharing one domain', () => {
  let session: ChartSession
  let container: HTMLElement

  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    session = new ChartSession()
    await session.init()
    // ChartSession asks for raised limits and three falls back to WebGL2 rather
    // than throwing when they cannot be met — see `assertWebGPU`.
    assertWebGPU(session.renderer)
    container = document.createElement('div')
    Object.assign(container.style, { width: '400px', height: '300px' })
    document.body.appendChild(container)
  })
  afterAll(() => { session?.dispose(); container?.remove() })

  const build = async () => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes({ projection: '3d' })
    const geometry = mesh()
    const domain = meshDomain(geometry)
    return { fig, ax, geometry, domain }
  }

  it('lets a quiver report the bounds it could not know before', async () => {
    const { fig, ax, geometry, domain } = await build()
    ax.surface(geometry, { domain })
    const vectors = attributeArray(new Float32Array(V * 3), 'vec3')
    const q = ax.quiver(vectors, V, 1, { dims: 3, domain })

    // Previously null: "anchor mode → defer framing to the surface".
    expect(q.dataBounds()).not.toBeNull()
    expect(q.dataBounds()).toEqual(domain.bounds())
    fig.dispose()
  })

  it('frames the axes from layers that used to contribute nothing', async () => {
    const { fig, ax, domain } = await build()
    const vectors = attributeArray(new Float32Array(V * 3), 'vec3')
    // The quiver ALONE — no surface. Before, this axes had nothing to frame on and
    // fell back to its default [0,1] limits, so the arrows drew off-screen.
    ax.quiver(vectors, V, 1, { dims: 3, domain })
    ax.syncFrame()

    expect(ax.xlim).toEqual([0, 1])
    expect(ax.ylim).toEqual([0, 2])
    expect(ax.zlim).toEqual([-4, 0])
    fig.dispose()
  })

  it('moves the surface and its glyphs in one call', async () => {
    const { fig, ax, geometry, domain } = await build()
    const surf = ax.surface(geometry, { domain })
    const vectors = attributeArray(new Float32Array(V * 3), 'vec3')
    const q = ax.quiver(vectors, V, 1, { dims: 3, domain })

    const moved = VERTS.map((v) => v * 3)
    surf.setPositions(moved)

    /* The glyphs followed WITHOUT a second call. Before, `surface.setPositions`,
       `quiver.setAnchors` and `particles.setPositions` each rewrote a private copy,
       and any one of them forgotten left that layer at the folded position. */
    const onGpuSide = geometry.attributes.position.array as Float32Array
    expect(Array.from(onGpuSide)).toEqual(Array.from(moved))
    expect(q.ownsAnchors).toBe(true)
    fig.dispose()
  })

  /**
   * The dangerous direction of the ownership rule.
   *
   * A shared domain exists so several drawables read ONE set of vertices. If
   * disposing any one of them freed it, the others would be left reading a
   * released buffer — and the symptom would appear in a layer nobody touched.
   */
  it('survives one of its drawables being disposed', async () => {
    const { fig, ax, geometry, domain } = await build()
    const surf = ax.surface(geometry, { domain })
    const vectors = attributeArray(new Float32Array(V * 3), 'vec3')
    const q = ax.quiver(vectors, V, 1, { dims: 3, domain })

    ax.removeDrawable(surf)

    // The domain outlives it: still addressable, still framing the quiver.
    expect(domain.count).toBe(V)
    expect(q.dataBounds()).toEqual(domain.bounds())
    // And still writable, which is what proves its buffer was not released.
    const moved = VERTS.map((v) => v * 5)
    domain.setPositions(moved)
    expect(Array.from(geometry.attributes.position.array as Float32Array))
      .toEqual(Array.from(moved))
    fig.dispose()
  })

  it('rejects a vector count that disagrees with the domain', async () => {
    const { fig, ax, domain } = await build()
    const vectors = attributeArray(new Float32Array(V * 3), 'vec3')
    // Structural now, where it used to be a runtime throw comparing two arrays.
    expect(() => ax.quiver(vectors, V + 1, 1, { dims: 3, domain })).toThrow(/domain has 4 addresses/)
    fig.dispose()
  })
})
