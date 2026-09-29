// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { uniform } from 'three/tsl'

export type ClockListener = () => void

/**
 * Clock — the Figure-owned temporal source of truth for animation. Holds the
 * playback position and exposes a `frameUniform` (the integer current frame) that
 * time-varying drawables read, so they animate in LOCK-STEP. The Figure's render
 * loop calls `advance(dt)` each frame, so playback is framerate-INDEPENDENT
 * (wall-clock × fps × speed, not per-frame). Discrete changes (play/pause/speed/
 * seek/count) notify `subscribe`rs; the continuous position is polled by the UI.
 */
export class Clock {
  /**
   * The position bounds, in AN ABSTRACT UNIT THIS CLASS DOES NOT NAME.
   *
   * The engine is domain-free — its drawables know a buffer, a domain and a
   * colormap, never a recording — so the clock may not learn what a second is. The
   * host sets the range and the rate in whatever unit it chose, and this class only
   * ever increments an opaque number by `dt x rate`. An app host means SECONDS on a
   * recording axis; a bench means frames. Neither is visible here.
   *
   * This replaced `frameCount`, which in the consuming app was the RESIDENT PAGE's
   * sample count — the thing that made the clock a page-local coordinate.
   */
  min = 0
  max = 0
  /**
   * WHICH KIND OF RANGE IS IN PLAY, set by whichever setter was called.
   *
   * `'frames'` — `setFrameCount`, a discrete grid where the position IS a buffer
   * column, so `frameUniform` means something.
   *
   * `'continuous'` — `setRange`, where the host chose the unit. A column cannot be
   * derived from it here (see `syncUniform`).
   */
  rangeMode: 'frames' | 'continuous' = 'frames'
  /**
   * The WRAP PERIOD, and it is NOT `max - min`.
   *
   * A frame count is an EXCLUSIVE bound; a range is INCLUSIVE. Ten frames are
   * `[0, 9]` but the period is 10, because frame 9 occupies `[9, 10)` and must be
   * displayed for its full duration. Deriving the period as `max - min` would give 9:
   * `advance` would wrap a tenth of a cycle early and the last frame would never be
   * shown. `Clock.test.ts` pins this — "9 + 2 -> 11 -> wraps to 1" is `11 % 10`, and
   * `11 % 9` is 2.
   */
  private _period = 1
  /** Playback rate, frames per second (× speed). */
  fps = 12
  speed = 1
  /** Host-driven multiplier ON TOP of `speed` — for programmatic/adaptive pacing (e.g.
   *  a timeseries slowing playback as you zoom the time axis in). The transport owns
   *  `speed` (the user's 1×/0.5×/… choice); this composes with it. Default 1 (no effect). */
  speedScale = 1
  /**
   * Ceiling on the ADVANCE RATE, in timepoints per second. Default: none.
   *
   * Past a certain rate an animation stops carrying information. The display renders
   * ~60 frames a second, so the animation samples the recording at `R/p` Hz (where `p`
   * is data-seconds per wall-second), and a component at `f` Hz survives only while
   * `R/p ≥ 2f`. For a 60 Hz band on a 60 Hz display that is `p ≤ 0.5` — half real
   * time. Above it, fast rhythms do not merely blur: they ALIAS, appearing as slower
   * ones that were never in the data, which is the failure a dynamics viewer must not
   * have. The host sets this from its own band of interest (`0.5 · sfreq`).
   */
  maxRate = Infinity
  loop = true
  /**
   * True once a NON-LOOPING advance ran off the end and parked at the last frame.
   *
   * It exists so a host can tell END OF PLAY from a user pause. Both leave
   * `playing` false and both notify subscribers, and no position test separates
   * them reliably — which matters because the host that pages a recording has to
   * act on the first and must not act on the second. Set inside `advance`, the one
   * place that knows which happened.
   *
   * **Cleared by every transition INTO playing, and by every reposition** —
   * `play`, `toggle`, `seek`, `setFrameCount`. `pause` neither sets nor clears it.
   * `toggle` is the one the UI actually uses (`TransportBar`'s play button), and it
   * was missed on the first cut: a latched `ended` survived a resume, so the host's
   * end-of-play subscriber could fire on the NEXT unrelated notification and page
   * forward from a resume. That is why `toggle` routes through `play`/`pause`
   * rather than flipping the field — one writer of the transition, so there is
   * nowhere for a fourth entry point to be forgotten.
   */
  ended = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly frameUniform: any = (uniform as any)(0)
  /** The CONTINUOUS position (fractional frame) as a live uniform — for drawables that
   *  INTERPOLATE between frames instead of snapping, e.g. arc-length particle advection
   *  (smooth motion at any framerate). Frame-indexed drawables keep using `frameUniform`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly timeUniform: any = (uniform as any)(0)
  private _position = 0        // fractional position ∈ [min, min + period)
  private _playing = false
  private readonly _listeners = new Set<ClockListener>()

  get position(): number { return this._position }
  get frame(): number { return Math.floor(this._position) }
  get playing(): boolean { return this._playing }

  play(): void { this.ended = false; if (!this._playing) { this._playing = true; this.emit() } }
  pause(): void { if (this._playing) { this._playing = false; this.emit() } }
  /* THROUGH `play`/`pause`, not a bare flip — see `ended`. Both of those emit
     unconditionally here because `toggle` always changes `_playing`, so the
     observable behaviour is identical to the flip it replaced. */
  toggle(): void { if (this._playing) this.pause(); else this.play() }
  setSpeed(s: number): void { this.speed = s; this.emit() }

