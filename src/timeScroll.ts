import { drawPlanFor, envelopeColumnSeconds, type LineDrawPlan } from './envelope'
import type { Axes } from './Axes'
import type { Line } from './Line'
import type { Clock } from './Clock'

/**
 * attachTimeScroll — the viewing behaviour of a scrolling timeseries plot, as an
 * imperative attacher in the shape of `attachPanZoom` / `attachOrbit`.
 *
 * It adds NO drawing. `Line` already owns every knob involved (`rowMap`,
 * `colorIndex`, `channelSpacing`, `gain`, `scroll`, `totalSamples`). What this
 * owns is the per-frame logic around them, which was being copied between call
 * sites and had already drifted: the window centred on the clock, the playhead,
 * the adaptive playback rate, the butterfly↔stacked animation, and the wheel map.
 *
 * It drives ONE axes + line — the scrolling plot. Anything stacked with it
 * (an auxiliary strip) follows through `linked`, which takes the same x span and
 * nothing else: its y limits are its own.
 */

/** Wheel factor per notch. */
const STEP = 1.1
/**
 * Vertical-gain bounds.
 *
 * They were 0.3 … 40, on the reasoning that below one a trace is a flat line and above
 * the other it is noise. That judgement assumes the host's normalisation is a constant,
 * and it is not: the traces are drawn at `1 / p99(|x|)` over the DRAWN ROWS, so a
 * montage change or a temporal band moves the baseline under the gain. A user who band-
 * passes and then cannot open the window far enough has hit a limit that was calibrated
 * for a different signal — reported 2026-08-01.
 *
 * Widened by ~5× at each end. Still bounded, because unbounded is its own failure: at
 * some point every trace is a vertical line and the control stops meaning anything.
 */
const GAIN_MIN = 0.06, GAIN_MAX = 200
/**
 * The stacked layout's ROW WINDOW: how many channels it shows at rest, and how few a
 * vertical zoom may leave.
 *
 * Stacked is a window over the montage, not the whole of it. 272 rows in a 380 px plot
 * is 1.4 px a row, which is not a dense plot but an unreadable one — every trace is
 * sub-pixel whatever the gain, so the layout that exists to separate the channels
 * separates nothing. A few rows at a time, with the rest scrolled past, is the y
 * analogue of the time span this attacher already owns on x.
 */
const ROWS_DEFAULT = 20, ROWS_MIN = 2

/**
 * What a bare wheel over the plot does. Exactly one at a time.
 *
 * It used to be a pair of enabled AXES with the modifier disambiguating — and two
 * lit toggles cannot say which one a bare scroll will reach. Declared here rather
 * than imported from `@nxr/ui`, which owns the toolbar that arms it: this package
 * has no React, so the two sides carry the same union and the host satisfies both,
 * the way `TransportBar` carries its own `TransportClock`.
 */
export type TraceTool = 'gain' | 'time' | 'channels' | 'pan'

/** @deprecated the armed thing governs the DRAG as well as the wheel — see `TraceTool`. */
export type WheelAction = TraceTool

