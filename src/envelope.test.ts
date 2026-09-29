import { describe, it, expect } from 'vitest'
import {
  bucketForSpp, bucketCount, envelopeVertexCount, envelopeVertexXY, ENVELOPE_MIN_SPP,
  scrollSlotFor, envelopeColumnSeconds,
  spanForVisible, drawPlanFor,
} from './envelope'

describe('bucketForSpp', () => {
  /* Below the threshold there is nothing to summarise: fewer than two samples
     land on a pixel, so an envelope would invent detail rather than remove it. */
  it('returns 1 (draw samples) below the threshold', () => {
    expect(bucketForSpp(0.25)).toBe(1)
    expect(bucketForSpp(1.99)).toBe(1)
    expect(ENVELOPE_MIN_SPP).toBe(2)
  })

  /* Powers of two only — the bucket grid is anchored to absolute sample
     positions, and a non-power-of-two would re-align on every zoom notch. */
  it('rounds DOWN to a power of two, so a bucket never spans more than a pixel', () => {
    expect(bucketForSpp(2)).toBe(2)
    expect(bucketForSpp(3.9)).toBe(2)
    expect(bucketForSpp(4)).toBe(4)
    expect(bucketForSpp(31)).toBe(16)
    expect(bucketForSpp(32)).toBe(32)
  })

  it('clamps at maxBucket', () => {
    expect(bucketForSpp(1e6, 1024)).toBe(1024)
  })

  it('survives degenerate input rather than returning NaN', () => {
    expect(bucketForSpp(0)).toBe(1)
    expect(bucketForSpp(Number.NaN)).toBe(1)
    expect(bucketForSpp(-3)).toBe(1)
  })
})

describe('bucketCount', () => {
  it('covers a partial tail', () => {
    expect(bucketCount(1024, 4)).toBe(256)
    expect(bucketCount(1025, 4)).toBe(257)
    expect(bucketCount(3, 4)).toBe(1)
  })
})

describe('envelopeVertexCount', () => {
  /* 2 values a bucket, consecutive values joined: min→max is the vertical
     extent, max→next min is the link between columns. */
  it('is channels × (2·buckets − 1) × 2', () => {
    expect(envelopeVertexCount(3, 10)).toBe(3 * 19 * 2)
  })
})

describe('envelopeVertexXY — the CPU mirror of the shader formula', () => {
  const buckets = 4, bucket = 8, dt = 0.01
  // [chan 0: (min,max) × 4] then [chan 1: …]
  const values = [
    -1, 1, -2, 2, -3, 3, -4, 4,
    -5, 5, -6, 6, -7, 7, -8, 8,
  ]

  it('places both values of a bucket at the bucket CENTRE', () => {
    const a = envelopeVertexXY(0, buckets, bucket, dt, values)
    const b = envelopeVertexXY(1, buckets, bucket, dt, values)
    expect(a.x).toBeCloseTo(0.5 * bucket * dt)
    expect(b.x).toBe(a.x)
    expect(a.value).toBe(-1)
    expect(b.value).toBe(1)
  })

  it('advances one bucket every two vertices', () => {
    expect(envelopeVertexXY(2, buckets, bucket, dt, values).x).toBeCloseTo(1.5 * bucket * dt)
    expect(envelopeVertexXY(3, buckets, bucket, dt, values).value).toBe(2)
  })

  it('rolls over to the next channel after 2·buckets values', () => {
    const v = envelopeVertexXY(2 * buckets, buckets, bucket, dt, values)
    expect(v.chan).toBe(1)
    expect(v.x).toBeCloseTo(0.5 * bucket * dt)
    expect(v.value).toBe(-5)
  })
})

describe('spanForVisible', () => {
  /* Powers of two so a pan never rebuilds and a zoom rebuilds at most once per
     octave — the same reason the bucket grid is dyadic. */
  it('rounds UP to a power of two, so the drawn span always covers the view', () => {
    expect(spanForVisible(512, 32768)).toBe(512)
    expect(spanForVisible(513, 32768)).toBe(1024)
    expect(spanForVisible(300, 32768)).toBe(512)
  })

  it('never exceeds the page, and never drops below the floor', () => {
    expect(spanForVisible(1e9, 32768)).toBe(32768)
    expect(spanForVisible(3, 32768, 64)).toBe(64)
  })
})

/*
 * THE PLAN ANSWERS DETAIL, NOT WHICH ARRAY.
 *
 * It used to return `source: 'page' | 'stored'` — a choice between two buffers with
 * two origins and, once a scale could stride one of them, two RATES. That choice is
 * the MODE's now (spec §2): NAVIGATE draws the overview, ANALYSE draws the page.
 * What is left here is the question this function is actually good at — how much
 * detail fits on a pixel.
 */
