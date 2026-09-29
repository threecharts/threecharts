// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { float, int, vec3 } from 'three/tsl'
import type { Bounds, Limits } from '../limits'
import type { ParametricDomain } from './Domain'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A RECTILINEAR domain: a regular lattice over an axis-aligned box. */
export interface GridDomain extends ParametricDomain {
  /** Samples per axis, FIRST AXIS FASTEST — `[nx, ny]` or `[nx, ny, nz]`. */
  readonly shape: readonly number[]
  /** The box each axis spans. */
  readonly extents: readonly Limits[]
}

/**
 * The rectilinear case — and the one where the array shape IS the addressing.
 *
 * Nothing is stored. Where an unstructured domain reads a position out of a
 * buffer, this one COMPUTES it from strides, which is the single difference
 * FOUNDATIONS R2 says separates the categories. That it needs no allocation at all
 * is the practical proof: a grid of ten million cells costs three uniforms.
 *
 * Addresses are laid out first-axis-fastest, matching the `i mod nx`,
 * `(i / nx) mod ny`, `i / (nx·ny)` decode the drawables already use, and a sample
 * sits at its CELL CENTRE rather than its corner: `(k + ½)/n` across the extent.
 * That half-cell is not cosmetic — placing a glyph at the corner biases the whole
 * field half a cell toward the origin and leaves a visible gutter on two edges.
 */
export interface GridSpec {
  /** Samples along x, y and (for a 3-D lattice) z. */
  nx: number
  ny: number
  nz?: number
  /** The interval each axis spans. Defaults to `[0, n]` — one unit per cell. */
  x?: Limits
  y?: Limits
  z?: Limits
}

/**
 * **Named axes, not a positional tuple**, and that is the whole reason this takes an
 * object.
 *
 * A lattice is described fastest-axis-first, while a raster is stored row-major —
 * so `[cols, rows]` and `[rows, cols]` are both correct, for different things, and a
 * positional form makes them indistinguishable at the call site. That produced
 * exactly one transposition bug per reader. `{ nx, ny }` has no order to get wrong.
 */
export function gridDomain(spec: GridSpec): GridDomain {
  const { nx, ny, nz } = spec
  const shape: number[] = nz == null ? [nx, ny] : [nx, ny, nz]
  if (shape.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error(`gridDomain: counts must be positive integers, got [${shape.join(', ')}]`)
  }
  const extents: Limits[] = nz == null
    ? [spec.x ?? [0, nx], spec.y ?? [0, ny]]
    : [spec.x ?? [0, nx], spec.y ?? [0, ny], spec.z ?? [0, nz]]

  const count = shape.reduce((a, b) => a * b, 1)
  const nzz = nz ?? 1

  const bounds: Bounds = {
    xlim: extents[0],
    ylim: extents[1],
    // A 2-D lattice lies on z = 0, so its z extent is degenerate rather than absent
    // — the axes unions this with other drawables and needs a number either way.
    zlim: extents[2] ?? [0, 0],
  }

  /** Cell centre along one axis, from that axis' integer index. */
  const centre = (idx: any, n: number, [lo, hi]: Limits): any =>
    idx.toFloat().add(float(0.5)).div(float(n)).mul(float(hi - lo)).add(float(lo))

  return {
    shape,
    extents,
    count,
    // A lattice maps straight to straight, so a region over it needs no subdivision.
    affine: true,
    bounds: () => bounds,

    /* Continuous placement: the same linear map `centre` performs, without the
       half-cell offset, because a boundary sits where the data puts it rather than
       at a sample. */
    positionAtUV(u: unknown, v: unknown): unknown {
      const lerp = (t: any, [lo, hi]: Limits): any =>
        float(t).mul(float(hi - lo)).add(float(lo))
      return vec3(lerp(u, extents[0]), lerp(v, extents[1]), float(extents[2]?.[0] ?? 0))
    },

    positionAt(index: unknown): unknown {
      const i = int(index as any)
      const ix = i.mod(int(nx))
      const iy = i.div(int(nx)).mod(int(ny))
      const x = centre(ix, nx, extents[0])
      const y = centre(iy, ny, extents[1])
      if (shape.length === 2) return vec3(x, y, float(0))
      const iz = i.div(int(nx * ny))
      return vec3(x, y, centre(iz, nzz, extents[2]))
    },
  }
}
