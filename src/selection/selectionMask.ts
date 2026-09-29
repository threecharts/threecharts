/**
 * The selection substrate — a `Float32Array(nV)` in `0..1`, indexed by vertex.
 *
 * Binary `0|1` today; `0..1` is reserved for SOFT selection, which is why the compose
 * ops are float `min`/`max` rather than boolean. That is not speculative here: a
 * selection grown from the eigenbasis is band-limited by construction, so its boundary
 * arrives feathered whether or not anyone asked for it.
 *
 * Structurally identical to a per-vertex scalar field and deliberately not one — a
 * field is data about the subject, a selection is ephemeral state about the session.
 * They are the same shape because `Surface` consumes both as a per-vertex buffer.
 *
 * Ported from the deprecated `@nxr/charts-webgpu`'s `mesh/interaction/SelectionMask`,
 * unchanged apart from naming: it was already pure, already framework-free, and had
 * nothing to do with the WASM the rest of that layer leaned on.
 */

/** Photoshop-style compose modifiers. */
export type ComposeOp = 'replace' | 'add' | 'subtract' | 'intersect'

/** Allocate a zeroed mask of length `n`. */
export function createMask(n: number): Float32Array {
  return new Float32Array(n)
}

/** An independent copy. */
export function cloneMask(mask: Float32Array): Float32Array {
  return mask.slice()
}

/** Compose `contribution` into `target` IN PLACE. Both must be the same length. */
export function composeMask(
  target: Float32Array,
  contribution: Float32Array,
  op: ComposeOp,
): Float32Array {
  if (target.length !== contribution.length) {
    throw new RangeError(
      `composeMask: length mismatch (target ${target.length}, contribution ${contribution.length})`,
    )
  }
  const n = target.length
  switch (op) {
    case 'replace':
      target.set(contribution)
      break
    case 'add':
      for (let i = 0; i < n; i++) target[i] = Math.max(target[i], contribution[i])
      break
    case 'subtract':
      for (let i = 0; i < n; i++) target[i] = Math.min(target[i], 1 - contribution[i])
      break
    case 'intersect':
      for (let i = 0; i < n; i++) target[i] = Math.min(target[i], contribution[i])
      break
  }
  return target
}

/** How many vertices are selected at all. */
export function maskCount(mask: Float32Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) n++
  return n
}

/** AABB of the selected vertices in the geometry's own frame, or `null` if none.
 *  `positions` is the flat `geometry.attributes.position` array (length `nV × 3`). */
export function maskBounds(
  mask: Float32Array,
  positions: ArrayLike<number>,
): { min: [number, number, number]; max: [number, number, number] } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let any = false
  for (let v = 0; v < mask.length; v++) {
    if (mask[v] <= 0) continue
    any = true
    const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  if (!any) return null
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}

/** A mask with exactly the listed vertices set. The common contribution shape — one
 *  click, one vertex — and what keeps `attachVertexSelect` free of loops. */
export function maskFromVertices(n: number, ids: Iterable<number>): Float32Array {
  const m = createMask(n)
  for (const v of ids) if (v >= 0 && v < n) m[v] = 1
  return m
}

/** The vertices a mask selects, ascending. */
export function verticesFromMask(mask: Float32Array): number[] {
  const out: number[] = []
  for (let v = 0; v < mask.length; v++) if (mask[v] > 0) out.push(v)
  return out
}
