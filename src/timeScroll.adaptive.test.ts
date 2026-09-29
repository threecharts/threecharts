/**
 * WHAT THE ATTACHER DOES ON ITS FIRST FRAME, which is the frame `setAdaptive` cannot
 * reach.
 *
 * `setAdaptive` is a method on an instance, so a host can only call it once the
 * instance exists — and this attacher is built inside an async figure creation. A host
 * that wants pacing off from the start therefore has no way to say so except at
 * construction, and without one the attacher spent its whole life pacing under a
 * temporal band, whose claim is that the rate is the band's alone.
 *
 * The assertion is on `clock.speedScale` rather than on a getter, because that single
 * number is the entire externally-visible effect: `Clock.advance` multiplies
 * `fps · speed · speedScale`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { attachTimeScroll } from './timeScroll'
import type { Axes } from './Axes'
import type { Line } from './Line'
import type { Clock } from './Clock'

/** One pending callback, run on demand — the frame loop must be driven, not awaited. */
let pending: (() => void)[] = []
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  pending = []
  globalThis.requestAnimationFrame = ((cb: () => void) => { pending.push(cb); return pending.length }) as never
  globalThis.cancelAnimationFrame = (() => {}) as never
})
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
})

const step = () => { const [cb] = pending.splice(0, 1); cb?.() }

/** Move the fake clock. `Clock.position` is a GETTER on the real class, so the
 *  stand-in cannot be driven by plain assignment under `strict`. The cast lives
 *  here, once, rather than at every seek in this file. */
const seek = (c: Clock, p: number): void => { (c as unknown as { position: number }).position = p }

