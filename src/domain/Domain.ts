import type { Bounds } from '../limits'

/**
 * A DOMAIN is what a field is defined on: a set of addresses, and where each one
 * sits in space.
 *
 * Today the geometry a drawable plots on is IMPLIED by which drawable class it
 * is — `Image` means a plane, `Surface` means a mesh, `Volume` means voxels —
 * and anything that needs to know where address `i` is re-derives it privately.
 * `Quiver` contains three separate `positionNode` builds for that reason, and
 * `Particles` a fourth. A domain is that knowledge named once, so a drawable can
 * ASK rather than re-implement.
 *
 * Three members, and the count is the point: an interface whose implementations
 * differ in exactly one method is a real abstraction, while one that grows a
 * member per case is a fiction. Rectilinear, curvilinear and unstructured
 * geometries differ ONLY in `positionAt` — computed from strides, read from a
 * buffer with implicit topology, or read from a buffer with an explicit index.
 * If a fourth member is ever proposed, the question to ask first is whether it
 * belongs to the drawable instead: colormap, opacity, glyph scale and line width
 * will all try to migrate in here, and none of them is a property of the space.
 *
 * See `docs/FOUNDATIONS.md` §1.1 and R1–R3. Positions are NOT part of a domain
 * in that model — they are an embedding of it, and `positionAt` is the one
 * embedding this interface currently exposes. When a second embedding of the same
 * addressing is needed (a cortex and its inflated twin), that is where this type
 * splits, and the split is expected rather than a surprise.
 */
export interface Domain {
  /**
   * How many addresses exist.
   *
   * Turns a runtime `throw` into a structural check: `Quiver` currently errors at
   * construction when its anchor count disagrees with its vector count, because
   * nothing else could have caught it.
   */
  readonly count: number

  /**
   * The extent this domain occupies, in data coordinates.
   *
   * This is what makes auto-limits work. A drawable that cannot answer it
   * contributes nothing to the axes' framing — which is exactly the defect the
   * `_boundsNull` flags in `Quiver` and `Particles` encoded, both of them
   * commented "defer framing to the surface" with no way to name the surface.
   */
  bounds(): Bounds

  /**
   * Where address `index` sits, as a TSL node evaluating to a `vec3`.
   *
   * `index` is itself a node — `instanceIndex` in an instanced draw,
   * `vertexIndex` in a vertex stage — so this composes into whatever stage the
   * caller is building.
   */
  positionAt(index: unknown): unknown
}

/** A domain whose positions can be rewritten — the shared half of a display morph. */
export interface MovableDomain extends Domain {
  setPositions(p: Float32Array): void
}

/** Whether this domain's positions can be moved. False for a domain whose
 *  positions live in a buffer the host owns and we may only read. */
export function isMovable(d: Domain): d is MovableDomain {
  return typeof (d as Partial<MovableDomain>).setPositions === 'function'
}

/**
 * A domain that can be addressed CONTINUOUSLY, not only at its samples.
 *
 * `positionAt` answers "where is address `i`". Some drawables need "where is the
 * point 40% along, at height 0.7" — a filled region's boundary sits BETWEEN
 * addresses, at a height the data chooses. `Band` is the first such case and the
 * reason this exists.
 *
 * **An optional capability, not a fourth member of `Domain`** — the same shape as
 * `isMovable`, and for the same reason: most domains and most drawables never need
 * it, and §5's tripwire says a member that only some implementations can honour
 * belongs behind a check rather than in the contract. A lattice and a polar domain
 * supply it trivially (polar's `positionAt` is already a continuous function of
 * `(r, θ)` merely sampled at cell centres). A MESH cannot, and should not: a band
 * across an unstructured vertex set has no meaning, so the check rejects it rather
 * than producing a plausible-looking wrong picture.
 *
 * This is Q4 — continuous versus discrete — answered with a real case in hand
 * rather than in the abstract, and answered by ADDING a capability rather than by
 * changing what a domain fundamentally is.
 */
export interface ParametricDomain extends Domain {
  /**
   * Position at normalised parameters, each in `[0, 1]` across the domain's own
   * extent along that axis. `u` runs along the first axis, `v` the second.
   */
  positionAtUV(u: unknown, v: unknown): unknown

  /**
   * Whether straight lines in parameter space stay straight in ambient space.
   *
   * A lattice is affine; polar, a map projection and any warped grid are not. It
   * exists so a drawable that covers a REGION knows whether four corners describe
   * it. A raster on a lattice is two triangles; the same raster on a polar domain
   * drawn as two triangles is a bowtie, because its edges are arcs.
   *
   * Optional, and **absence means NOT affine** — the safe default. A domain that
   * says nothing gets subdivided, which is correct if slower; the reverse would be
   * silently wrong for exactly the domains most likely to be contributed.
   */
  readonly affine?: boolean
}

/** Whether this domain can be addressed between its samples. */
export function isParametric(d: Domain): d is ParametricDomain {
  return typeof (d as Partial<ParametricDomain>).positionAtUV === 'function'
}
