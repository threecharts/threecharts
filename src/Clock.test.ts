/**
 * Clock — the loop/park state machine, and the `ended` flag hosts page on.
 *
 * WHY THIS FILE EXISTS. `ended` was added so `SessionAdapter` could tell END OF
 * PLAY from a user pause and advance the resident page on the first only. It
 * shipped with `toggle()` — the one entry point `TransportBar`'s play button
 * actually calls — not clearing it, and the end-to-end driver could not see that:
 * a latched flag self-heals in production because `advance` immediately re-parks.
 * A 1 ms unit test caught it. Every clearing entry point is enumerated below for
 * that reason; add one to `Clock` and add it here.
 */
import { describe, it, expect, vi } from 'vitest'

/* three/tsl's `uniform` is a WebGPU-node factory and this suite has no device.
   The Clock only ever assigns `.value` on it, so a plain box is a faithful stand-in
   — and stubbing here rather than importing the real one is what keeps this file at
   1 ms and runnable in the `node` environment the package's other tests use. */
vi.mock('three/tsl', () => ({ uniform: (v: number) => ({ value: v }) }))

const { Clock } = await import('./Clock')

/** A clock wound to the frame BEFORE the end, so one `advance` crosses it. */
function atLastFrame(frameCount = 10) {
  const c = new Clock()
  c.setFrameCount(frameCount)
  c.fps = 1; c.speed = 1; c.speedScale = 1; c.maxRate = Infinity
  c.seek(frameCount - 1)
  c.play()
  return c
}

describe('Clock — looping (unchanged behaviour)', () => {
  it('wraps and never ends while `loop` is true', () => {
    const c = atLastFrame(10)
    expect(c.loop).toBe(true)          // the default, and what a single-page recording keeps
    c.advance(2)                       // 9 + 2 → 11 → wraps to 1
    expect(c.position).toBeCloseTo(1)
    expect(c.playing).toBe(true)
    expect(c.ended).toBe(false)
  })

  it('wraps repeatedly without ever setting `ended`', () => {
    const c = atLastFrame(10)
    for (let i = 0; i < 20; i++) c.advance(1)
    expect(c.ended).toBe(false)
    expect(c.playing).toBe(true)
  })
})

describe('Clock — parking (the page-advance mechanism)', () => {
  it('parks at the last frame, stops, sets `ended` and NOTIFIES, all in one advance', () => {
    const c = atLastFrame(10)
    c.loop = false
    const seen: Array<{ ended: boolean; playing: boolean; position: number }> = []
    c.subscribe(() => seen.push({ ended: c.ended, playing: c.playing, position: c.position }))

    c.advance(5)                       // 9 + 5 → 14, well past the end

    expect(c.position).toBe(9)         // parked, not wrapped and not run on
    expect(c.playing).toBe(false)
    expect(c.ended).toBe(true)
    // The notification is the whole mechanism: the host is PUSHED, it never polls.
    // And the state must already be final when it arrives — a subscriber that saw
    // `ended` false would be a subscriber that could not act.
    expect(seen).toEqual([{ ended: true, playing: false, position: 9 }])
  })

  it('overshooting by any amount parks at the same place — no index is observed', () => {
    for (const dt of [1, 3, 100, 1e6]) {
      const c = atLastFrame(10)
      c.loop = false
      c.advance(dt)
      expect(c.position).toBe(9)
      expect(c.ended).toBe(true)
    }
  })

  it('a parked clock stays parked and re-notifies nothing', () => {
    const c = atLastFrame(10)
    c.loop = false
    c.advance(5)
    const seen = vi.fn()
    c.subscribe(seen)
    c.advance(5)                       // not playing → advance returns immediately
    expect(seen).not.toHaveBeenCalled()
    expect(c.position).toBe(9)
  })

  it('`pause` does NOT set `ended` — that is the distinction the flag exists for', () => {
    const c = atLastFrame(10)
    c.loop = false
    c.seek(4)
    c.pause()
    expect(c.playing).toBe(false)
    expect(c.ended).toBe(false)
  })
})

