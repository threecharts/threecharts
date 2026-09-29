/** A closed value interval `[min, max]` on one axis. */
export type Limits = [min: number, max: number]

/** A drawable's data extent in data coordinates. `zlim` is present only for 3D
 *  drawables; 2D drawables omit it and a 3D axes then defaults z to [0,1]. */
export type Bounds = { xlim: Limits; ylim: Limits; zlim?: Limits }

/** Smallest bounds containing every input (for `xlim: 'auto'`). Null if empty.
 *  `zlim` is included only if at least one input carries one. */
export function unionBounds(bs: Bounds[]): Bounds | null {
  if (bs.length === 0) return null
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  let z0 = Infinity, z1 = -Infinity, hasZ = false
  for (const b of bs) {
    x0 = Math.min(x0, b.xlim[0]); x1 = Math.max(x1, b.xlim[1])
    y0 = Math.min(y0, b.ylim[0]); y1 = Math.max(y1, b.ylim[1])
    if (b.zlim) { hasZ = true; z0 = Math.min(z0, b.zlim[0]); z1 = Math.max(z1, b.zlim[1]) }
  }
  const out: Bounds = { xlim: [x0, x1], ylim: [y0, y1] }
  if (hasZ) out.zlim = [z0, z1]
  return out
}

/** Grow an interval about its center by `pad` (>=1). A zero-width interval pads
 *  to a unit-ish span so the auto camera never collapses. */
export function padLimits([lo, hi]: Limits, pad: number): Limits {
  const c = (lo + hi) / 2
  const half = (hi - lo) / 2 || 0.5
  return [c - half * pad, c + half * pad]
}

/** Expand an interval so `[lo, hi]` occupies the fraction `[loFrac, 1 - hiFrac]`
 *  of the axis — i.e. reserve `loFrac`/`hiFrac` of the span for chrome margins.
 *  Mapping the returned interval to `[0, 1]` places `lo` at `loFrac` and `hi` at
 *  `1 - hiFrac`. Used to keep FIXED-PIXEL margins for ticks/titles regardless of
 *  aspect ratio (symmetric data-padding gives too-small pixel margins on a wide
 *  canvas). Margins are clamped so the data never inverts. */
export function expandForMargins([lo, hi]: Limits, loFrac: number, hiFrac: number): Limits {
  const span = hi - lo || 1
  const inner = Math.max(0.05, 1 - loFrac - hiFrac)   // data occupies this fraction
  const full = span / inner
  const elo = lo - loFrac * full
  return [elo, elo + full]
}
