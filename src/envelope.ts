/**
 * envelope.ts — the arithmetic of drawing a signal as min/max per bucket.
 *
 * Pure and `three`-free on purpose: `Line` implements the vertex formula in TSL,
 * `attachTimeScroll` chooses the bucket size, and the app's reduce kernel produces
 * the buffer — three consumers that must agree exactly. `envelopeVertexXY` is the
 * CPU mirror of the shader, in the shape `fir.oracle.ts` established: the shader
 * cannot be unit-tested, so the formula it implements is tested here and the
 * shader is written to match it.
 *
 * BUCKETS ARE ANCHORED TO ABSOLUTE SAMPLE POSITIONS — bucket `b` at factor `B` is
 * always samples `[bB, (b+1)B)`, whoever is looking and wherever the camera is.
 * That is what makes panning free: the camera moves over an unchanged buffer, and
 * only crossing a factor rebuilds anything.
 */

/**
 * Samples per pixel below which an envelope is pointless.
 *
 * With fewer than two samples on a pixel there is nothing to summarise, and a
 * min/max pair would draw a vertical bar where the signal has no vertical extent —
 * inventing detail rather than removing it.
 */
export const ENVELOPE_MIN_SPP = 2

/**
 * The bucket size for a given samples-per-pixel: the largest power of two that is
 * no larger than it, or 1 meaning "draw the samples".
 *
 * ROUNDS DOWN, so a bucket never spans more than one pixel — rounding up would
 * merge two pixels' worth of signal into one bar and visibly lose extent at the
 * zoom where the switch happens, which is the one place a user is looking for a
 * change.
 */
export function bucketForSpp(spp: number, maxBucket = 4096): number {
  if (!Number.isFinite(spp) || spp < ENVELOPE_MIN_SPP) return 1
  const b = 2 ** Math.floor(Math.log2(spp))
  return Math.max(1, Math.min(maxBucket, b))
}

/** Buckets needed to cover `samples`, including a partial tail. */
export function bucketCount(samples: number, bucket: number): number {
  return Math.max(1, Math.ceil(samples / Math.max(1, bucket)))
}

/**
 * Seconds one drawn column spans — `bucket · sampleDt`, in the SOURCE's own rate.
 *
 * Trivial arithmetic with a name, because the mistake it prevents is not: a chart
 * that switches between a native buffer and an analysed one has two `sampleDt`s in
 * play, and multiplying a bucket by the wrong one draws a correct picture at the
 * wrong width. Naming the product puts the pairing in one place.
 */
export function envelopeColumnSeconds(bucket: number, sampleDt: number): number {
  return Math.max(1, bucket) * sampleDt
}

/**
 * Vertices in an envelope geometry: `2·buckets` values a channel, consecutive
 * values joined. min→max draws the vertical extent of a column, max→next-min
 * draws the link to the next one, so one polyline gives both.
 */
export function envelopeVertexCount(channels: number, buckets: number): number {
  return channels * Math.max(0, 2 * buckets - 1) * 2
}

/**
 * Where vertex `v` of an envelope sits — the CPU mirror of `Line`'s envelope
 * `positionNode`. `values` is `[channels × buckets × 2]`, min at even indices.
 *
 * Both values of a bucket share an x (the bucket's CENTRE), which is what makes
 * the pair render as a vertical bar rather than a sloped one.
 */
export function envelopeVertexXY(
  vertex: number,
  buckets: number,
  bucket: number,
  sampleDt: number,
  values: ArrayLike<number>,
  /** Absolute sample index of the buffer's first sample. A whole number of buckets
   *  by the caller's construction; x is the only thing it affects. */
  sampleOffset = 0,
): { chan: number; x: number; value: number } {
  const per = 2 * buckets
  const chan = Math.floor(vertex / per)
  const j = vertex - chan * per
  const b = Math.floor(j / 2) + sampleOffset / bucket
  return {
    chan,
    x: (b + 0.5) * bucket * sampleDt,
    value: values[chan * per + j],
  }
}