  /**
   * Set the CONTINUOUS position bounds. `max` is inclusive; the wrap period is
   * `max - min` (see `_period` for why that differs from `setFrameCount`).
   */
  setRange(min: number, max: number): void {
    this.ended = false
    this.rangeMode = 'continuous'
    this.min = min
    this.max = Math.max(min, max)
    this._period = Math.max(Number.MIN_VALUE, this.max - this.min)
    if (this._position < this.min) this._position = this.min
    if (this._position > this.max) this._position = this.max
    this.syncUniform(); this.emit()
  }

  /**
   * Frame-count alias, retained for figures with no host time model — a synthetic
   * field, a bench. DISCRETE, so the period is `n` and not `max - min`.
   */
  setFrameCount(n: number): void {
    this.ended = false
    this.rangeMode = 'frames'
    const count = Math.max(1, Math.floor(n))
    this.min = 0
    this.max = count - 1
    this._period = count
    if (this._position > this.max) this._position = this.max
    this.syncUniform(); this.emit()
  }

  /** The discrete frame count implied by the current period. */
  get frameCount(): number { return Math.max(1, Math.round(this._period)) }

  /** Seek to a (possibly fractional) position; clamps into `[min, max]`. */
  seek(position: number): void {
    this.ended = false
    this._position = Math.max(this.min, Math.min(position, this.max))
    this.syncUniform(); this.emit()
  }

  /** Advance by `dt` seconds — called by the Figure loop. Does NOT emit (the UI
   *  polls the continuous position via rAF) except on a non-loop end-of-play. */
  advance(dt: number): void {
    if (!this._playing || this.max <= this.min) return
    const { min } = this
    const period = this._period
    this._position += dt * Math.min(this.fps * this.speed * this.speedScale, this.maxRate)
    /* `>= min + period`, not `> max`: with a frame count the two differ by one whole
       frame, and parking on `> max` would deny the last frame its duration. */
    if (this._position >= min + period) {
      if (this.loop) this._position = min + ((this._position - min) % period)
      else { this._position = this.max; this._playing = false; this.ended = true; this.emit() }
    } else if (this._position < min) {
      this._position = this.loop
        ? min + (((this._position - min) % period) + period) % period
        : min
    }
    this.syncUniform()
  }

  subscribe(fn: ClockListener): () => void { this._listeners.add(fn); return () => { this._listeners.delete(fn) } }

  /**
   * The uniforms are BUFFER INDICES — every drawable consumes `timepoint` as a
   * column. Offset from `min`, so a `[0, n-1]` frame range behaves exactly as before.
   *
   * **A host whose range is a physical unit cannot use these**, and must not:
   * unit -> column needs the source grid and the resident window, which the host owns.
   * Such a host drives the drawables' `timepoint` itself.
   *
   * SO IN CONTINUOUS MODE `frameUniform` IS PARKED AT -1, and that is the point. It
   * used to keep publishing `floor(position)`, which under a seconds range is a
   * number in `[0, 600)` handed to a shader as an index into a 32768-column page.
   * Every drawable defaults `timepoint` to this uniform, so a call site that simply
   * forgot got a PLAUSIBLE picture with nothing logged.
   *
   * -1 reads out of bounds, so a forgetful drawable renders visibly nothing instead.
   * A sentinel rather than a throw because all seven drawables evaluate the fallback
   * at CONSTRUCTION — including the windowed `Line`, which never reads it.
   */
  private syncUniform(): void {
    const i = this._position - this.min
    this.frameUniform.value = this.rangeMode === 'continuous' ? -1 : Math.floor(i) % this._period
    this.timeUniform.value = i
  }
  private emit(): void { for (const fn of this._listeners) fn() }
}