export interface TimeScrollOptions {
  clock: Clock
  /**
   * Seconds per sample of the DRAWN BUFFER. A GETTER, because the chart binds a
   * native buffer in NAVIGATE and an analysed one in ANALYSE and they differ by the
   * scale's stride; a value fixed at attach would draw one of them on the other's
   * axis. See `clockToSec` for the clock's own rate, which is a separate question.
   */
  sampleDt: () => number
  /**
   * The clock's position as ABSOLUTE RECORDING SECONDS.
   *
   * Separate from `sampleDt` because the clock and the drawn buffer need not share a
   * rate or an origin: the clock counts the ANALYSIS timebase from its page's start,
   * while the traces may be drawing a native-rate page beginning somewhere else. One
   * number served both only while they were the same page.
   *
   * Defaults to `clock.position * clockDt`, which is exactly what this computed
   * before the two could differ.
   */
  clockToSec?: () => number
  /**
   * Seconds per CLOCK timepoint, for the adaptive pacing solve. Defaults to
   * `sampleDt`. Wrong here and the on-screen sweep is off by the decimation ratio —
   * a smooth, plausible, entirely incorrect playback speed.
   */
  clockDt?: number
  /* There is no `sampleOffset` any more. It existed to convert an absolute clock
     position into a buffer-relative scroll index, and that conversion moved into
     `Line.setViewCentre` — where the buffer's own origin already lives, and where it
     cannot be one source behind. Pass the buffer's origin to `Line` (its
     `sampleOffset` option, or `setSource`) and this attacher needs no copy of it. */
  /**
   * Samples in the buffer currently BOUND to `line` — what `drawPlanFor` windows
   * its envelope geometry against. Required, and deliberately not derived from
   * `maxWinSec` or `recordingSamples`: those describe the AXIS, and the bound
   * buffer is a separate fact the mode (NAVIGATE vs ANALYSE) decides, not this
   * attacher. Reading the buffer's size off the axis is exactly the confusion
   * `source` used to paper over — see `drawPlanFor`.
   */
  bufferSamples: () => number
  /**
   * Samples the ENVELOPE spans, when that is a different array from the sample
   * buffer. Defaults to `bufferSamples`, which is right whenever one array serves
   * both.
   *
   * They differ in NAVIGATE by the whole recording: the samples come from the
   * resident page, the envelope from the stored whole-recording overview. Bounding
   * the envelope's geometry by the page drew 13.65 s of a 300 s view and left the
   * rest blank — see `drawPlanFor`.
   */
  envelopeSamples?: () => number
  /**
   * Samples in the WHOLE RECORDING, in the drawn buffer's rate — where the time
   * AXIS ends.
   *
   * NOT derivable from `maxWinSec`, and deriving it was a defect. `maxWinSec` is the
   * widest span the chart may SHOW, which without a stored pyramid is one page; the
   * axis is in ABSOLUTE recording time, so clamping the window to a page's WIDTH put
   * the window in `[0, pageDuration]` on every page but the first — the playhead off
   * screen from page two onward, on a recording longer than one page.
   *
   * They coincide only when the resident buffer IS the recording, which is the
   * default here and was the whole of why one number appeared to serve both.
   */
  recordingSamples?: () => number
  /**
   * Widest visible span, in seconds. A GETTER because it depends on the resident
   * page, which changes as the recording is paged.
   */
  maxWinSec: () => number
  /** Channels currently drawn — sets the stacked layout's top. A getter: a
   *  montage change alters it without re-attaching. */
  channels: () => number
  /**
   * Factor bringing the buffer's raw units to ~unit scale, folded into the
   * trace gain. A getter, because it is re-measured whenever the drawn rows
   * change. Default 1.
   */
  unitScale?: () => number
  /** Axes stacked with this one: they take the same x span, never its y. */
  linked?: () => Axes[]
  /** The span at zoom 1. Every other time bound is relative to it. Default 0.6 s. */
  /**
   * The span at zoom 1 — a GETTER, because it depends on the RECORDING's length and
   * that is not known when the chart attaches.
   *
   * It was a number captured in the closure, and an attach that happened before the
   * timebase resolved froze the chart at the fallback span for the life of the
   * figure: a session opened showing ~1.7 s of a recording it was supposed to open
   * showing half of. Same class as a `sampleDt` or a row stride fixed at
   * construction — a value that legitimately arrives late, read once.
   */
  baseWinSec?: () => number
  /**
   * Adaptive pacing's target: WALL-seconds for one screenful, at speed 1.
   *
   * Expressed as a duration rather than as a ratio to `baseWinSec`, because the ratio
   * form silently depended on `clock.fps`: it produced a constant screen speed only
   * while the clock advanced 30 timepoints a second, and became 10× too fast the
   * moment a host set `fps` to the recording's sample rate. This form asks for what
   * pacing actually wants — how long a screenful should take — and solves for the
   * scale from the clock's own rate. Default 6 s, which is what the ratio form
   * produced at `fps` 30 on 300 Hz data.
   */
  screenSec?: number
  /** Narrowest span. The WIDE end is `maxWinSec()`, not a constant — clamping the
   *  zoom accumulator instead pins the widest view to a fixed number of seconds
   *  regardless of how long the recording is. Default 0.05 s. */
  minWinSec?: number
  /**
   * Cap on adaptive playback. Without one, `winSec / baseWinSec` on a long page
   * reaches ~180×, which plays a six-minute recording in two seconds. Default 16.
   */
  maxSpeedScale?: number
  /**
   * Tie the playback rate to the visible span, from the FIRST frame. Default true.
   *
   * A construction option and not only a setter, because a host that wants pacing
   * OFF may have wanted it off since before this attacher existed. `setAdaptive`
   * can only be called on an instance, so a host applying it from an effect
   * silently loses the race against its own attach — the attacher is built inside
   * an async figure creation, so at the moment the host's effect runs there is
   * nothing to call it on, and if the value does not change again the effect never
   * re-runs. That is not hypothetical: it left `clock.speedScale` at the adaptive
   * value under a band, whose whole claim is that the rate is the band's alone.
   */
  adaptive?: boolean
  /**
   * Butterfly (false) or stacked columns (true) AT ATTACH. Default false.
   *
   * A construction option for exactly the reason `adaptive` is one, and it was
   * missing for months: `setStacked` can only be called on an instance, and this
   * attacher is built inside an async figure creation — so a host that stacks from
   * an effect (a temporal band does, on mount) calls it while `scrollRef` is still
   * null, the value never changes again, and the effect never re-runs. The chart
   * then reported a stacked row window in its status bar while the plot drew a
   * butterfly, for as long as both existed.
   */
  stacked?: boolean
  /** Per-channel offset in the stacked layout. Default 3. */
  spacing?: number
  /**
   * Which way the stack runs. Default `down` — a channel list is READ from the top,
   * the way every other timeseries viewer draws one, and this attacher exists only
   * for those.
   *
   * `Line` is not asked to change: its contract is `channel c sits at
   * c × channelSpacing`, and a NEGATIVE spacing is that contract counting downward.
   * So the direction is this attacher's alone, and the drawable stays the general
   * thing it is — which matters, because the eigenspectrum and mode-gain charts
   * stack rows upward through the very same option.
   */
  stackDirection?: 'up' | 'down'
  /** Half-height of the butterfly (overlaid) layout. Default 3. */
  butterflyExtent?: number
  /** Layout lerp rate per frame, 0–1. Default 0.18. */
  ease?: number
  /** Trace gain before `unitScale`, at attach. Default 1. */
  gain?: number
  /** Rows the STACKED window shows at rest. Default 20, clamped to the channel count. */
  rowsVisible?: number
  /** Fired when the wheel changes the gain, for secondary lines the caller owns. */
  onGain?: (gain: number) => void
  /**
   * Fired when the visible ROW RANGE changes — integers, and only on a change, so a
   * host may put it straight into React state without a per-frame render.
   */
  onRows?: (firstRow: number, rows: number, total: number) => void
  /**
   * Fired when the visible SPAN changes by more than 1 % — a change finer than that
   * is not readable in a status bar, and this runs every frame.
   *
   * Needed because `baseWinSec` is the span at zoom 1, not the span on screen: a
   * readout showing it said "1.71 s window" over a 109 s view.
   */
  onWindow?: (winSec: number) => void
  /**
   * The visible span's ENDS, in absolute recording seconds — fired when either
   * moves by more than a pixel's worth, so a host may position an overlay against
   * the axis without running a second frame loop of its own.
   *
   * `onWindow` reports the span's WIDTH and is deliberately coarse (1 %), which is
   * right for a status readout and useless for anything that has to stay aligned
   * while panning. A pixel is the threshold because the consumer is drawing.
   */
  onView?: (t0: number, t1: number) => void
  /**
   * A PAN asks for an absolute time, in recording seconds.
   *
   * The host owns seeking, because the clock is page-local and a drag can cross a
   * page boundary — only the host can make the next page resident. It is also what
   * keeps a pan and the transport's scrubber the same operation: both move the
   * cursor, and the cursor is the one place "where are we" is written down.
   *
   * With the clock PAUSED this is a single-timepoint move — one solve at the new
   * time, not playback. Nothing here starts the clock.
   */
  onSeek?: (tSec: number) => void
  /**
   * Fired when the DRAW PLAN changes — whether the line should be drawing samples
   * (and over what span) or an envelope (and at what bucket).
   *
   * ONE callback, not a span one and a bucket one. Two could be left disagreeing,
   * and the drawable would then be told to read an envelope buffer with a sample
   * geometry — not an error, a plausible picture of nothing, which is the same
   * argument `Line.setSource` is a single method for.
   *
   * Chosen here because this owns the visible span, and it is derived from SAMPLES
   * PER PIXEL rather than from the span alone: a wider card at the same zoom needs
   * finer detail. Only on a change, so a host may put it straight into React state.
   */
  onDrawPlan?: (plan: LineDrawPlan) => void
  /** Largest bucket the host can supply. Default 4096. */
  maxBucket?: number
  /**
   * Fired when a USER gesture takes the visible span outside the bound buffer.
   *
   * The host stops playback on it (spec §4). It is deliberately NOT fired by the
   * clock's own page advance: play auto-advances across consecutive pages, so a
   * signal that meant "the page changed" would stop playback at the first boundary —
   * the opposite of what play is for. Only the wheel raises this.
   */
  onLeavePage?: () => void
}