describe('Clock — every entry point that clears `ended`', () => {
  /** Park a non-looping clock: `ended` true, `playing` false. */
  const parked = () => { const c = atLastFrame(10); c.loop = false; c.advance(5); return c }

  it('play', () => {
    const c = parked()
    c.play()
    expect(c.ended).toBe(false)
    expect(c.playing).toBe(true)
  })

  it('seek', () => {
    const c = parked()
    c.seek(3)
    expect(c.ended).toBe(false)
  })

  it('setFrameCount', () => {
    const c = parked()
    c.setFrameCount(20)
    expect(c.ended).toBe(false)
  })

  /*
   * THE ONE THAT WAS MISSING, and the only one the UI actually calls:
   * `TransportBar`'s play button is `onTogglePlay={() => clock.toggle()}`.
   *
   * Before the fix `toggle` flipped `_playing` directly and left `ended` latched
   * true, so resuming from an end-of-play ran with the flag set. The host's
   * subscriber is `if (!clock.ended …) return`, and `toggle` EMITS — so the very
   * act of pressing play delivered a notification with `ended` still true and
   * could trigger a page advance from a resume.
   */
  it('toggle — resuming clears it, and the notification it emits already says so', () => {
    const c = parked()
    const seen: boolean[] = []
    c.subscribe(() => seen.push(c.ended))
    c.toggle()
    expect(c.playing).toBe(true)
    expect(c.ended).toBe(false)
    expect(seen).toEqual([false])
  })

  it('toggle — pausing neither sets nor clears it', () => {
    const c = atLastFrame(10)
    c.loop = false
    c.seek(4)
    c.toggle()                          // playing → paused
    expect(c.playing).toBe(false)
    expect(c.ended).toBe(false)
  })

  it('toggle still emits on every call (it always changes `playing`)', () => {
    const c = atLastFrame(10)
    const seen = vi.fn()
    c.subscribe(seen)
    c.toggle(); c.toggle(); c.toggle()
    expect(seen).toHaveBeenCalledTimes(3)
  })

  /*
   * THE FROZEN-CLOCK LEAD, tested rather than assumed.
   *
   * A run of `idrive -- transport-span` was once seen with the clock stuck at
   * position 0, and a latched `ended` was proposed as the mechanism. It is NOT:
   * resuming a parked clock through the pre-fix `toggle` left `ended` true but
   * `playing` true as well, and `advance` then moves it — the clock runs, it does
   * not freeze. What a latched flag produced was a spurious host action (a page
   * advance on a resume), not a stopped clock. Recorded here so the lead is not
   * chased again from the same premise.
   */
  it('a latched `ended` does not stop a playing clock (so it cannot be the freeze)', () => {
    const c = parked()
    c.ended = true                      // force the pre-fix state
    c.play(); c.ended = true            // …and keep it latched past the resume
    c.loop = true                       // looping, so nothing re-parks it
    c.seek(0); c.ended = true
    c.advance(3)
    expect(c.position).toBeCloseTo(3)   // it MOVED
    expect(c.playing).toBe(true)
  })
})

describe('Clock — rate and clamping', () => {
  it('`maxRate` caps the advance', () => {
    const c = new Clock()
    c.setFrameCount(1000)
    c.fps = 100; c.speed = 10; c.speedScale = 1; c.maxRate = 50
    c.play()
    c.advance(1)
    expect(c.position).toBeCloseTo(50)   // not 1000
  })

  it('`setFrameCount` clamps a position past the new end', () => {
    const c = new Clock()
    c.setFrameCount(100)
    c.seek(99)
    c.setFrameCount(10)
    expect(c.position).toBe(9)
  })

  it('`seek` clamps into range and never ends', () => {
    const c = new Clock()
    c.setFrameCount(10)
    c.seek(1e6); expect(c.position).toBe(9)
    c.seek(-5); expect(c.position).toBe(0)
    expect(c.ended).toBe(false)
  })

  it('a single-frame clock never advances (nothing to page, nothing to wrap)', () => {
    const c = new Clock()
    c.setFrameCount(1)
    c.loop = false
    c.play()
    c.advance(100)
    expect(c.position).toBe(0)
    expect(c.ended).toBe(false)
  })
})

