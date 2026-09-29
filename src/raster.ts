/**
 * Raster2D value→byte normalization — pure, unit-testable, no three.js.
 *
 * A raster maps a scalar field `[rows × cols]` (row-major) to a normalized
 * `[0,1]` intensity per cell, which the GPU then colors through a colormap.
 * Normalization is either linear or log (log is the usual choice for power
 * spectra, which span many decades). The value range `[lo, hi]` is either
 * given or auto-computed from the finite (and, for log, positive) samples.
 */

export type Raster2DScale = 'linear' | 'log'

const LOG_FLOOR = 1e-30

/** Auto value range over the finite samples. For `log`, only strictly
 *  positive samples count (lo is the smallest positive, floored). Returns a
 *  degenerate-safe `[lo, hi]` with `hi > lo`. */
export function computeRange(data: Float32Array, scale: Raster2DScale): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (!Number.isFinite(v)) continue
    if (scale === 'log' && v <= 0) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (scale === 'log') lo = Math.max(lo, LOG_FLOOR)
  if (hi <= lo) hi = lo + (scale === 'log' ? lo : 1) || 1
  return [lo, hi]
}

/** Normalize one value into `[0,1]` under `scale` over `[lo, hi]` (clamped). */
export function normalizeValue(v: number, lo: number, hi: number, scale: Raster2DScale): number {
  if (!Number.isFinite(v)) return 0
  if (scale === 'log') {
    if (v <= 0) return 0
    const t = (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
    return t < 0 ? 0 : t > 1 ? 1 : t
  }
  const t = (v - lo) / (hi - lo)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Pack a `[rows × cols]` field into an RGBA8 buffer (the normalized intensity
 * `t` replicated into R/G/B, alpha 255) suitable for a `DataTexture`. Row 0 of
 * the data lands in texture row 0, which — with `flipY = false` — renders at the
 * bottom of the quad (v = 0). So data row 0 is the bottom row.
 */
export function packRasterRGBA(
  data: Float32Array,
  rows: number,
  cols: number,
  lo: number,
  hi: number,
  scale: Raster2DScale,
): Uint8Array {
  const out = new Uint8Array(rows * cols * 4)
  for (let i = 0; i < rows * cols; i++) {
    const t = normalizeValue(data[i], lo, hi, scale)
    const b = Math.max(0, Math.min(255, Math.round(t * 255)))
    const o = i * 4
    out[o] = b
    out[o + 1] = b
    out[o + 2] = b
    out[o + 3] = 255
  }
  return out
}