/**
 * The first DRAWN slot for a view centred on `centreSample` — the whole of what
 * `Line.setViewCentre` computes, in one pure function so it can be tested.
 *
 * ONE FORMULA FOR BOTH MODES, and that is the point rather than a tidy-up. It used
 * to be two branches in `attachTimeScroll`, selected by the plan's `mode` and
 * `source` — which meant the attacher had to know which source was BOUND, and it
 * never did: the plan is what it has just decided, and the drawable is still on
 * whatever it was last given. A bucket index read as a sample index draws the
 * traces hundreds of columns from the playhead. With `bucket` at 1 a slot IS a
 * sample, so the sample case is the envelope case and there is nothing to select
 * between.
 *
 * `sampleOffset` is where the buffer starts in the recording — 0 for a
 * whole-recording summary, the page's start for a page — and comes off first,
 * because the centre is absolute and slots are buffer-relative.
 *
 * CLAMPED at both ends: a window may not begin before the buffer, nor past the
 * last full window in it.
 */
export function scrollSlotFor(
  centreSample: number,
  sampleOffset: number,
  /** Slots the GEOMETRY draws. */
  span: number,
  /** Slots the BUFFER holds. */
  total: number,
  /** Samples a slot spans — the envelope's bucket, or 1 in sample mode. */
  bucket = 1,
): number {
  const local = (centreSample - sampleOffset) / Math.max(1, bucket)
  const first = Math.round(local - span / 2)
  return Math.max(0, Math.min(first, Math.max(0, total - span)))
}

/** What a `Line` should be drawing right now — see `drawPlanFor`. */
export type LineDrawPlan =
  | { mode: 'samples'; span: number }
  /** `buckets` is the geometry WINDOW; the buffer covers more so panning is free. */
  | { mode: 'envelope'; bucket: number; buckets: number }

/**
 * The geometry span, in samples, for a view showing `visibleSamples`.
 *
 * ROUNDS UP to a power of two so the drawn window always covers the view, and so a
 * pan never rebuilds and a zoom rebuilds at most once per octave. The same dyadic
 * reasoning as the bucket grid, in the other direction.
 */
export function spanForVisible(visibleSamples: number, maxSpan: number, minSpan = 64): number {
  if (!Number.isFinite(visibleSamples) || visibleSamples <= 0) return Math.min(minSpan, maxSpan)
  const s = 2 ** Math.ceil(Math.log2(visibleSamples))
  return Math.max(Math.min(minSpan, maxSpan), Math.min(maxSpan, s))
}

/**
 * How much detail fits on a pixel — and NOTHING about which array to read.
 *
 * It used to answer `source: 'page' | 'stored'` as well, which made it the arbiter
 * of a choice between two buffers with different origins and, once a scale could
 * stride one of them, different RATES. That choice belongs to the chart's MODE
 * (spec §2).
 *
 * **THE TWO BRANCHES HAVE DIFFERENT BUFFERS, so they take different extents.**
 * `bufferSamples` bounds the SAMPLE window; `envelopeSamples` bounds the envelope's
 * geometry. In NAVIGATE the samples come from the resident page and the envelope
 * from the whole-recording overview, so one number cannot bound both — passing the
 * page's for both drew 13.65 s of a 300 s view and left the rest blank, an overview
 * masked to exactly the span an overview exists to escape. `envelopeSamples`
 * defaults to `bufferSamples`, which is right whenever one array serves both.
 *
 * BOTH BRANCHES ARE BOUNDED BY THE PIXEL WIDTH, which is the point: neither can hand
 * the GPU more work because a buffer happens to be long.
 */
export function drawPlanFor(
  visibleSamples: number,
  plotPx: number,
  bufferSamples: number,
  opts: { maxBucket?: number; envelopeSamples?: number } = {},
): LineDrawPlan {
  const { maxBucket = 4096, envelopeSamples = bufferSamples } = opts
  const spp = plotPx > 0 ? visibleSamples / plotPx : 0
  if (!Number.isFinite(spp) || spp < ENVELOPE_MIN_SPP) {
    return { mode: 'samples', span: spanForVisible(visibleSamples, bufferSamples) }
  }
  const bucket = bucketForSpp(spp, maxBucket)
  return {
    mode: 'envelope',
    bucket,
    /* AGAINST THE ENVELOPE'S OWN EXTENT, which is not the sample buffer's.
       They differ in NAVIGATE and the difference is the whole recording: samples
       come from the resident PAGE, the envelope from the stored overview. Capping
       the geometry window at the page's bucket count drew 13.65 s of a 300 s view
       and left the rest blank — an overview masked to exactly the span an overview
       exists to escape. */
    buckets: spanForVisible(visibleSamples / bucket, bucketCount(envelopeSamples, bucket)),
  }
}
