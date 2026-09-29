/**
 * Screen point → vertex, by CPU raycast against the surface's own mesh.
 *
 * Four steps: client px → NDC, raycast the mesh, convert the world hit to LOCAL once
 * (so the nearest-vertex test compares same-space points without a matrix multiply
 * per candidate), then take the nearest of the hit TRIANGLE's three corners. Nearest
 * corner rather than a spatial index because the raycast already told us the triangle
 * — there are only ever three candidates.
 *
 * `three` only: no React, no compute, no GPU pass. All scratch is preallocated at
 * construction, because this runs on pointer-MOVE for hover and a picker that
 * allocates there shows up as jank rather than as a slow function.
 *
 * Ported from the deprecated `@nxr/charts-webgpu`'s `mesh/interaction/marker/picking`,
 * retargeted from its `ManifoldViewHandle` to an `Axes` + the `Surface`'s mesh.
 */

import { Raycaster, Vector2, Vector3, type Object3D, type Mesh } from 'three/webgpu'
import type { Axes } from '../Axes'

/** Fill `ndc` in place — the client→NDC convention lives here and nowhere else, so
 *  the two pickers cannot silently disagree about it. */
function setNdcFromClient(ndc: Vector2, dom: HTMLElement, clientX: number, clientY: number): void {
  const rect = dom.getBoundingClientRect()
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    ((clientY - rect.top) / rect.height) * -2 + 1,
  )
}

export interface VertexPickResult {
  /** Index into `geometry.attributes.position`. */
  vertexId: number
  /** World position of the picked VERTEX (not of the ray hit). */
  worldPos: [number, number, number]
  /** World face normal at the hit — for orienting a marker. */
  normal: [number, number, number]
}

export interface VertexPicker {
  pick(clientX: number, clientY: number): VertexPickResult | null
  dispose(): void
}

/**
 * @param axes the axes whose camera defines the ray
 * @param mesh the mesh to hit — `Surface.mesh`, which that class exposes for exactly
 *             this. Raycast NON-recursively: a wireframe overlay is a child of it,
 *             and picking must not hit the wireframe.
 * @param el   the element pointer coordinates are relative to (the figure's canvas)
 */
export function createVertexPicker(axes: Axes, mesh: Mesh, el: HTMLElement): VertexPicker {
  let raycaster: Raycaster | null = new Raycaster()
  const ndc = new Vector2()
  const localHit = new Vector3()
  const va = new Vector3()
  const vb = new Vector3()
  const vc = new Vector3()
  const worldVertex = new Vector3()
  const worldNormal = new Vector3()

  const pick = (clientX: number, clientY: number): VertexPickResult | null => {
    if (!raycaster) return null

    setNdcFromClient(ndc, el, clientX, clientY)
    raycaster.setFromCamera(ndc, axes.camera)
    const hits = raycaster.intersectObject(mesh as unknown as Object3D, false)
    if (hits.length === 0) return null
    const hit = hits[0]
    const face = hit.face
    if (!face) return null

    localHit.copy(hit.point)
    mesh.worldToLocal(localHit)

    const pos = mesh.geometry.attributes.position
    va.fromBufferAttribute(pos as never, face.a)
    vb.fromBufferAttribute(pos as never, face.b)
    vc.fromBufferAttribute(pos as never, face.c)

    const dA = localHit.distanceToSquared(va)
    const dB = localHit.distanceToSquared(vb)
    const dC = localHit.distanceToSquared(vc)

    let vertexId: number
    let localPos: Vector3
    if (dA <= dB && dA <= dC) { vertexId = face.a; localPos = va }
    else if (dB <= dC) { vertexId = face.b; localPos = vb }
    else { vertexId = face.c; localPos = vc }

    worldVertex.copy(localPos)
    mesh.localToWorld(worldVertex)
    worldNormal.copy(face.normal).transformDirection(mesh.matrixWorld)

    return {
      vertexId,
      worldPos: [worldVertex.x, worldVertex.y, worldVertex.z],
      normal: [worldNormal.x, worldNormal.y, worldNormal.z],
    }
  }

  return { pick, dispose: () => { raycaster = null } }
}
