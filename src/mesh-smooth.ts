/**
 * Laplacian mesh smoothing — the umbrella operator, iterated.
 *
 * A port of Brainstorm's `tess_smooth.m` (Francois Tadel, 2012-2013), which is what
 * "inflate the cortex to see into the sulci" means in that ecosystem. One step is
 *
 *     v' = (1 − a)·v + (a / deg(v)) · Σ_{u ∈ N(v)} u
 *
 * i.e. each vertex moves a fraction `a` of the way toward the centroid of its
 * neighbours. `tess_smooth` writes this as a sparse matrix `A = (1−a)I + a·D⁻¹·adj`
 * and applies `A` n times; the loop below is the same operator, without building the
 * matrix.
 *
 * **The adjacency is BINARY** — `spones(VertConn)` upstream. That is not incidental:
 * an interior edge is shared by two triangles, so accumulating straight from the face
 * list counts it twice and weights a vertex's neighbours by how many faces they happen
 * to share with it. On a cortical mesh that biases the flow toward high-valence
 * regions, which is exactly where the folding is. Hence `buildVertexAdjacency`
 * deduplicates.
 *
 * **`keepSize` is not cosmetic.** Laplacian smoothing SHRINKS — every vertex moves
 * inward toward its neighbourhood, so the surface contracts a little on every
 * iteration and a strongly smoothed cortex ends up visibly smaller than the head it
 * came from. Rescaling the result to the original bounding box is upstream's fix
 * (`isKeepSize`, default on) and it is what makes a smoothing slider feel like
 * inflation rather than like zooming out.
 *
 * DOMAIN-FREE: this knows vertices and triangles, not cortices. It is also a DISPLAY
 * transform and nothing else — see `Surface.setPositions`.
 */

/** Neighbour lists in CSR form: vertex `v`'s neighbours are
 *  `neighbours[offsets[v] .. offsets[v+1])`. */
export interface VertexAdjacency {
  offsets: Uint32Array
  neighbours: Uint32Array
}

/**
 * Undirected, DEDUPLICATED vertex adjacency from a triangle index buffer.
 *
 * Costs one pass to count, one to fill and one to unique — worth doing once and
 * keeping, because it depends only on the topology and a smoothing slider changes
 * neither the faces nor the vertex count.
 */
export function buildVertexAdjacency(indices: ArrayLike<number>, count: number): VertexAdjacency {
  const nF = Math.floor(indices.length / 3)
  // Pass 1 — degree with duplicates, to size the CSR.
  const deg = new Uint32Array(count)
  for (let f = 0; f < nF; f++) {
    const a = indices[f * 3], b = indices[f * 3 + 1], c = indices[f * 3 + 2]
    deg[a] += 2; deg[b] += 2; deg[c] += 2
  }
  const raw = new Uint32Array(count + 1)
  for (let v = 0; v < count; v++) raw[v + 1] = raw[v] + deg[v]
  // Pass 2 — fill, both directions per edge.
  const fill = new Uint32Array(count)
  const buf = new Uint32Array(raw[count])
  const put = (u: number, w: number): void => { buf[raw[u] + fill[u]++] = w }
  for (let f = 0; f < nF; f++) {
    const a = indices[f * 3], b = indices[f * 3 + 1], c = indices[f * 3 + 2]
    put(a, b); put(a, c); put(b, a); put(b, c); put(c, a); put(c, b)
  }
  // Pass 3 — sort each row and drop duplicates, compacting in place.
  const offsets = new Uint32Array(count + 1)
  let w = 0
  for (let v = 0; v < count; v++) {
    const s = raw[v], e = raw[v] + fill[v]
    const row = buf.subarray(s, e)
    row.sort()
    offsets[v] = w
    let prev = -1
    for (let i = 0; i < row.length; i++) {
      const n = row[i]
      // A degenerate face can list a vertex twice; a self-loop would pull a vertex
      // toward itself and silently weaken the operator at exactly that vertex.
      if (n !== prev && n !== v) { buf[w++] = n; prev = n }
    }
  }
  offsets[count] = w
  return { offsets, neighbours: buf.slice(0, w) }
}