export interface TimeScroll {
  /** Stop the frame loop and remove the wheel listener. */
  detach(): void
  /** Butterfly (false) ↔ stacked columns (true). Animates. */
  setStacked(stacked: boolean): void
  /** Tie playback rate to the visible span. */
  setAdaptive(on: boolean): void
  /** Arm the wheel with ONE action. */
  setWheelAction(action: TraceTool): void
  /** Vertical gain BEFORE `unitScale`. */
  setGain(gain: number): void
  readonly gain: number
  /** Scroll the stacked window so it starts at this row. Fractional, and clamped. */
  setRowOffset(row: number): void
  /** How many rows the stacked window shows. Clamped to the channel count. */
  setRowsVisible(rows: number): void
  readonly rowOffset: number
  readonly rowsVisible: number
  /** What the line should be drawing right now. */
  readonly drawPlan: LineDrawPlan
  /** Clamp the visible span to at most `sec`, keeping the cursor centred. A CEILING,
   *  not a zoom-to-fit: a span already inside it is left alone, so entering a mode
   *  does not discard the zoom a reader chose. */
  clampTo(sec: number): void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function attachTimeScroll(
  axes: Axes,
  line: Line,
  el: HTMLElement,
  opts: TimeScrollOptions,
): TimeScroll {
  const {
    clock, sampleDt, maxWinSec, channels, bufferSamples,
    envelopeSamples = bufferSamples,
    clockDt = sampleDt(),
    clockToSec = () => clock.position * clockDt,
    recordingSamples = () => Math.round(maxWinSec() / sampleDt()),
    unitScale = () => 1,
    linked = () => [],
    baseWinSec = () => 0.6,
    screenSec = 6,
    minWinSec = 0.05,
    maxSpeedScale = 16,
    adaptive: adaptive0 = true,
    stacked: stacked0 = false,
    gain: gain0 = 1,
    rowsVisible: rows0 = ROWS_DEFAULT,
    spacing = 3,
    stackDirection = 'down',
    butterflyExtent: bfly = 3,
    ease = 0.18,
    onGain,
    onRows,
    onDrawPlan,
    onWindow,
    onView,
    onSeek,
    maxBucket = 4096,
    onLeavePage,
  } = opts

  let gain = gain0
  let timeGain = 1
  let adaptive = adaptive0
  let action: TraceTool = 'gain'
  /** +1 stacks upward, −1 downward. Applied to the spacing UNIFORM, so the drawable
   *  never learns about it. */
  const dir = stackDirection === 'down' ? -1 : 1
  /** 0 = butterfly, 1 = stacked. Eased toward `layoutTarget`. Both start AT the
   *  requested layout rather than easing into it — this is the initial state, not a
   *  transition, and animating one on mount is a flash nobody asked for. */
  let layoutT = stacked0 ? 1 : 0, layoutTarget = layoutT
  /** The stacked window: how many rows it wants, and which row it starts on. */
  let rowsWanted = rows0, rowOffset = 0
  let lastRange = ''
  /** The plan in force, and a key for the last one REPORTED. Two variables, because
   *  the resting plan is a legitimate answer: with one, a chart mounted at a tight
   *  zoom would never fire and its host could not tell "no callback yet" from
   *  "samples, please". The empty key cannot be produced, so the first frame always
   *  reports — the same sentinel `lastRange` uses one block above. */
  let plan: LineDrawPlan = { mode: 'samples', span: 0 }
  let lastPlanKey = ''
  let lastWin = 0
  /**
   * The last view REPORTED, and the plot width the report was measured against.
   *
   * `reported` is a FLAG and not a sentinel value, and that is the whole of the
   * lesson: these were seeded `NaN`, and every comparison against `NaN` is false, so
   * the first frame never fired and the view was never reported AT ALL. The sibling
   * state one block up uses `''` for exactly this reason — an empty key cannot be
   * produced, so the first frame always reports. A numeric field has no such value.
   */
  let reported = false
  let lastT0 = 0, lastViewWin = 0, lastPlotW = 1
  let raf = 0
  /** Edge-trigger for `onLeavePage`: whether the LAST wheel notch left the visible
   *  span outside the bound buffer. Without it, a reader holding a zoomed-out view
   *  would re-fire the pause every notch instead of once at the crossing. */
  let wasOutside = false

  /** Rows the window actually shows — never more than there are to show. */
  const rowsShown = () => {
    const n = Math.max(1, channels())
    return clamp(rowsWanted, Math.min(ROWS_MIN, n), n)
  }
  /**
   * The plot's drawing height in px, inside the axes' fixed-pixel chrome margins.
   *
   * Read per gesture rather than cached: the card is drag-resizable, and a scroll
   * calibrated against a stale height moves by the wrong number of rows.
   */
  const plotPx = () => {
    const m = axes.margins
    return Math.max(1, (el.getBoundingClientRect?.().height ?? 0) - m.top - m.bottom)
  }
  const pxPerRow = () => plotPx() / rowsShown()
  const scrollRows = (dRows: number) => {
    rowOffset = clamp(rowOffset + dRows, 0, Math.max(0, channels() - rowsShown()))
  }

  const applyGain = (g: number) => {
    gain = g
    line.gain.value = g * unitScale()
    onGain?.(g)
  }
  applyGain(gain)

  // The playhead: the clock's position in axis time. A getter, so it tracks
  // without this loop having to push it.
  axes.cursorX = clockToSec

  /*
   * ONE armed action. No modifier decides between gain and time any more: the host's
   * toolbar arms exactly one and lights it, so what a bare scroll will do is readable
   * without trying it. The single surviving modifier is INSIDE the channels action —
   * alt zooms the channel axis, which is the y twin of what the wheel already does to
   * time, and it cannot be confused with another action because it only exists while
   * that one is armed.
   */
  const onWheel = (e: WheelEvent) => {
    e.preventDefault(); e.stopPropagation()
    const f = e.deltaY < 0 ? STEP : 1 / STEP
    if (action === 'time') {
      timeGain = clamp(timeGain * f, baseWinSec() / maxWinSec(), baseWinSec() / minWinSec)
      /* Only from the WHEEL — see `onLeavePage`. Edge-triggered, or a reader holding
         a zoomed-out view would re-fire it every notch. */
      const winNow = Math.min(baseWinSec() / timeGain, maxWinSec())
      const outside = winNow / sampleDt() > bufferSamples()
      if (outside && !wasOutside) onLeavePage?.()
      wasOutside = outside
    } else if (action === 'gain') {
      applyGain(clamp(gain * f, GAIN_MIN, GAIN_MAX))
    } else if (layoutTarget === 1) {
      // Unreachable from the toolbar, which only offers this while stacked — but a
      // butterfly has no window, and a silent no-op beats scrolling nothing.
      if (e.altKey) rowsWanted = clamp(rowsWanted / f, ROWS_MIN, 4096)
      else scrollRows(e.deltaY / pxPerRow())
    }
  }

  /* Drag to pan the same window — "scroll" and "pan" are the same motion here, and a
     pointer drag is the one a reader tries first on a column of traces. Stacked only:
     in butterfly there is nothing to pan to. */
  let dragY: number | null = null
  let dragX: number | null = null
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    if (action === 'pan') {
      dragX = e.clientX
      el.setPointerCapture?.(e.pointerId)
      return
    }
    if (layoutTarget !== 1) return
    dragY = e.clientY
    el.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (dragX !== null) {
      /*
       * PANNING MOVES THE CURSOR, because the window is centred on it — there is no
       * separate pan offset to move, and adding one would be a second source of
       * truth for "where are we" that the transport could disagree with.
       *
       * So a pan is a SEEK, and seeking is the host's: the clock is page-local and a
       * drag can cross a page boundary, which only the host can make resident.
       * Dragging RIGHT goes BACK in time, the direction the content moves.
       */
      const dx = e.clientX - dragX
      dragX = e.clientX
      const perPx = (Math.min(baseWinSec() / timeGain, maxWinSec())) / Math.max(1, lastPlotW)
      onSeek?.(clockToSec() - dx * perPx)
      return
    }
    if (dragY === null) return
    const dy = e.clientY - dragY
    dragY = e.clientY
    scrollRows(-dy / pxPerRow())
  }
  const onUp = (e: PointerEvent) => {
    if (dragY === null && dragX === null) return
    dragY = null
    dragX = null
    el.releasePointerCapture?.(e.pointerId)
  }
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
  // Capture phase + non-passive: the gesture must beat any ancestor scroll and be
  // cancellable, or the page scrolls under the chart instead of zooming it.
  el.addEventListener('wheel', onWheel, { capture: true, passive: false })

