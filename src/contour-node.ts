/**
 * Screen-space contour masks — antialiased isolines over any interpolated scalar,
 * drawn entirely in the FRAGMENT shader. No line geometry, no marching squares, no
 * CPU extraction, no second draw call.
 *
 * The trick is `fwidth`. Dividing the distance-to-a-level by the fragment-local rate
 * of change gives a line whose width is constant in SCREEN PIXELS at any zoom, mesh
 * density or viewing angle — and antialiases for free, because the same quantity is
 * the width of the `smoothstep` ramp.
 *
 *     const s      = <the raw scalar varying>
 *     const fw     = fwidth(s)                              // ONCE — see below
 *     const major  = contourMask(s, fw, uInterval, uWidth)
 *     const minor  = contourMask(s, fw, minorPeriod, uMinorWidth)
 *                      .mul(contourResolvability(fw, minorPeriod))
 *
 * `fw` is a PARAMETER rather than something each mask computes, because a chart
 * drawing major + minor + zero-crossing lines needs three masks off ONE derivative.
 * The implementation this is ported from (`@nxr/charts-webgpu`'s `contourLine.ts`)
 * called `fwidth(scalar)` inside every atom and paid for it three times over.
 *
 * Three things the caller owns:
 *
 *  - **Pass the scalar in DATA UNITS**, not normalized to `[0,1]`. A clamped input
 *    has zero derivative wherever it saturates the clim, and the lines vanish
 *    exactly in the regions with the most signal.
 *  - **Call these in uniform control flow** — the top level of the fragment `Fn`.
 *    A `Discard` before them is fine: WGSL demotes a discarded invocation to a
 *    helper, which still participates in derivative computation.
 *  - **Feed them float32.** 8-bit quantization flattens `fwidth` into a staircase
 *    and the lines break up.
 *
 * Inherent limit: on a triangulated mesh the scalar is per-vertex and linearly
 * interpolated, so `fwidth` measures the INTERPOLATED gradient. Contours are
 * piecewise-linear within each triangle and read as faceted when the mesh is coarse
 * relative to the zoom. That is a property of the technique, not a tuning problem.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { fract, abs, smoothstep, float, floor } from 'three/tsl'

/**
 * Guards the division, and NOTHING ELSE.
 *
 * This was `1e-8` — a value in the SCALAR'S OWN UNITS, which quietly became the period
 * whenever a field was naturally smaller than it. A cortical current in A·m has a
 * 98th-percentile magnitude of ~5e-11, so ten bands over it give an interval of 5e-12
 * and this floor replaced it with one 2000x the entire clim span: `fract(scalar/p)`
 * came out ~0.005 everywhere and not one contour was drawn, on a surface reporting
 * contours enabled. It is the same defect the Quiver's `1e-8` clim floor was, in the
 * same units, one file over.
 *
 * A divide-by-zero guard has no business carrying a scale. This one is now far below
 * anything f32 can meaningfully contour, so it can only ever catch a zero.
 */
const MIN_PERIOD = 1e-30
/**
 * Floor on the AA ramp in PERIODS — dimensionless, so it is scale-free by construction.
 * Keeps a perfectly flat region (`fwidth` exactly 0) from collapsing `smoothstep`.
 */
const MIN_HALF_WIDTH = 1e-5

/**
 * An antialiased mask, ~1 on a contour line and 0 away from it, for lines at every
 * multiple of `period` in the scalar's own units.
 *
 * `widthPx` is a multiplier on the fragment-AA edge: `1.0` is roughly a one-pixel
 * line on most hardware.
 *
 * @param scalar  the value, in DATA units (not normalized)
 * @param fw      `fwidth(scalar)`, computed once by the caller
 * @param period  spacing between lines, in data units
 * @param widthPx line half-width, in fragments
 */
