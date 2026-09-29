import { Group, PlaneHelper, type Plane } from 'three/webgpu'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds } from './limits'

export interface ClipHelperOptions {
  /** Edge length of the drawn square, in DATA units. Default 1. A helper is a
   *  read-out of an infinite plane, so its size says nothing about the plane —
   *  pick something that spans the thing being cut. */
  size?: number
  /** Outline colour. Default `0xffff00`, three's own helper yellow. */
  color?: number
}

/**
 * `ClipHelper` — WHERE a clipping plane is, drawn.
 *
 * A clip plane is invisible by construction: it removes fragments and leaves no
 * mark of its own, so a reader dragging one is inferring its position from what
 * has stopped being drawn. That works while something IS being cut and fails
 * completely at the ends of the travel, where the plane is outside the geometry
 * and nothing changes at all. The helper is what makes the control legible.
 *
 * IT WRAPS three's OWN `PlaneHelper` rather than reimplementing it, which is the
 * point: the reference for this interaction is `webgl_clipping_intersection`, and
 * matching what that example shows is worth more than a house style. It is a
 * translucent square with an outline and a stalk along the normal, and it TRACKS
 * the plane — `PlaneHelper.updateMatrixWorld` re-derives its transform from
 * `plane.normal` and `plane.constant` every frame, so moving a plane moves its
 * helper with no code here at all.
 *
 * NOT CLIPPED BY ITS OWN PLANE, and it must not be: a helper that cut itself in
 * half would vanish exactly when it is being used.
 *
 * `dataBounds` is null on purpose. A helper is chrome — letting it into the
 * axes' `auto` limits would let the size chosen for legibility re-frame the
 * camera, and a reader would watch the scene zoom out as they turned a display
 * toggle on.
 */
export class ClipHelper extends Drawable {
  private readonly _helpers: PlaneHelper[] = []

  constructor(axes: Axes, planes: readonly Plane[], opts: ClipHelperOptions = {}) {
    const group = new Group()
    super(axes, group)
    const size = opts.size ?? 1
    const color = opts.color ?? 0xffff00
    for (const p of planes) {
      const h = new PlaneHelper(p, size, color)
      /* The helper's own mesh is a `MeshBasicMaterial` with `side: DoubleSide`
         and `toneMapped: false` — three's choices, kept. What is NOT kept is
         inheriting the axes' clipping: a `ClippingGroup` cuts its descendants,
         and this one hangs off the axes node like any drawable, so it is put in
         its own group with no planes rather than under the surfaces'. */
      h.renderOrder = 2
      this._helpers.push(h)
      group.add(h)
    }
  }

  /** Chrome, not data — see the class note. */
  dataBounds(): Bounds | null { return null }

  /** Resize every square. The plane itself is untouched: a helper's extent is a
   *  display choice and an infinite plane has none. */
  setSize(size: number): void {
    for (const h of this._helpers) h.size = size
    this.invalidate()
  }

  dispose(): void {
    for (const h of this._helpers) {
      h.geometry?.dispose()
      const m = h.material as { dispose?: () => void } | undefined
      m?.dispose?.()
    }
    this._helpers.length = 0
    super.dispose()
  }
}
