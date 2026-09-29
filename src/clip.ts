import { ClippingGroup, Plane, Vector3, type Object3D } from 'three/webgpu'

/**
 * clip.ts — PER-DRAWABLE clipping planes.
 *
 * WHY A GROUP AND NOT A MATERIAL. three's `ClippingContext` reads
 * `clippingGroup.clippingPlanes` and never consults a material's — verified
 * against three 0.183 source. There is no `localClippingEnabled` in the WebGPU
 * renderer either: a `ClippingGroup` in the scene simply gets its own context,
 * and NESTED groups get their own, which is what makes "clip the scalp and leave
 * the slice planes whole" expressible at all. (`Axes` is itself a ClippingGroup —
 * that is how the 2D clip box works.)
 *
 * THE PLANES ARE MUTATED, NOT REPLACED. A `Plane` is a live object and three
 * reads it every frame, so moving a cut is `plane.constant = …` — no rebuild, no
 * new group, and the camera survives. `Axes.syncFrame` already does exactly this
 * for its 2D box, and this follows it.
 */

/**
 * Wrap `node` in a `ClippingGroup` when there are planes to apply, else return it
 * unchanged.
 *
 * Called at CONSTRUCTION, because the group is the drawable's scene node and
 * re-parenting one later would detach it from the axes mid-frame. A drawable that
 * may ever be clipped should declare it with an empty array, exactly as
 * `Surface`'s mask and selection are declared even when empty — for the same
 * reason: the alternative is a structural change while the reader is looking.
 */
export function withClipping(
  node: Object3D,
  planes: readonly Plane[] | null | undefined,
  intersection = false,
): Object3D {
  if (!planes) return node
  const g = new ClippingGroup()
  g.clippingPlanes = planes as Plane[]
  /* UNION by default: a fragment is cut if ANY plane cuts it, which is what one
     cut plane means and what a half-head view wants. `intersection` keeps only
     what EVERY plane cuts — the corner-cut of three.js's own example, and the
     right mode for isolating a box out of a volume. */
  g.clipIntersection = intersection
  g.add(node)
  return g
}

/**
 * A plane through `point` with `normal`, in the drawable's own data space.
 *
 * three's `Plane` is `normal · x + constant = 0` and KEEPS THE HALF-SPACE WHERE
 * `normal · x + constant > 0` — so the normal points at what SURVIVES, and the
 * material is cut away behind it. Getting that backwards leaves exactly the half
 * you meant to remove, which looks like a working cut of the wrong side.
 */
export function planeThrough(
  normal: readonly [number, number, number],
  point: readonly [number, number, number],
): Plane {
  const n = new Vector3(normal[0], normal[1], normal[2]).normalize()
  return new Plane(n, -n.dot(new Vector3(point[0], point[1], point[2])))
}

/** Move an existing plane to a new point, keeping its normal. One number, live. */
export function movePlaneTo(plane: Plane, point: readonly [number, number, number]): void {
  plane.constant = -plane.normal.dot(new Vector3(point[0], point[1], point[2]))
}