const fakes = () => {
  const clock = { position: 0, fps: 29.4, speedScale: 999 } as unknown as Clock
  const axes = { cursorX: () => 0, xlim: [0, 1], ylim: [0, 1] } as unknown as Axes
  /* `setViewCentre` REPLACED the attacher's own scroll arithmetic (see `Line`): the
     attacher reports WHERE the view is, in absolute samples, and the drawable
     converts to whichever slot its currently-bound source uses. The stub records
     the centre, which is now the whole of the attacher's side of that contract. */
  const centres: number[] = []
  const line = {
    gain: { value: 1 }, spacing: { value: 0 }, scroll: { value: 0 },
    setViewCentre: (s: number) => { centres.push(s) },
    centres,
  } as unknown as Line
  const el = { addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement
  return { clock, axes, line, el }
}

const opts = (clock: Clock) => ({
  clock, sampleDt: () => 1 / 300, maxWinSec: () => 10, channels: () => 8, screenSec: 6,
  bufferSamples: () => 32768,
})

describe('attachTimeScroll — pacing at construction', () => {
  it('pins speedScale to 1 from the FIRST frame when built with adaptive: false', () => {
    const { clock, axes, line, el } = fakes()
    const ts = attachTimeScroll(axes, line, el, { ...opts(clock), adaptive: false })
    step()
    expect(clock.speedScale).toBe(1)
    ts.detach()
  })

  /* The control arm: the default must not change, or every caller without a band
     silently loses the constant on-screen sweep this attacher exists to hold. */
  it('paces by default, and the scale is the one the solve prescribes', () => {
    const { clock, axes, line, el } = fakes()
    const ts = attachTimeScroll(axes, line, el, opts(clock))
    step()
    // winSec / (fps · sampleDt · screenSec), with winSec = the 0.6 s default span
    expect(clock.speedScale).toBeCloseTo(0.6 / (29.4 * (1 / 300) * 6), 6)
    ts.detach()
  })
})

describe('attachTimeScroll — the draw plan', () => {
  /* The bucket follows SAMPLES PER PIXEL, which is the visible span divided by the
     plot's width — not the span alone. A wider card at the same zoom needs a finer
     bucket, and a chart that ignored that would coarsen when it was made bigger. */
  const withPlot = (w: number) => {
    const { clock, line, el } = fakes()
    const axes = {
      cursorX: () => 0, xlim: [0, 1], ylim: [0, 1],
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      plotBoxPx: () => ({ left: 0, top: 0, w, h: 100 }),
    } as unknown as Axes
    return { clock, axes, line, el }
  }

  it('reports SAMPLES when fewer than two land on a pixel, spanning a power of two', () => {
    const seen: unknown[] = []
    const { clock, axes, line, el } = withPlot(1000)
    // 1 s visible at 300 Hz = 300 samples over 1000 px → 0.3 samples/px.
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 10, channels: () => 8,
      baseWinSec: () => 1, bufferSamples: () => 3000, onDrawPlan: (p) => seen.push(p),
    })
    step()
    // 1 s at 300 Hz = 300 visible samples → the next power of two up is 512.
    expect(seen).toEqual([{ mode: 'samples', span: 512 }])
    ts.detach()
  })

  it('reports an ENVELOPE bucket at a wide span', () => {
    const seen: unknown[] = []
    const { clock, axes, line, el } = withPlot(1000)
    // 100 s at 300 Hz = 30000 samples over 1000 px → 30 samples/px → bucket 16.
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8,
      baseWinSec: () => 100, bufferSamples: () => 30_000, onDrawPlan: (p) => seen.push(p),
    })
    step()
    expect(seen).toEqual([{ mode: 'envelope', bucket: 16, buckets: 1875 }])
    ts.detach()
  })

  /*
   * THE VIEW'S CENTRE, and it is ALL the attacher says about the window now.
   *
   * It used to compute `line.scroll` itself, in two branches keyed off the plan's
   * mode and source — while the drawable was still on the source it was last GIVEN,
   * one host round trip and one GPU reduce behind. Reading a bucket index as a
   * sample index draws the traces far from the playhead, which is the blank-plot
   * flash at every level transition. The clamping and the unit conversion moved to
   * `scrollSlotFor` (tested in `envelope.test.ts`) via `Line.setViewCentre`; what
   * belongs here is that the centre is ABSOLUTE and carries no offset of its own.
   */
  it('reports the playhead as an absolute sample, whatever the plan', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const seen = (line as unknown as { centres: number[] }).centres
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 10, channels: () => 8, baseWinSec: () => 1,
      bufferSamples: () => 3000,
    })
    step()
    expect(seen.at(-1)).toBe(0)
    seek(clock, 3000)
    step()
    /* The RAW sample index — not 3000 − span/2, and not a bucket. A clamp here
       would be a clamp against a span this object no longer knows. */
    expect(seen.at(-1)).toBe(3000)
    ts.detach()
  })

  /* THE SAME QUANTITY UNDER AN ENVELOPE PLAN — its own test because `step()` drains
     one shared queue and two attachers in one body interleave on it. This is the
     assertion that matters: the wide view reports the identical number, so nothing
     downstream can be handed a bucket index by mistake. */
  it('reports the same absolute sample when the plan is an envelope', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const seen = (line as unknown as { centres: number[] }).centres
    const plans: unknown[] = []
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8,
      baseWinSec: () => 100, bufferSamples: () => 30_000, onDrawPlan: (p) => plans.push(p),
    })
    seek(clock, 3000)
    step()
    expect(plans[0]).toMatchObject({ mode: 'envelope' })
    expect(seen.at(-1)).toBe(3000)
    ts.detach()
  })

  /*
   * THE AXIS NEVER SHOWS NEGATIVE TIME. A recording starts at t = 0 and there is
   * nothing before it, so a window centred near the start has to SHIFT rather than
   * run off the end — negative time is an axis asserting samples that cannot exist,
   * and it also made zoom-out look symmetric about the playhead everywhere when at
   * the ends it cannot be.
   */
  const xlimOf = (axes: Axes) => (axes as unknown as { xlim: [number, number] }).xlim

  it('shifts the window rather than showing time before the recording', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8, baseWinSec: () => 10,
      bufferSamples: () => 32768,
    })
    seek(clock, 150)          // 0.5 s in, against a 10 s window
    step()
    const [lo, hi] = xlimOf(axes)
    expect(lo).toBe(0)
    // SHIFTED, not shrunk: the zoom still means ten seconds.
    expect(hi - lo).toBeCloseTo(10, 6)
    ts.detach()
  })

  it('stops at the end of the recording too', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8, baseWinSec: () => 10,
      bufferSamples: () => 32768,
    })
    seek(clock, 300 * 99.5)   // 99.5 s into a 100 s recording
    step()
    const [lo, hi] = xlimOf(axes)
    expect(hi).toBeCloseTo(100, 6)
    expect(hi - lo).toBeCloseTo(10, 6)
    ts.detach()
  })

  /*
   * THE CLAMP IS AGAINST THE RECORDING, NOT THE PAGE — the regression that came in
   * with it, and the one no single-page fixture can see.
   *
   * `maxWinSec` is the widest span the chart may SHOW, which without a stored
   * pyramid is ONE PAGE. The axis is in absolute recording time. Clamping to a
   * page's WIDTH therefore pinned the window inside the first page on every page
   * after it, and the playhead — which is drawn at its own absolute time — left the
   * screen entirely from page two onward.
   */
  it('does not clamp a later page back into the first one', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, channels: () => 8, baseWinSec: () => 10,
      // One page of 109.2 s is the widest showable span…
      maxWinSec: () => 109.2,
      bufferSamples: () => 32768,
      // …and the recording is forty of them.
      recordingSamples: () => 32768 * 40,
    })
    seek(clock, 300 * 500)          // 500 s in: page 4, nowhere near either end
    step()
    const [lo, hi] = xlimOf(axes)
    expect((lo + hi) / 2).toBeCloseTo(500, 6)
    ts.detach()
  })

  /* And AWAY from the ends it is still centred — the clamp must not become a
     permanent left-shift, which is what a one-sided `Math.max(0, …)` would give. */
  it('keeps the playhead centred away from either end', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8, baseWinSec: () => 10,
      bufferSamples: () => 32768,
    })
    seek(clock, 300 * 50)
    step()
    const [lo, hi] = xlimOf(axes)
    expect((lo + hi) / 2).toBeCloseTo(50, 6)
    ts.detach()
  })

  /*
   * THE BUCKET GRID HOLDS STILL while an envelope plays — the fix for a wide zoom
   * that shimmered. A bucket is about a pixel there, so a window panned by
   * fractions of one re-aliases the whole field every frame; snapped to the grid
   * the columns keep their pixels and only the playhead moves.
   */
  it('snaps the window origin to the bucket grid in envelope mode', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8, baseWinSec: () => 100,
      bufferSamples: () => 32768,
    })
    step()                                  // settles the plan: bucket 16
    seek(clock, 300 * 50 + 7)           // a deliberately off-grid playhead
    step()
    const [lo] = xlimOf(axes)
    const col = 16 / 300
    expect(lo / col).toBeCloseTo(Math.round(lo / col), 6)
    ts.detach()
  })

  /* And NOT in sample mode, where a column is many pixels wide and snapping would
     be a visible stutter for no gain. */
  it('does not snap when it is drawing samples', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8, baseWinSec: () => 1,
      bufferSamples: () => 32768,
    })
    step()
    seek(clock, 300 * 50 + 7)
    step()
    const [lo] = xlimOf(axes)
    expect(lo).toBeCloseTo((300 * 50 + 7) / 300 - 0.5, 6)
    ts.detach()
  })

  /*
   * THE VIEW IS REPORTED ON THE FIRST FRAME, and that is the arm that was missing.
   *
   * `onView` seeded its "last reported" state with `NaN`, and every comparison
   * against `NaN` is false — so it never fired, ever, and the host feature
   * positioned against it (the resident-page marker) could not mount at all. The
   * sibling state one block up uses `''` for exactly this reason: an empty key
   * cannot be produced, so the first frame always reports. A numeric field has no
   * such value, which is why this one needs a flag.
   */
  it('reports the view on the FIRST frame, not only on a change', () => {
    const seen: Array<[number, number]> = []
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, bufferSamples: () => 32_768,
      recordingSamples: () => 180_000, maxWinSec: () => 600,
      channels: () => 8, baseWinSec: () => 10,
      onView: (a, b) => seen.push([a, b]),
    })
    step()
    expect(seen.length).toBe(1)
    expect(seen[0][1] - seen[0][0]).toBeCloseTo(10, 6)
    ts.detach()
  })

  /* And NOT on every frame after that — it runs at 60 Hz and the host puts it in
     React state. A pixel's worth is the threshold because the consumer is drawing. */
  it('does not re-report a view that has not moved a pixel', () => {
    const seen: unknown[] = []
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, bufferSamples: () => 32_768,
      recordingSamples: () => 180_000, maxWinSec: () => 600,
      channels: () => 8, baseWinSec: () => 10,
      onView: (a, b) => seen.push([a, b]),
    })
    step(); step(); step()
    expect(seen.length).toBe(1)
    ts.detach()
  })

  /* Only on a CHANGE. This fires from the frame loop, so a host putting it into
     React state would re-render sixty times a second otherwise. */
  it('fires only when the plan changes', () => {
    const seen: unknown[] = []
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 100, channels: () => 8,
      baseWinSec: () => 100, bufferSamples: () => 30_000, onDrawPlan: (p) => seen.push(p),
    })
    step(); step(); step()
    expect(seen).toEqual([{ mode: 'envelope', bucket: 16, buckets: 1875 }])
    ts.detach()
  })
})

