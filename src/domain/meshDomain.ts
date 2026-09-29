import type { BufferGeometry } from 'three/webgpu'
import type { Bounds } from '../limits'
import type { Domain } from './Domain'
import { pointsDomain, type PointsDomain } from './pointsDomain'

/** A mesh domain — `pointsDomain`'s addressing, plus the geometry whose index
 *  buffer carries the topology. */
export interface MeshDomain extends Domain {
  readonly geometry: BufferGeometry
  /**
   * Move every vertex — the shared half of a display morph (smoothing, inflation).
   *
   * ONE write that every drawable on this domain follows, which is the correctness
   * this type exists for. Before it, inflating a cortex meant calling
   * `Surface.setPositions`, `Quiver.setAnchors` and `Particles.setPositions` in
   * step, because each held its own copy of the same vertices; miss one and its
   * glyphs stay at the folded position and visibly float off the moved surface.
   *
   * Writes the geometry's own attribute too, so the surface and the glyphs move
   * together. NORMALS are not recomputed here — a lit `Surface` must reshade, but
   * that is a rendering concern of the drawable and a point cloud on the same
   * domain has no normals at all. `Surface.setPositions` handles it.
   */
  setPositions(p: Float32Array): void
  dispose(): void
}

/**
 * The domain of a triangulated mesh.
 *
 * **The extent is fixed at construction and `setPositions` does NOT re-derive
 * it.** Deliberate, and inherited from `Surface.setPositions`, whose own note
 * explains why: the axes framed the folded mesh, and re-framing on every tick of a
 * smoothing slider makes the surface appear to breathe rather than to inflate.
 *
 * Bounds come from the geometry's bounding box rather than from a scan of the
 * points, so a geometry that already computed one does not pay twice.
 */
export function meshDomain(geometry: BufferGeometry): MeshDomain {
  const attr = geometry.attributes.position
  if (!attr) throw new Error('meshDomain: geometry has no position attribute')

  const points: PointsDomain = pointsDomain(attr.array as Float32Array)

  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const bb = geometry.boundingBox!
  const extent: Bounds = {
    xlim: [bb.min.x, bb.max.x],
    ylim: [bb.min.y, bb.max.y],
    zlim: [bb.min.z, bb.max.z],
  }

  return {
    geometry,
    count: points.count,
    bounds: () => extent,
    positionAt: (index) => points.positionAt(index),

    setPositions(p: Float32Array): void {
      if (p.length !== points.count * 3) {
        throw new Error(`meshDomain.setPositions: ${p.length / 3} vertices != ${points.count}`)
      }
      points.setPositions(p)
      ;(attr.array as Float32Array).set(p)
      attr.needsUpdate = true
    },

    dispose: () => points.dispose(),
  }
}
