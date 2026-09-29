import { Group } from 'three/webgpu'
import { GraphicsObject } from './GraphicsObject'
import type { Limits } from './limits'

/** "Nice" round tick values over `[lo, hi]` (~`count` of them). Step is 1/2/5×10ⁿ.
 *  Empty for a degenerate/invalid range. */
export function niceTicks([lo, hi]: Limits, count: number): number[] {
  if (!(hi > lo) || count < 1) return []
  const raw = (hi - lo) / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const start = Math.ceil(lo / step) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  return out
}

/**
 * Decade tick positions for a LOG axis, in EXPONENT space: the axis limits are
 * `log10(value)`, so the ticks are the integers in range (10⁻³, 10⁻², …). Over a
 * narrow range (fewer than three decade ticks) that would leave one or two marks
 * on the ruler, so 1-2-5 subdivisions are added inside each decade.
 */
export function logTicks([lo, hi]: Limits): number[] {
  if (!(hi > lo)) return []
  const out: number[] = []
  const first = Math.ceil(lo), last = Math.floor(hi)
  if (last - first >= 2) {                 // 3+ decade ticks — decades alone read fine
    for (let e = first; e <= last; e++) out.push(e)
    return out
  }
  // A narrow range would be left with one or two ticks; subdivide 1-2-5.
  const subs = [0, Math.log10(2), Math.log10(5)]
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    for (const s of subs) { const v = e + s; if (v >= lo && v <= hi) out.push(v) }
  }
  return out.sort((a, b) => a - b)
}

/** How an axis maps data to its ruler. `log` means the axis LIMITS and the
 *  positions drawables plot at are `log10(value)`; the axis labels them back as
 *  values, and drawables that read raw buffers apply the log themselves (see
 *  `Line`'s `logY`). Non-positive values have no place on a log axis. */
export type AxisScale = 'linear' | 'log'

/**
 * Axis — one ruler (x or y) of an `Axes` (= MATLAB `XAxis`/`YAxis`). A data model:
 * limits + label + tick config. It has no GPU geometry (empty node); the
 * screen-fixed `AxesOverlay` reads it to draw ticks/labels.
 */
export class Axis extends GraphicsObject {
  /** Mirrors the parent axes' xlim/ylim; set by `Axes.syncFrame`. */
  limits: Limits = [0, 1]
  private _label = ''
  private _labelVisible = true
  private _ticksVisible = true        // the tick MARKS (short lines)
  private _tickLabelsVisible = true   // the value LABELS (numbers)
  private _tickFontSize = 1
  private _tickCount = 5
  private _scale: AxisScale = 'linear'

  constructor(readonly dim: 'x' | 'y' | 'z') { super(new Group()) }

  /** Linear (default) or log. See {@link AxisScale}. */
  get scale(): AxisScale { return this._scale }
  set scale(v: AxisScale) { if (v !== this._scale) { this._scale = v; this.invalidate() } }

  get label(): string { return this._label }
  set label(v: string) { this._label = v; this.invalidate() }
  get labelVisible(): boolean { return this._labelVisible }
  set labelVisible(v: boolean) { this._labelVisible = v; this.invalidate() }
  get ticksVisible(): boolean { return this._ticksVisible }
  set ticksVisible(v: boolean) { this._ticksVisible = v; this.invalidate() }
  get tickLabelsVisible(): boolean { return this._tickLabelsVisible }
  set tickLabelsVisible(v: boolean) { this._tickLabelsVisible = v; this.invalidate() }
  get tickFontSize(): number { return this._tickFontSize }
  set tickFontSize(v: number) { this._tickFontSize = v; this.invalidate() }

  /**
   * How many ticks this axis TARGETS (default 5). `niceTicks` rounds to whole
   * steps, so the count you get is near this, not exactly it.
   *
   * It exists because tick density is a function of how tall or wide the axes is
   * on screen, which the axis cannot know. A ruler sized for a 380 px plot puts
   * seven labels into a 60 px strip, where they collide into an unreadable smear —
   * so a short axes lowers this rather than losing its ruler altogether.
   *
   * Ignored on a log axis, whose ticks are the decades in range.
   */
  get tickCount(): number { return this._tickCount }
  set tickCount(v: number) {
    const n = Math.max(2, Math.round(v))
    if (n !== this._tickCount) { this._tickCount = n; this.invalidate() }
  }

  /**
   * RE-LABEL the ticks without moving them.
   *
   * Given a tick position in the axis' own coordinates, return the text to draw. Null —
   * the default — uses the built-in numeric formatting.
   *
   * It exists for axes whose sample positions and whose MEANING are different things.
   * The eigenspectrum is the worked case: its samples are eigenmodes, so the data must
   * be plotted against the mode INDEX to sit at exact sample positions, while what a
   * reader wants on the ruler is the eigenvalue or the spatial wavelength that index
   * stands for — a strongly non-linear function of it. Re-scaling the DATA to those
   * units would need resampling and would move every sample off the value it belongs
   * to; re-labelling the ruler is exact.
   *
   * Only the labels change: tick POSITIONS, the grid and the limits are untouched, so a
   * formatter can never desynchronise the ruler from the curve.
   */
  tickFormat: ((value: number) => string) | null = null

  /**
   * Tick positions the CALLER supplies, in the axis' own coordinates. `null` computes
   * them (the default).
   *
   * **The case this exists for is an axis whose coordinate is not a QUANTITY.** A
   * lane chart stacks C channels of S scales into one `[C·S, T]` raster, so its y
   * coordinate is a row index and `niceTicks` over `[0, 600]` returns 0, 200, 400, 600
   * — round numbers naming nothing. What the ruler wants is a tick per LANE.
   *
   * `tickFormat` is not enough on its own: it relabels a value the axis chose, and the
   * positions are exactly what a lane axis has to choose. The two compose — supply the
   * positions here, the names there.
   *
   * ⚠ **The grid reads these too** (`AxesOverlay` draws it from `tickValues()` when
   * `Axes.grid` is on). A caller supplying twenty lane centres gets twenty grid lines;
   * turn `Axes.grid` off rather than thinning the ticks.
   */
  tickValuesOverride: number[] | null = null

  /** Tick positions in the axis' own coordinates (always computed — the grid uses
   *  them too; mark / label visibility is applied by the overlay). On a log axis
   *  these are exponents. */
  tickValues(): number[] {
    if (this.tickValuesOverride) {
      /* CLIPPED TO THE LIMITS, like every computed tick already is. An override is a
         list of positions, not a list of labels to draw unconditionally — a caller
         that supplies one per lane and then scrolls the window would otherwise keep
         labelling every lane, including the ones off screen. `niceTicks` and
         `logTicks` both derive from `limits`, so they were never able to do this. */
      const [a, b] = this.limits
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      return this.tickValuesOverride.filter((v) => v >= lo && v <= hi)
    }
    return this._scale === 'log' ? logTicks(this.limits) : niceTicks(this.limits, this._tickCount)
  }
}