describe('attachTimeScroll — the clock and the buffer are different clocks', () => {
  /* The view is centred on the CLOCK's time and measured in the BUFFER's samples.
     They were one number only because the traces read the analysis page; a native
     page under a decimated clock makes them differ by the decimation ratio, and a
     chart that conflated them would centre the view 8x away from the playhead. */
  const withPlotBox = () => {
    const { clock, line, el } = fakes()
    const axes = {
      cursorX: () => 0, xlim: [0, 1] as [number, number], ylim: [0, 1],
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      plotBoxPx: () => ({ left: 0, top: 0, w: 1000, h: 100 }),
    } as unknown as Axes
    return { clock, axes, line, el }
  }

  /* The playhead sits WELL CLEAR OF t = 0 in both tests below, which it did not
     have to before the axis was clamped to the recording. These are about which
     RATE the centre is read at; parked half a window from the start they would
     instead measure the clamp, and would have gone on passing while saying nothing
     about the rate. The clamp has its own test above. */
  it('centres on clockToSec while measuring the span in buffer samples', () => {
    const { clock, axes, line, el } = withPlotBox()
    seek(clock, 1000)
    const seen: unknown[] = []
    const ts = attachTimeScroll(axes, line, el, {
      clock,
      sampleDt: () => 1 / 2400,           // the BUFFER: native
      clockToSec: () => 1000 / 300,       // the CLOCK: 1000 timepoints at 300 Hz
      clockDt: 1 / 300,
      maxWinSec: () => 13.6, channels: () => 8, baseWinSec: () => 1,
      bufferSamples: () => 32768,
      onDrawPlan: (p) => seen.push(p),
    })
    step()
    const [lo, hi] = (axes as unknown as { xlim: [number, number] }).xlim
    expect((lo + hi) / 2).toBeCloseTo(1000 / 300, 5)    // centred on the CLOCK
    /* And NOT on the buffer's own rate, which is the conflation this guards. */
    expect((lo + hi) / 2).not.toBeCloseTo(1000 / 2400, 5)
    /* And the plan is the sharper half of the proof. 1 s holds 2400 samples of the
       BUFFER over 1000 px — 2.4 a pixel, above the threshold, so an envelope. At the
       CLOCK's 300 Hz it would be 0.3 a pixel and the plan would say samples. Getting
       an envelope here is only possible if the span was measured in buffer samples. */
    expect(seen).toEqual([{ mode: 'envelope', bucket: 2, buckets: 2048 }])
    ts.detach()
  })

  it('defaults both to sampleDt, so existing callers are unchanged', () => {
    const { clock, axes, line, el } = withPlotBox()
    seek(clock, 600)
    const ts = attachTimeScroll(axes, line, el, {
      clock, sampleDt: () => 1 / 300, maxWinSec: () => 10, channels: () => 8, baseWinSec: () => 1,
      bufferSamples: () => 32768,
    })
    step()
    const [lo, hi] = (axes as unknown as { xlim: [number, number] }).xlim
    expect((lo + hi) / 2).toBeCloseTo(600 / 300, 5)
    ts.detach()
  })
})

