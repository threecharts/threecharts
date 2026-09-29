/**
 * arrowShape — ONE definition of the quiver arrow, in normalized glyph units:
 * tail at x = 0, tip at x = 1, centred on y = 0.
 *
 * The dimensions are named rather than inlined because the geometry is built from
 * them and they are the knobs anyone would reach for. It briefly served a second
 * renderer too — an SVG outline for the legend's reference arrow — which is why the
 * shape and its measurements were separated in the first place; that legend is gone,
 * and the separation is still the readable way to write it.
 */
import { BufferGeometry, BufferAttribute } from 'three/webgpu'

/** The silhouette's control dimensions. Everything below is derived from these. */
export const ARROW = {
  /** Half-thickness of the shaft. */
  shaftHalf: 0.05,
  /** Half-height of the head at its base. */
  headHalf: 0.18,
  /** Where the head's base sits along the arrow. */
  headStart: 0.5,
  /** How far the shaft is drawn. It overshoots `headStart` so the two overlap and
   *  no seam shows between them at any scale. */
  shaftEnd: 0.6,
} as const

/**
 * The GPU geometry: three triangles (two for the shaft, one for the head), the form
 * `Quiver`'s vertex shader positions and orients per glyph.
 */
export function arrowGeometry(): BufferGeometry {
  const { shaftHalf: s, headHalf: h, headStart: hs, shaftEnd: se } = ARROW
  const pos = new Float32Array([
    // shaft
    0, -s, 0, se, -s, 0, se, s, 0,
    0, -s, 0, se, s, 0, 0, s, 0,
    // head
    hs, -h, 0, 1, 0, 0, hs, h, 0,
  ])
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  return g
}

