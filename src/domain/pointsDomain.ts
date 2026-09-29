// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray, vec3, int } from 'three/tsl'
import { asReadOnly } from '../storage-access'
import type { Bounds, Limits } from '../limits'
import type { Domain } from './Domain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A domain whose positions this module owns and can rewrite. */
export interface PointsDomain extends Domain {
  /** Move every point. ONE write that every drawable on this domain follows. */
  setPositions(p: Float32Array): void
  /** The CPU-side positions, so a host can keep picking consistent with what is
   *  drawn without a second copy of its own. */
  readonly values: Float32Array
  dispose(): void
}

/** Axis-aligned extent of an `[N × 3]` position array. */
function extentOf(v: Float32Array): Bounds {
  if (v.length === 0) return { xlim: [0, 1], ylim: [0, 1], zlim: [0, 1] }
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const x = v[i + c]
      if (x < lo[c]) lo[c] = x
      if (x > hi[c]) hi[c] = x
    }
  }
  const span = (c: number): Limits => (lo[c] <= hi[c] ? [lo[c], hi[c]] : [0, 1])
  return { xlim: span(0), ylim: span(1), zlim: span(2) }
}

/**
 * An UNSTRUCTURED domain: `N` addresses at explicit positions, no topology.
 *
 * The addressing a scattered point cloud, a set of sensors, or a mesh's vertices
 * all share. `meshDomain` is this plus a geometry whose index buffer supplies the
 * topology — which nothing in the three-member contract needs yet, and which is
 * why the position handling lives here rather than there.
 *
 * **The extent is computed ONCE, on the CPU, at construction.** That is what
 * removes the `_boundsNull` case for callers who hand over values: a drawable
 * given a bare `Float32Array` of anchors used to contribute nothing to auto-limits
 * because it had no way to measure them, and measuring `[N × 3]` floats once is
 * cheap next to uploading them. Only an EXTERNAL storage node is genuinely
 * unmeasurable from the host, and that case still needs explicit extents.
 *
 * **The buffer uploads lazily**, on the first `positionAt` — a domain nothing
 * plots glyphs on should not allocate a GPU copy of its points.
 *
 * `setPositions` does NOT re-derive the extent; see `meshDomain` for why.
 */
export function pointsDomain(positions: Float32Array): PointsDomain {
  if (positions.length % 3 !== 0) {
    throw new Error(`pointsDomain: ${positions.length} floats is not a whole number of xyz triples`)
  }
  const count = positions.length / 3
  const values = Float32Array.from(positions)
  const extent = extentOf(values)

  let node: any = null

  /* A FLAT `float` buffer indexed 3i/3i+1/3i+2, NOT `vec3` — carried over verbatim
     from `Quiver`'s anchor path, where the reason is recorded at length: a `vec3`
     storage buffer renders correctly on its first upload and then CORRUPTS on any
     rewrite (measured as glyphs collapsing onto the coordinate axes, and after an
     allocation fix as them vanishing outright). `float` is the shape proven to
     survive a rewrite in this package — `vertex-mask.ts` does the same — and a
     rewrite is exactly what `setPositions` is. Three scalar reads per address is
     the price of staying on the path that works. */
  const ensure = (): any => {
    if (!node) node = asReadOnly((attributeArray as (d: unknown, t: string) => any)(values, 'float'))
    return node
  }

  return {
    count,
    values,
    bounds: () => extent,

    positionAt(index: unknown): unknown {
      const buf = ensure()
      const b = int(index as any).mul(int(3))
      return vec3(buf.element(b), buf.element(b.add(int(1))), buf.element(b.add(int(2))))
    },

    setPositions(p: Float32Array): void {
      if (p.length !== count * 3) {
        throw new Error(`setPositions: ${p.length / 3} points != ${count}`)
      }
      values.set(p)
      // Only when something has actually asked for positions; otherwise there is
      // no GPU copy to keep in step.
      if (node) (node.value as { needsUpdate: boolean }).needsUpdate = true
    },

    dispose(): void {
      if (node) (node.value as { dispose?: () => void }).dispose?.()
      node = null
    },
  }
}