export function contourMask(scalar: any, fw: any, period: any, widthPx: any): any {
  const p = period.max(float(MIN_PERIOD))
  // Distance to the nearest level, measured in periods: `fract` folds the scalar into
  // one period, and the fold about 0.5 makes both sides of a line symmetric.
  const dist = float(0.5).sub(abs(fract(scalar.div(p)).sub(float(0.5))))
  const half = fw.div(p).mul(widthPx).mul(float(0.5)).max(float(MIN_HALF_WIDTH))
  // Descending ramp: edge0 > edge1, so dist=0 → 1 and dist ≥ half → 0.
  return smoothstep(half, float(0), dist)
}

/**
 * A `[0,1]` visibility factor that fades lines out before they alias.
 *
 * `fw / period` is how much of a period one fragment spans; past ~1 the lines are
 * closer together than the pixels that would draw them, and without this they turn
 * into moiré rather than detail. Multiply a `contourMask` by it for a minor/LOD pass
 * that only appears once you are zoomed in far enough to resolve it.
 */
export function contourResolvability(fw: any, period: any): any {
  return smoothstep(float(1.5), float(0.4), fw.div(period.max(float(MIN_PERIOD))))
}

/**
 * An antialiased mask at the scalar's ZERO level — the one contour a signed field
 * always has a reason to draw, and the one that rarely lands on a round multiple of
 * the interval.
 */
export function zeroCrossingMask(scalar: any, fw: any, widthPx: any, minHalfWidth?: any): any {
  /* Unlike the ramp in `contourMask`, this comparison happens in the SCALAR'S OWN
     UNITS — `fw·widthPx` and `|scalar|` are both data units — so a constant floor here
     is a claim about the field's magnitude. At `1e-5` against a cortical current of
     ~5e-11 the floor won every fragment, and `smoothstep(1e-5, 0, |v|)` returns 1 for
     the whole surface: the entire cortex painted as the zero line.

     So the caller supplies the floor when it knows the scale. The contour layer passes
     a fraction of its own period, which is already derived from the clim; the
     selection layer passes nothing, because its input is a 0..1 mask where a
     dimensionless constant is exactly right. */
  const floorW = minHalfWidth ?? float(MIN_HALF_WIDTH)
  return smoothstep(fw.mul(widthPx).max(floorW), float(0), abs(scalar))
}

/** The zero line's AA floor as a fraction of the contour period — so in a perfectly
 *  flat region it is at most a thousandth of a band wide instead of a fixed distance
 *  in units the drawable cannot know. */
export const ZERO_HALF_WIDTH_FRACTION = 1e-3

/**
 * Snap a scalar to the CENTRE of its contour band.
 *
 * Colormapping this instead of the raw value turns a continuous ramp into a
 * choropleth quantized to exactly the intervals the lines are drawn at — the filled
 * companion to the line masks, and free, since the colormap texture does the work.
 */
export function bandCenter(scalar: any, period: any): any {
  const p = period.max(float(MIN_PERIOD))
  return floor(scalar.div(p)).mul(p).add(p.mul(float(0.5)))
}

/** `interval: 'auto'` divides the clim into this many bands. */
export const AUTO_CONTOUR_BANDS = 10

/**
 * Resolve a contour interval against the clim it is drawn over — CPU side, so
 * `'auto'` can track a moving clim by writing a uniform rather than rebuilding.
 *
 * Anything unusable falls back to `auto`: a non-positive interval would make every
 * fragment sit on a line, which reads as a solid wash rather than as an error. The
 * span is taken as an ABSOLUTE value so an inverted clim (`d0 > d1`, which
 * legitimately flips the colormap) still yields positive spacing, and a degenerate
 * clim yields 1 rather than 0.
 */
export function resolveContourInterval(
  v: number | 'auto' | undefined,
  clim: readonly [number, number],
  bands: number = AUTO_CONTOUR_BANDS,
): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  const n = Number.isFinite(bands) && bands >= 1 ? Math.floor(bands) : AUTO_CONTOUR_BANDS
  const span = Math.abs(clim[1] - clim[0])
  return span > 0 && Number.isFinite(span) ? span / n : 1
}