/*
 * THE TRANSITIONS (spec §4). Play clamps the view into the page; a NAVIGATION
 * gesture that leaves the page stops playback.
 *
 * The clock's own page advance is NOT such a gesture, and that distinction is the
 * one a literal reading of the rule gets wrong: play auto-advances across pages, so
 * a rule that fired on "the page changed" would stop playback at the first boundary —
 * the opposite of what play is for. Only the wheel calls this.
 */
describe('attachTimeScroll — the mode transitions', () => {
  const withPlot = (w: number) => {
    const { clock, line, el } = fakes()
    const axes = {
      cursorX: () => 0, xlim: [0, 1], ylim: [0, 1],
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      plotBoxPx: () => ({ left: 0, top: 0, w, h: 100 }),
    } as unknown as Axes
    return { clock, axes, line, el }
  }
  const xlimOf = (axes: Axes) => (axes as unknown as { xlim: [number, number] }).xlim

  /*
   * ── THE FIXTURE, DERIVED THE WAY THE APP DERIVES IT ──────────────────────────
   *
   * These three getters used to be four magic numbers, one of them a bare `600`. They
   * happened to describe a buffer NARROWER than the ceiling — which is what the
   * transition needs — while the app, until 2026-08-21, made the two THE SAME
   * QUANTITY: `SensorTimeseriesChart.resolveSource` set ANALYSE's `maxWinSec` to
   * `pane.frames × pane.sampleDt`, the span of the very buffer `bufferSamples` names.
   * The escape test below is `winNow / sampleDt() > bufferSamples()` with `winNow`
   * capped at `maxWinSec()`, so under the app's own numbers it read `frames > frames`
   * — never true. This suite was green the whole time, on a fixture the app could not
   * produce. `idrive -- trace-modes` arm 3 is what saw it.
   *
   * So the relation is spelled out rather than coincidental: the ceiling is the
   * RECORDING (`RECORDING_SAMPLES × SAMPLE_DT`), the bound buffer is one PAGE, and
   * `HEADROOM` asserts the gap the transition lives in. Change any one of them and
   * the guard below fails loudly instead of the arm quietly proving nothing.
   */
  const SAMPLE_DT = 1 / 300
  /** One resident page — what `bufferSamples()` names. 109.23 s at this rate. */
  const PAGE_SAMPLES = 32768
  /** The whole recording, in the drawn buffer's own samples. 600 s at this rate. */
  const RECORDING_SAMPLES = 180_000
  const MAX_WIN_SEC = RECORDING_SAMPLES * SAMPLE_DT
  const PAGE_SEC = PAGE_SAMPLES * SAMPLE_DT

  /* THE PREMISE OF THE THIRD ARM, asserted rather than assumed. Without headroom
     there is no span the wheel can reach that lies outside the bound buffer, so the
     arm would pass on a `left` that could never be incremented — the shape of a gate
     that cannot fail. */
  it('the fixture leaves the wheel somewhere to go (the premise of the arm below)', () => {
    expect(MAX_WIN_SEC).toBeGreaterThan(PAGE_SEC)
  })

  /** The app's own three terms, so no arm restates them and none can drift. */
  const span = {
    sampleDt: () => SAMPLE_DT,
    bufferSamples: () => PAGE_SAMPLES,
    maxWinSec: () => MAX_WIN_SEC,
    recordingSamples: () => RECORDING_SAMPLES,
  }

  it('clamps the visible span on request, centred on the cursor', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, ...span,
      channels: () => 8, baseWinSec: () => 100,
    })
    seek(clock, 300 * 50)
    step()
    expect(xlimOf(axes)[1] - xlimOf(axes)[0]).toBeCloseTo(100, 6)
    ts.clampTo(10)
    step()
    /* One more frame to settle: the snap-to-bucket-grid guard (`plan` is always the
       PREVIOUS frame's, by design — see `timeScroll.ts`) draws this first post-clamp
       frame at the WIDE zoom's bucket, which is coarser than the now-10s window and
       nudges the centre by under a bucket. A second frame lets `plan` catch up to the
       narrower span before the exact centre is checked. */
    step()
    const [lo, hi] = xlimOf(axes)
    expect(hi - lo).toBeCloseTo(10, 6)
    expect((lo + hi) / 2).toBeCloseTo(50, 6)
    ts.detach()
  })

  /* A span already inside the limit is LEFT ALONE — clamping is a ceiling, not a
     zoom-to-fit, or pressing play would throw away a reader's chosen zoom. */
  it('leaves a span that already fits', () => {
    const { clock, axes, line, el } = withPlot(1000)
    const ts = attachTimeScroll(axes, line, el, {
      clock, ...span,
      channels: () => 8, baseWinSec: () => 4,
    })
    step()
    ts.clampTo(10)
    step()
    expect(xlimOf(axes)[1] - xlimOf(axes)[0]).toBeCloseTo(4, 6)
    ts.detach()
  })

  it('reports a wheel zoom that leaves the bound buffer, once', () => {
    let left = 0
    const { clock, axes, line } = withPlot(1000)
    const listeners: Record<string, (e: never) => void> = {}
    const host = {
      addEventListener: (k: string, fn: (e: never) => void) => { listeners[k] = fn },
      removeEventListener: () => {},
    } as unknown as HTMLElement
    const ts = attachTimeScroll(axes, line, host, {
      clock, ...span,
      channels: () => 8, baseWinSec: () => 100, onLeavePage: () => { left += 1 },
    })
    // The wheel is armed for GAIN by default (see `attachTimeScroll`'s `action`) —
    // a bare scroll has to mean one thing, and only the TIME arming is a navigation
    // gesture over the span at all.
    ts.setWheelAction('time')
    // One page is 109.23 s at this rate; the 100 s opening window is inside it.
    expect(PAGE_SEC).toBeGreaterThan(100)
    step()
    expect(left).toBe(0)
    // Zoom OUT past it.
    listeners.wheel?.({ deltaY: 400, ctrlKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {} } as never)
    step()
    expect(left).toBe(1)
    // A second notch, still outside — must NOT fire again. This is the edge-trigger
    // assertion: remove `wasOutside` and this goes red while the first fire stays green.
    listeners.wheel?.({ deltaY: 400, ctrlKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {} } as never)
    step()
    expect(left).toBe(1)
    ts.detach()
  })
})