  const frame = () => {
    const tSec = clockToSec()
    const winSec = Math.min(baseWinSec() / timeGain, maxWinSec())
    if (Math.abs(winSec - lastWin) > lastWin * 0.01) { lastWin = winSec; onWindow?.(winSec) }
    /*
     * THE WINDOW IS CENTRED ON THE PLAYHEAD, AND CLAMPED TO THE RECORDING.
     *
     * A recording starts at t = 0 and there is nothing before it, so a window
     * centred at 0.5 s and 100 s wide must not put −49.5 s on the axis: negative
     * time is not a small labelling wrinkle, it is an axis asserting samples that
     * cannot exist. It also made zoom-out look like it opened symmetrically about
     * the playhead everywhere, when at the ends it cannot.
     *
     * SHIFTED, not shrunk — the window keeps the width the zoom asked for and the
     * playhead simply stops being centred near either end, which is what every
     * timeseries viewer does. Shrinking would make the zoom control mean two
     * different things depending on where the cursor was.
     *
     * `Line.setViewCentre` clamps its slot window by the same rule, in slot units.
     * Before this the two disagreed: the geometry stopped at the first sample while
     * the axis kept panning left, so the traces appeared to peel away from the edge.
     */
    /* THE RECORDING'S END, not the widest SHOWABLE span — see `recordingSamples`.
       Without a stored pyramid those differ by a factor of the page count, and using
       the wrong one puts the playhead off screen from page two onward. */
    const maxT = recordingSamples() * sampleDt()
    let t0 = Math.max(0, Math.min(tSec - winSec / 2, Math.max(0, maxT - winSec)))
    /*
     * IN ENVELOPE MODE THE WINDOW SNAPS TO THE BUCKET GRID, and that is what stops
     * a wide zoom SHIMMERING while it plays.
     *
     * At a wide zoom a bucket is about a pixel, so the plot is a dense field of
     * one-pixel vertical columns. Panned continuously, each column lands on a
     * slightly different pixel every frame and the whole field re-aliases — moiré
     * that crawls, and only while the clock runs, which is exactly how it was
     * reported. Nothing is wrong with the data; the sampling of it by the pixel grid
     * is what moves.
     *
     * Buckets are ANCHORED to absolute sample positions (see `envelope.ts`), so
     * snapping the window's ORIGIN to that same grid pins every column to a pixel
     * and playback advances one whole column at a time. The step is a bucket — about
     * one pixel, by construction, since that is what chose the bucket — so the scroll
     * does not read as stepped; the shimmer simply stops.
     *
     * The PLAYHEAD is unaffected: it is drawn at `tSec` against these limits, so it
     * still moves smoothly across a grid that now holds still.
     *
     * `plan` is the PREVIOUS frame's, because the plan is computed further down from
     * the same `winSec`. One frame at the old bucket immediately after a zoom is not
     * observable — and reordering to avoid it would put the plan's `plotBoxPx` read
     * ahead of the layout it measures.
     */
    if (plan.mode === 'envelope' && plan.bucket > 1) {
      const col = envelopeColumnSeconds(plan.bucket, sampleDt())
      t0 = Math.floor(t0 / col) * col
    }
    const span: [number, number] = [t0, t0 + winSec]
    /* A PIXEL'S WORTH, measured against the plot the host is drawing over — not a
       fraction of the span, which would fire constantly at a wide zoom and never at
       a narrow one. `plotBoxPx` is read below for the plan; this uses the previous
       frame's width, which is stale only on the frame a resize lands. */
    if (onView) {
      const perPx = winSec / Math.max(1, lastPlotW)
      if (!reported || Math.abs(t0 - lastT0) >= perPx || Math.abs(winSec - lastViewWin) >= perPx) {
        reported = true; lastT0 = t0; lastViewWin = winSec
        onView(t0, t0 + winSec)
      }
    }
    axes.xlim = span
    for (const a of linked()) a.xlim = span

    // Solve for the scale that makes one screenful take `screenSec` at speed 1:
    //   T = winSec / (fps · speed · scale · sampleDt)  and  T = screenSec / speed
    //   ⇒ scale = winSec / (fps · sampleDt · screenSec)
    // `speed` cancels, which is what keeps the dropdown meaning "twice as fast" rather
    // than being swallowed by the pacing.
    clock.speedScale = adaptive
      ? Math.min(winSec / (clock.fps * clockDt * screenSec), maxSpeedScale)
      : 1

    let lt = layoutT + (layoutTarget - layoutT) * ease
    if (Math.abs(lt - layoutTarget) < 0.002) lt = layoutTarget   // settle, don't creep
    layoutT = lt
    line.spacing.value = lt * spacing * dir

    /*
     * Butterfly is centred on 0; stacked brackets the WINDOW — `rows` baselines from
     * `rowOffset`, not the whole montage. The lerp walks between the two.
     *
     * The padding is half a lane OR whatever the gain currently swings, whichever is
     * larger. A trace's amplitude is `gain` in these units (the host normalises by
     * p99, so p99 draws at ±gain) and its real peaks run past that, so a window sized
     * to the baselines alone clips the first and last traces — and only those two,
     * which reads as a rendering fault rather than as a limit.
     */
    const total = Math.max(1, channels())
    const rows = rowsShown()
    rowOffset = clamp(rowOffset, 0, Math.max(0, total - rows))
    const pad = Math.max(spacing * 0.6, gain * 1.25)
    // The two ends of the window, in whichever order the direction puts them.
    const bA = rowOffset * spacing * dir, bB = (rowOffset + rows - 1) * spacing * dir
    const sLo = Math.min(bA, bB) - pad
    const sHi = Math.max(bA, bB) + pad
    axes.ylim = [-bfly + (sLo + bfly) * lt, bfly + (sHi - bfly) * lt]

    if (onRows) {
      const first = Math.round(rowOffset), n = Math.round(rows)
      const key = `${first}/${n}/${total}`
      if (key !== lastRange) { lastRange = key; onRows(first, n, total) }
    }

    /* SAMPLES PER PIXEL, not seconds: the plot box is what the signal has to fit
       into, and it changes when the card is dragged as well as when the zoom is. */
    const plotW = axes.plotBoxPx?.().w ?? 0
    if (plotW > 0) lastPlotW = plotW
    if (plotW > 0) {
      /* `bufferSamples()` is whichever buffer `line` is CURRENTLY bound to — the
         mode's choice, not this attacher's. `drawPlanFor` only windows against it;
         it no longer picks between a page and a stored pyramid (that was `source`,
         retired — see `envelope.ts`). */
      plan = drawPlanFor(winSec / sampleDt(), plotW, bufferSamples(), {
        maxBucket, envelopeSamples: envelopeSamples(),
      })
      const key = plan.mode === 'samples' ? `s${plan.span}` : `e${plan.bucket}/${plan.buckets}`
      if (key !== lastPlanKey) { lastPlanKey = key; onDrawPlan?.(plan) }
    }
    /*
     * THE VIEW'S CENTRE, in ABSOLUTE samples — and nothing about which SLOT that is.
     *
     * This used to compute `line.scroll` itself, in two branches keyed off
     * `plan.mode` and `plan.source`. That was the wrong owner. The plan is what the
     * attacher has just DECIDED; the drawable is still on the source it was last
     * GIVEN, and between the two sit a host round trip and a GPU reduce. Every
     * level transition therefore had a window where a bucket index was read as a
     * sample index — the traces drawn hundreds of buckets from the playhead, which
     * reads as a blank plot or a sideways jump rather than as a coarser picture.
     *
     * `Line.setViewCentre` converts, because it is the only object that knows what
     * it is currently drawing — including which origin its buffer has, which is why
     * `sampleOffset` is no longer subtracted here either.
     */
    line.setViewCentre(tSec / sampleDt())

    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return {
    detach() {
      cancelAnimationFrame(raf)
      el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    },
    setStacked(v) { layoutTarget = v ? 1 : 0 },
    setAdaptive(v) { adaptive = v },
    setWheelAction(a) { action = a },
    setGain(v) { applyGain(clamp(v, GAIN_MIN, GAIN_MAX)) },
    get gain() { return gain },
    setRowOffset(v) { rowOffset = clamp(v, 0, Math.max(0, channels() - rowsShown())) },
    setRowsVisible(v) { rowsWanted = clamp(v, ROWS_MIN, 4096) },
    get rowOffset() { return rowOffset },
    get rowsVisible() { return rowsShown() },
    get drawPlan() { return plan },
    clampTo(sec) { timeGain = Math.max(timeGain, baseWinSec() / sec) },
  }
}