describe('Clock — the abstract range', () => {
  it('setRange defines the bounds, in whatever unit the host chose', () => {
    const c = new Clock()
    c.setRange(-0.5, 599.5)
    expect(c.min).toBe(-0.5)
    expect(c.max).toBe(599.5)
  })

  it('seek clamps to the range, not to a frame count', () => {
    const c = new Clock()
    c.setRange(10, 20)
    c.seek(5); expect(c.position).toBe(10)
    c.seek(25); expect(c.position).toBe(20)
    c.seek(15.5); expect(c.position).toBe(15.5)
  })

  it('setRange clamps a position that falls outside the new range', () => {
    const c = new Clock()
    c.setRange(0, 100)
    c.seek(90)
    c.setRange(0, 50)
    expect(c.position).toBe(50)
  })

  it('a non-looping advance parks at max and sets ended', () => {
    const c = new Clock()
    c.setRange(0, 10)
    c.loop = false
    c.fps = 1; c.speed = 1; c.speedScale = 1; c.maxRate = Infinity
    c.seek(9.5)
    c.play()
    c.advance(1)
    expect(c.position).toBe(10)
    expect(c.playing).toBe(false)
    expect(c.ended).toBe(true)
  })

  it('a looping advance wraps to MIN, not to zero', () => {
    const c = new Clock()
    c.setRange(100, 110)
    c.loop = true
    c.fps = 1; c.speed = 1; c.speedScale = 1; c.maxRate = Infinity
    c.seek(109.5)
    c.play()
    c.advance(1)                        // 110.5 -> wraps by period 10 -> 100.5
    expect(c.position).toBeCloseTo(100.5, 10)
    expect(c.ended).toBe(false)
  })

  /* A frame count is an EXCLUSIVE bound; a range is INCLUSIVE. Ten frames are
     [0, 9] but the period is 10, because frame 9 occupies [9, 10) and must be
     displayed for its full duration. Deriving the period as max - min gives 9,
     and the last frame would never be shown. */
  it('a frame count keeps its EXCLUSIVE period — the last frame gets its full duration', () => {
    const c = new Clock()
    c.setFrameCount(10)
    c.loop = true
    c.fps = 1; c.speed = 1; c.speedScale = 1; c.maxRate = Infinity
    c.seek(9)
    c.play()
    c.advance(2)                        // 11 -> 11 % 10 -> 1   (NOT 11 % 9 -> 2)
    expect(c.position).toBeCloseTo(1, 10)
  })

  it('setFrameCount survives as an alias for non-recording figures', () => {
    const c = new Clock()
    c.setFrameCount(10)
    expect(c.rangeMode).toBe('frames')
    expect(c.min).toBe(0)
    expect(c.max).toBe(9)
    expect(c.frameCount).toBe(10)
  })

  it('parks frameUniform at -1 in CONTINUOUS mode — a column cannot be derived here', () => {
    const c = new Clock()
    c.setRange(100, 110)
    c.seek(103.25)
    expect(c.rangeMode).toBe('continuous')
    expect(c.frameUniform.value).toBe(-1)
    expect(c.timeUniform.value).toBeCloseTo(3.25, 10)
  })

  it('still derives a BUFFER INDEX in FRAMES mode — the standalone figure path', () => {
    const c = new Clock()
    c.setFrameCount(8)
    c.seek(3.75)
    expect(c.rangeMode).toBe('frames')
    expect(c.frameUniform.value).toBe(3)
    expect(c.timeUniform.value).toBeCloseTo(3.75, 10)
  })
})