/*
 * ── THE PAN TOOL ──────────────────────────────────────────────────────────────
 *
 * Panning moves the CURSOR, because the window is centred on it — there is no
 * separate pan offset, and adding one would be a second place "where are we" is
 * written down, free to disagree with the transport.
 *
 * So a pan is a SEEK, and seeking is the host's: the clock is page-local and a drag
 * can cross a page boundary, which only the host can make resident. Nothing here
 * starts the clock — with it paused, a pan is one solve at the new time.
 */
describe('attachTimeScroll — the pan tool', () => {
  const withHost = (w: number) => {
    const { clock, line } = fakes()
    const listeners: Record<string, (e: never) => void> = {}
    const el = {
      addEventListener: (k: string, fn: (e: never) => void) => { listeners[k] = fn },
      removeEventListener: () => {},
      setPointerCapture: () => {}, releasePointerCapture: () => {},
    } as unknown as HTMLElement
    const axes = {
      cursorX: () => 0, xlim: [0, 1] as [number, number], ylim: [0, 1],
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      plotBoxPx: () => ({ left: 0, top: 0, w, h: 100 }),
    } as unknown as Axes
    return { clock, axes, line, el, listeners }
  }

  const opts = (clock: Clock, onSeek: (t: number) => void) => ({
    clock, sampleDt: () => 1 / 300, bufferSamples: () => 32_768,
    recordingSamples: () => 180_000, maxWinSec: () => 600,
    channels: () => 8, baseWinSec: () => 100, onSeek,
  })

  it('does not seek while the pan tool is not armed', () => {
    const seeks: number[] = []
    const { clock, axes, line, el, listeners } = withHost(1000)
    const ts = attachTimeScroll(axes, line, el, opts(clock, (t) => seeks.push(t)))
    step()
    listeners.pointerdown?.({ button: 0, clientX: 500, clientY: 0, pointerId: 1 } as never)
    listeners.pointermove?.({ clientX: 400, clientY: 0, pointerId: 1 } as never)
    expect(seeks).toEqual([])
    ts.detach()
  })

  /* Armed, a drag asks for a time. Dragging RIGHT goes BACK — the direction the
     content moves under the hand, which is what a hand tool means. */
  it('seeks backwards when the hand drags forwards', () => {
    const seeks: number[] = []
    const { clock, axes, line, el, listeners } = withHost(1000)
    const ts = attachTimeScroll(axes, line, el, opts(clock, (t) => seeks.push(t)))
    ts.setWheelAction('pan')
    seek(clock, 300 * 50)          // 50 s in
    step()
    listeners.pointerdown?.({ button: 0, clientX: 500, clientY: 0, pointerId: 1 } as never)
    listeners.pointermove?.({ clientX: 600, clientY: 0, pointerId: 1 } as never)
    expect(seeks).toHaveLength(1)
    // 100 px of a 1000 px plot showing 100 s = 10 s, backwards from 50 s.
    expect(seeks[0]).toBeCloseTo(40, 6)
    ts.detach()
  })

  /* AND IT DOES NOT START THE CLOCK. A pan while paused is a single-timepoint move;
     if it played, the overview would become an animation nobody asked for. */
  it('never starts playback', () => {
    const { clock, axes, line, el, listeners } = withHost(1000)
    const played: string[] = []
    ;(clock as unknown as { play: () => void }).play = () => { played.push('play') }
    const ts = attachTimeScroll(axes, line, el, opts(clock, () => {}))
    ts.setWheelAction('pan')
    step()
    listeners.pointerdown?.({ button: 0, clientX: 500, clientY: 0, pointerId: 1 } as never)
    listeners.pointermove?.({ clientX: 600, clientY: 0, pointerId: 1 } as never)
    expect(played).toEqual([])
    ts.detach()
  })
})
