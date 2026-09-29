// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { cos, float, int, sin, vec3 } from 'three/tsl'
import type { Bounds, Limits, ParametricDomain } from 'threecharts'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PolarOptions {
  /** Radial range. Default `[0, 1]`; a non-zero `r0` makes it an annulus. */
  radius?: Limits
  /** Angular range in RADIANS, measured from +x. Default a full turn. */
  angle?: Limits
  /** Where the pole sits in data coordinates. Default the origin. */
  center?: readonly [number, number]
}

/**
 * A polar lattice, **`[nθ × nr]` — angle first**, embedded into the plane.
 *
 * Angle is the FIRST (fastest) axis so that `positionAt` and `positionAtUV` agree
 * about which parameter is which, and so that `u` means the same thing to every
 * drawable: the sweep. A `Band` reads `u` as its parameter and `v` as its
 * boundary, which makes a rose come out right; an `Image` reads `u` as its column
 * and `v` as its row. Getting this backwards produced a domain whose two placement
 * methods disagreed — invisible while `nr = 1`, wrong the moment it was not.
 */
export interface PolarDomain extends ParametricDomain {
  readonly shape: readonly [nTheta: number, nRadius: number]
  readonly radius: Limits
  readonly angle: Limits
}

const TAU = Math.PI * 2

/**
 * The axis-aligned box of an annular sector.
 *
 * Not the disc's box: a 90° wedge that used it would frame with three quadrants of
 * empty space. The extremes of `(r cos θ, r sin θ)` over `r ∈ [r0, r1]`,
 * `θ ∈ [θ0, θ1]` are at the four corners, PLUS wherever the sweep crosses an axis
 * — where a coordinate reaches ±r1 and no corner records it.
 */
function sectorBounds(
  [r0, r1]: Limits,
  [a0, a1]: Limits,
  [cx, cy]: readonly [number, number],
): Bounds {
  const xs: number[] = []
  const ys: number[] = []
  for (const r of [r0, r1]) {
    for (const a of [a0, a1]) { xs.push(r * Math.cos(a)); ys.push(r * Math.sin(a)) }
  }
  // Axis crossings inside the sweep, in whichever turn the sweep occupies.
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1)
  for (let k = Math.floor(lo / (Math.PI / 2)); k <= Math.ceil(hi / (Math.PI / 2)); k++) {
    const a = k * (Math.PI / 2)
    if (a < lo || a > hi) continue
    xs.push(r1 * Math.cos(a)); ys.push(r1 * Math.sin(a))
  }
  return {
    xlim: [cx + Math.min(...xs), cx + Math.max(...xs)],
    ylim: [cy + Math.min(...ys), cy + Math.max(...ys)],
    zlim: [0, 0],
  }
}

/**
 * A POLAR domain — the curvilinear case.
 *
 * Its addressing is a lattice, exactly as a rectilinear grid's is: `(ir, iθ)`,
 * first axis fastest, neighbours implicit in the shape. What differs is the
 * EMBEDDING — `(r, θ) → (r cos θ, r sin θ)` instead of the identity — which is the
 * single method FOUNDATIONS R2 says separates the categories.
 *
 * Everything that reads a domain therefore works on it unchanged. A quiver on a
 * polar lattice is a polar vector field; particles on one are a polar scatter;
 * markers are a compass rose. None of those is a new primitive, and none of them
 * required a line of the library to change — which is the claim this file exists
 * to test rather than assert.
 *
 * **Angles are radians from +x, counter-clockwise**, and the default sweep is a
 * full turn. Note that `θ` at the two ends of a full turn addresses the SAME
 * direction, so a full-turn lattice does not duplicate a column: `nθ` cells cover
 * the turn at `2π/nθ` apart, and the seam falls between the last cell and the
 * first. That is the periodicity FOUNDATIONS R7 names as an input to the
 * Laplacian — this domain has no Laplacian yet, so it is recorded here rather
 * than expressed.
 */
export function polarDomain(
  shape: readonly [number, number],
  opts: PolarOptions = {},
): PolarDomain {
  const [nt, nr] = shape
  if (!Number.isInteger(nr) || !Number.isInteger(nt) || nr < 1 || nt < 1) {
    throw new Error(`polarDomain: shape must be positive integers, got [${nr}, ${nt}]`)
  }
  const radius = opts.radius ?? ([0, 1] as Limits)
  const angle = opts.angle ?? ([0, TAU] as Limits)
  const center = opts.center ?? ([0, 0] as const)
  const bounds = sectorBounds(radius, angle, center)

  /** Cell centre along one axis — the same `(k + ½)/n` a rectilinear grid uses. */
  const centre = (idx: any, n: number, [lo, hi]: Limits): any =>
    idx.toFloat().add(float(0.5)).div(float(n)).mul(float(hi - lo)).add(float(lo))

  return {
    shape,
    radius,
    angle,
    // Edges are ARCS: a region over this must be subdivided or it draws as a bowtie.
    affine: false,
    count: nt * nr,
    bounds: () => bounds,

    /**
     * Continuous placement, which is what lets a `Band` draw on this domain — and
     * a band on a polar lattice IS a rose diagram or a filled radar chart. The
     * capability costs four lines here because polar's `positionAt` was already a
     * continuous function of `(r, θ)`, merely sampled at cell centres.
     *
     * `u` sweeps the angle, `v` the radius — so a band's boundaries are radii and
     * its parameter is θ, which is the reading that makes a rose come out right.
     */
    positionAtUV(u: unknown, v: unknown): unknown {
      const lerp = (t: any, [lo, hi]: Limits): any => float(t).mul(float(hi - lo)).add(float(lo))
      const a: any = lerp(u, angle)
      const r: any = lerp(v, radius)
      return vec3(
        r.mul(cos(a)).add(float(center[0])),
        r.mul(sin(a)).add(float(center[1])),
        float(0),
      )
    },

    positionAt(index: unknown): unknown {
      const i = int(index as any)
      const a = centre(i.mod(int(nt)), nt, angle)     // angle is the FAST axis
      const r = centre(i.div(int(nt)), nr, radius)
      return vec3(
        r.mul(cos(a)).add(float(center[0])),
        r.mul(sin(a)).add(float(center[1])),
        float(0),
      )
    },
  }
}
