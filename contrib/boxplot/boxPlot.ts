import { PlaneGeometry } from 'three/webgpu'
import { gridDomain, type Axes, type Glyphs } from 'threecharts'

/** Five-number summary per group, plus whisker fences. */
export interface BoxStats {
  q1: number; median: number; q3: number; low: number; high: number
}

export interface BoxPlotOptions {
  /** Box width as a fraction of the slot. Default 0.6. */
  width?: number
  /** Whisker line width as a fraction of the slot. Default 0.06. */
  whiskerWidth?: number
  /** Box and whisker colour. */
  color?: string | number
  /** Median line colour. Must CONTRAST with `color` — drawn in the box's own
   *  colour it is invisible, which is what the first version did. */
  medianColor?: string | number
}

/** Every layer a box plot is made of, so a caller can restyle one. */
export interface BoxPlot {
  whiskers: Glyphs
  boxes: Glyphs
  medians: Glyphs
  /** Caps at BOTH fences — a whisker without them reads as an open-ended range. */
  lowCaps: Glyphs
  highCaps: Glyphs
}

/** A rectangle whose origin is at its BASE, so an offset places it and a size grows it. */
function slab(width: number): PlaneGeometry {
  const g = new PlaneGeometry(width, 1)
  g.translate(0, 0.5, 0)
  return g
}

/**
 * A box plot — the composition test.
 *
 * Written entirely against the public entry, as `contrib/polar` (a geometry) and
 * `contrib/ring` (a drawable) were. This is the third extension axis: can a third
 * party compose a CHART from the primitives, without touching core?
 *
 * Four `Glyphs` layers over one lattice — whiskers, boxes, medians, caps. Each is
 * a rectangle PLACED at a value and SIZED by another, which is the shape a box
 * plot shares with candlesticks, waterfalls, gantt bars and error bars.
 */
export function boxPlot(ax: Axes, stats: readonly BoxStats[], opts: BoxPlotOptions = {}): BoxPlot {
  const n = stats.length
  const w = opts.width ?? 0.6
  const ww = opts.whiskerWidth ?? 0.06
  const color = opts.color ?? 0xdddddd
  const medianColor = opts.medianColor ?? 0x101418

  const lo = Math.min(...stats.map((s) => s.low))
  const hi = Math.max(...stats.map((s) => s.high))
  const domain = gridDomain({ nx: n, ny: 1, x: [0, n], y: [lo, hi] })

  const f = (pick: (s: BoxStats) => number) => Float32Array.from(stats, pick)
  const norm = (v: number) => (v - lo) / (hi - lo || 1)
  const g = (pick: (s: BoxStats) => number) => Float32Array.from(stats, (s) => norm(pick(s)))
  const span = (a: (s: BoxStats) => number, b: (s: BoxStats) => number) =>
    Float32Array.from(stats, (s) => norm(a(s)) - norm(b(s)))
  void f

  // Each layer is a rectangle PLACED at a value and SIZED by another — the shape a
  // box plot shares with candlesticks, waterfalls, gantt bars and error bars.
  const layer = (width: number, baseline: Float32Array, size: Float32Array, c = color) =>
    ax.glyphs(slab(width), domain, { baseline, size, color: c })

  const rule = 0.008                       // hairline thickness, in normalised v
  const flat = (v: number) => Float32Array.from(stats, () => v)

  /* Draw order IS occlusion order here: whiskers first so the box covers the part
     of the line that runs behind it, then the median on top of the box. */
  return {
    whiskers: layer(ww, g((s) => s.low), span((s) => s.high, (s) => s.low)),
    lowCaps:  layer(w * 0.5, g((s) => s.low), flat(rule)),
    highCaps: layer(w * 0.5, g((s) => s.high), flat(rule)),
    boxes:    layer(w,  g((s) => s.q1),  span((s) => s.q3, (s) => s.q1)),
    medians:  layer(w,  g((s) => s.median), flat(rule * 1.6), medianColor),
  }
}