describe('drawPlanFor', () => {
  const PX = 1000

  it('draws samples when fewer than two land on a pixel', () => {
    expect(drawPlanFor(1000, PX, 32768)).toMatchObject({ mode: 'samples' })
  })

  it('draws an envelope past the threshold, bucketed to the pixel', () => {
    // 32 000 samples over 1000 px = 32 a pixel → the power of two at or below it.
    expect(drawPlanFor(32_000, PX, 1_440_000)).toMatchObject({ mode: 'envelope', bucket: 32 })
  })

  /* The geometry window is bounded by the BUFFER, whatever the span asks for —
     otherwise the drawable reads past the end of the array it was given. */
  it('never asks for more buckets than the buffer holds', () => {
    const p = drawPlanFor(4096, PX, 4096)
    if (p.mode !== 'envelope') throw new Error('expected an envelope')
    expect(p.buckets).toBeLessThanOrEqual(Math.ceil(4096 / p.bucket))
  })

  /* NO `source` FIELD. Asserted explicitly: a leftover would be read by whichever
     consumer was not updated, and would name an array the mode did not choose. */
  it('says nothing about which array to read', () => {
    expect(drawPlanFor(32_000, PX, 1_440_000)).not.toHaveProperty('source')
  })
})

describe('envelopeVertexXY — the recording offset', () => {
  const buckets = 4, bucket = 8, dt = 0.01
  const values = [-1, 1, -2, 2, -3, 3, -4, 4]

  /* THE OFFSET IS IN SAMPLES, not buckets, because that is what the host knows: a
     page's `s0`. It must be a whole number of buckets or the grid would shift under
     the anchoring the whole design rests on — the caller guarantees that (a page
     length is a multiple of the bucket) and this simply divides. */
  it('places a bucket at its position in the RECORDING when given a sample offset', () => {
    const v = envelopeVertexXY(0, buckets, bucket, dt, values, 800)
    // sample 800 is bucket 100 of the recording, so the centre is at 100.5 buckets.
    expect(v.x).toBeCloseTo(100.5 * bucket * dt)
  })

  it('is unchanged when the offset is zero or absent', () => {
    expect(envelopeVertexXY(2, buckets, bucket, dt, values, 0).x)
      .toBeCloseTo(envelopeVertexXY(2, buckets, bucket, dt, values).x)
  })
})

/*
 * THE SCROLL SLOT — the arithmetic that produced the blank-plot flash.
 *
 * The window's position used to be computed by `attachTimeScroll`, in units chosen
 * from the plan it had just DECIDED, and written onto a drawable still bound to the
 * source it was last GIVEN — a host round trip and a GPU reduce behind. This is the
 * one formula both modes share now, tested here because `Line` needs a WebGPU device
 * and cannot be constructed in a unit test.
 */
describe('scrollSlotFor', () => {
  const PAGE = 3000, SPAN = 512

  it('centres the window on the playhead', () => {
    expect(scrollSlotFor(1000, 0, SPAN, PAGE)).toBe(1000 - SPAN / 2)
  })

  it('cannot begin before the buffer', () => {
    expect(scrollSlotFor(0, 0, SPAN, PAGE)).toBe(0)
  })

  it('cannot begin past the last full window', () => {
    expect(scrollSlotFor(3000, 0, SPAN, PAGE)).toBe(PAGE - SPAN)
  })

  /* A window wider than the buffer parks at 0 rather than going negative — the
     fallback case, where a bounded sample span meets a short page. */
  it('parks at zero when the window is wider than the buffer', () => {
    expect(scrollSlotFor(100, 0, 8192, 3000)).toBe(0)
  })

  /* The buffer's ORIGIN comes off, and this is the half the old two-branch code got
     right only per branch: a page's envelope is indexed from that page's start, the
     stored pyramid from the recording's. One centre, two buffers, two slots. */
  it('takes the buffer origin off an absolute centre', () => {
    expect(scrollSlotFor(33_500, 32_768, SPAN, PAGE)).toBe(33_500 - 32_768 - SPAN / 2)
  })

  /*
   * THE REGRESSION, stated as the identity that was violated: the SAME instant on
   * two sources must land on the same TIME, not on the same number.
   *
   * Page buckets and stored buckets are different units and different origins. The
   * old code wrote whichever one the plan named onto whichever source was bound, so
   * at every transition one was read as the other — 640 read as a sample index is
   * 2.1 s into a page instead of 175 s into a recording, which draws the traces
   * entirely off-screen and reads as a chart that has gone blank.
   */
  it('puts one instant at the same time on the page envelope and the stored pyramid', () => {
    const centre = 52_000, bucket = 64, span = 256
    const pageStart = 32_768
    const onPage = scrollSlotFor(centre, pageStart, span, 512, bucket)
    const onStored = scrollSlotFor(centre, 0, span, 22_500, bucket)
    /* Slot → absolute sample: `(slot + span/2)·bucket + origin`. Equal on both, and
       the raw slot numbers are NOT — which is the whole point. The spans are chosen
       so NEITHER side clamps; a clamped pair would agree trivially and prove nothing. */
    expect((onPage + span / 2) * bucket + pageStart)
      .toBe((onStored + span / 2) * bucket + 0)
    expect(onPage).not.toBe(onStored)
  })

  /* bucket = 1 IS sample mode — there is no second branch to keep in step. */
  it('degenerates to the sample formula at bucket 1', () => {
    expect(scrollSlotFor(1000, 0, SPAN, PAGE, 1)).toBe(scrollSlotFor(1000, 0, SPAN, PAGE))
  })
})