export interface SmoothOptions {
  /** `a` in the step above — 0 leaves the mesh alone, 1 replaces each vertex with its
   *  neighbourhood centroid. Upstream's parameter, same meaning and same range. */
  weight?: number
  /** How many times to apply it. The strength knob: iterations move the surface much
   *  further than `weight` does, since the operator's effect compounds. */
  iterations?: number
  /**
   * Rescale the result to the original bounding box, per axis. Default TRUE, as
   * upstream — see the header on why smoothing shrinks.
   */
  keepSize?: boolean
}

/**
 * Smooth `positions` (`[n·3]`, xyz interleaved) and return a NEW array. The input is
 * never modified: the caller's copy is normally the mesh's real geometry, and a
 * display transform that edited it in place would change what every other reader of
 * that mesh sees.
 */
export function smoothVertices(
  positions: Float32Array,
  adj: VertexAdjacency,
  opts: SmoothOptions = {},
): Float32Array {
  const a = Math.min(1, Math.max(0, opts.weight ?? 0.5))
  const iterations = Math.max(0, Math.floor(opts.iterations ?? 0))
  const keepSize = opts.keepSize !== false
  const n = adj.offsets.length - 1

  let cur = Float32Array.from(positions)
  if (iterations === 0 || a === 0) return cur

  let next = new Float32Array(cur.length)
  const { offsets, neighbours } = adj
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < n; v++) {
      const s = offsets[v], e = offsets[v + 1]
      const i = v * 3
      if (e === s) {
        // Isolated vertex: upstream divides by `eps` rather than by zero, which sends
        // it to infinity. Leaving it put is the same intent without the NaN.
        next[i] = cur[i]; next[i + 1] = cur[i + 1]; next[i + 2] = cur[i + 2]
        continue
      }
      let sx = 0, sy = 0, sz = 0
      for (let k = s; k < e; k++) {
        const j = neighbours[k] * 3
        sx += cur[j]; sy += cur[j + 1]; sz += cur[j + 2]
      }
      const f = a / (e - s), g = 1 - a
      next[i] = g * cur[i] + f * sx
      next[i + 1] = g * cur[i + 1] + f * sy
      next[i + 2] = g * cur[i + 2] + f * sz
    }
    const swap = cur; cur = next; next = swap
  }

  if (keepSize) rescaleToBounds(cur, positions, n)
  return cur
}

/** Scale `out` about its own centroid so its bounding box spans what `ref`'s does,
 *  per axis — upstream's `isKeepSize` branch. */
function rescaleToBounds(out: Float32Array, ref: Float32Array, n: number): void {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const rlo = [Infinity, Infinity, Infinity], rhi = [-Infinity, -Infinity, -Infinity]
  const mean = [0, 0, 0]
  for (let v = 0; v < n; v++) {
    for (let d = 0; d < 3; d++) {
      const x = out[v * 3 + d], r = ref[v * 3 + d]
      if (x < lo[d]) lo[d] = x
      if (x > hi[d]) hi[d] = x
      if (r < rlo[d]) rlo[d] = r
      if (r > rhi[d]) rhi[d] = r
      mean[d] += x
    }
  }
  for (let d = 0; d < 3; d++) mean[d] /= n || 1
  const scale = [0, 0, 0]
  for (let d = 0; d < 3; d++) {
    const span = hi[d] - lo[d]
    // A degenerate axis (a flat mesh) has nothing to restore; leave it alone rather
    // than dividing by zero and sending the surface to infinity.
    scale[d] = span > 0 ? (rhi[d] - rlo[d]) / span : 1
  }
  for (let v = 0; v < n; v++) {
    for (let d = 0; d < 3; d++) {
      const i = v * 3 + d
      out[i] = (out[i] - mean[d]) * scale[d] + mean[d]
    }
  }
}
