import { describe, it, expect } from 'vitest'
import { ClippingGroup, Mesh, Vector3 } from 'three/webgpu'
import { withClipping, planeThrough, movePlaneTo } from './clip'

describe('withClipping', () => {
  it('returns the node untouched when there is nothing to clip', () => {
    const m = new Mesh()
    expect(withClipping(m, null)).toBe(m)
    expect(withClipping(m, undefined)).toBe(m)
  })

  it('wraps the node in a ClippingGroup carrying the planes', () => {
    const m = new Mesh()
    const p = [planeThrough([0, 1, 0], [0, 0, 0])]
    const g = withClipping(m, p) as ClippingGroup
    expect(g).toBeInstanceOf(ClippingGroup)
    expect(g.clippingPlanes).toBe(p)
    expect(g.children[0]).toBe(m)
  })

  it('wraps an EMPTY array too — declaring it is what avoids a later rebuild', () => {
    expect(withClipping(new Mesh(), [])).toBeInstanceOf(ClippingGroup)
  })

  it('is UNION by default and intersection on request', () => {
    expect((withClipping(new Mesh(), []) as ClippingGroup).clipIntersection).toBe(false)
    expect((withClipping(new Mesh(), [], true) as ClippingGroup).clipIntersection).toBe(true)
  })
})

describe('planeThrough', () => {
  it('passes through the point it was given', () => {
    const p = planeThrough([0, 1, 0], [0, 5, 0])
    expect(p.distanceToPoint(new Vector3(0, 5, 0))).toBeCloseTo(0, 12)
  })

  it('KEEPS the half-space the normal points into', () => {
    /* three cuts away `normal · x + constant < 0`. Getting this backwards leaves
       exactly the half you meant to remove — a working cut of the wrong side. */
    const p = planeThrough([0, 1, 0], [0, 0, 0])
    expect(p.distanceToPoint(new Vector3(0, 1, 0))).toBeGreaterThan(0)   // survives
    expect(p.distanceToPoint(new Vector3(0, -1, 0))).toBeLessThan(0)     // cut
  })

  it('normalises the normal, so a caller may pass any length', () => {
    const p = planeThrough([0, 7, 0], [0, 3, 0])
    expect(p.normal.length()).toBeCloseTo(1, 12)
    expect(p.distanceToPoint(new Vector3(0, 3, 0))).toBeCloseTo(0, 12)
  })
})

describe('movePlaneTo', () => {
  it('moves the cut without touching the normal — one number, live', () => {
    const p = planeThrough([1, 0, 0], [0, 0, 0])
    const n = p.normal
    movePlaneTo(p, [4, 0, 0])
    expect(p.normal).toBe(n)                                          // same object
    expect(p.distanceToPoint(new Vector3(4, 0, 0))).toBeCloseTo(0, 12)
    expect(p.distanceToPoint(new Vector3(9, 0, 0))).toBeGreaterThan(0)
  })
})