/*
 * A SOURCE CARRIES ITS OWN TIME BASE. NAVIGATE draws native samples and ANALYSE
 * draws an analysed page reduced by the scale's stride — 2400 Hz against 150 Hz
 * under theta. Both bind through `setSource`, so `sampleDt` cannot be fixed at
 * construction: a mode switch would otherwise draw the new buffer on the old rate's
 * axis, which is a plausible picture at 16× the wrong width.
 */
describe('envelopeColumnSeconds', () => {
  it('is the bucket in the SOURCE’s own seconds', () => {
    expect(envelopeColumnSeconds(32, 1 / 2400)).toBeCloseTo(32 / 2400, 9)
    expect(envelopeColumnSeconds(2, 1 / 150)).toBeCloseTo(2 / 150, 9)
  })

  /* Sample mode is bucket 1 — the same formula, as everywhere else here. */
  it('degenerates to one sample at bucket 1', () => {
    expect(envelopeColumnSeconds(1, 1 / 2400)).toBeCloseTo(1 / 2400, 9)
  })
})

/*
 * THE ENVELOPE'S EXTENT IS NOT THE SAMPLE BUFFER'S.
 *
 * In NAVIGATE the samples come from the resident page and the envelope from the
 * whole-recording overview. Bounding the envelope's geometry by the page's bucket
 * count drew 13.65 s of a 300 s view and left the rest blank — the overview masked
 * to exactly the span it exists to escape.
 */
describe('drawPlanFor — envelopeSamples', () => {
  const PX = 1545
  const PAGE = 32_768
  const RECORDING = 1_440_000
  const VISIBLE = 300 * 2400          // a 300 s view at 2400 Hz

  it('spans the ENVELOPE, not the sample buffer, when the two differ', () => {
    const p = drawPlanFor(VISIBLE, PX, PAGE, { envelopeSamples: RECORDING })
    if (p.mode !== 'envelope') throw new Error('expected an envelope')
    // The window must cover far more than one page's worth of buckets.
    expect(p.buckets * p.bucket).toBeGreaterThan(PAGE * 4)
  })

  /* The defect, stated as the number it produced: bounded by the page, the plan
     asked for exactly one page of columns however wide the view was. */
  it('is not capped at the sample buffer', () => {
    const capped = drawPlanFor(VISIBLE, PX, PAGE)
    const proper = drawPlanFor(VISIBLE, PX, PAGE, { envelopeSamples: RECORDING })
    if (capped.mode !== 'envelope' || proper.mode !== 'envelope') throw new Error('envelope')
    expect(capped.buckets * capped.bucket).toBe(PAGE)
    expect(proper.buckets).toBeGreaterThan(capped.buckets)
  })

  /* And it still cannot exceed the envelope it will read — a geometry wider than
     the buffer reads past the end of the array. */
  it('never asks for more buckets than the envelope holds', () => {
    const p = drawPlanFor(VISIBLE * 100, PX, PAGE, { envelopeSamples: RECORDING })
    if (p.mode !== 'envelope') throw new Error('expected an envelope')
    expect(p.buckets).toBeLessThanOrEqual(Math.ceil(RECORDING / p.bucket))
  })

  /* Omitted, it is the sample buffer's — right whenever one array serves both,
     which is ANALYSE. */
  it('defaults to the sample buffer', () => {
    expect(drawPlanFor(VISIBLE, PX, PAGE)).toEqual(drawPlanFor(VISIBLE, PX, PAGE, { envelopeSamples: PAGE }))
  })
})
