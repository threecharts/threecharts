/**
 * lineIndex.ts — which BUFFER slot a `Line` vertex reads.
 *
 * Pure and `three`-free on purpose, in the shape `envelope.ts` established: `Line`
 * implements this arithmetic in TSL (`Line._decode`), a shader cannot be unit-tested,
 * so the formula it implements is tested here and the shader is written to match it.
 *
 * There are FOUR modes and they differ in more than an offset — 3D curves read whole
 * points, an envelope reads a min/max pair per bucket, a windowed line reads at a live
 * scroll, and a frame-indexed line reads at the clock. Each applies `rowMap` and
 * `scroll` differently. That is why `Line` decodes in ONE place and both its position
 * node and its colour node call it: a second copy does not fail loudly, it renders a
 * perfectly plausible chart whose colours are offset by the scroll, or taken from the
 * unmapped channel.
 */

export type LineIndexMode =
  /** Frame-indexed (`totalSamples` absent) or WINDOWED over a continuous recording. */
  | { kind: 'samples'; totalSamples?: number }
  /** `[channels × totalBuckets × 2]`, min at even indices. `slots` is `2·buckets`. */
  | { kind: 'envelope'; totalBuckets: number }
  /** `[frames × channels × samples]` of whole points; `rowMap` and `scroll` do not apply. */
  | { kind: 'curve3d' }

export interface LineIndexSpec {
  /** Channels DRAWN (the geometry's), which is also the frame stride's row count. */
  channels: number
  /** Slots per channel in the GEOMETRY — `samples`, or `2·buckets` in envelope mode. */
  slots: number
  mode: LineIndexMode
  /** Drawn channel `k` reads buffer row `rowMap[k]`. Omit → drawn `k` is row `k`. */
  rowMap?: ArrayLike<number> | null
  /** First DRAWN sample (samples mode) or bucket (envelope mode). Floored, as the
   *  shader floors its live uniform. Default 0. */
  scroll?: number
  /** The clock frame, for the frame-indexed and 3D modes. Default 0. */
  timepoint?: number
}

/**
 * The drawn channel a vertex belongs to and the buffer slot it reads.
 *
 * `chan` is the DRAWN index — baselines and per-row colour stay on it, so a mapped
 * subset stacks in the order it was given — while `flat` has passed through the row
 * map. Keeping the two separate is the whole point of a montage being a selection
 * over one buffer instead of a filtered copy of it.
 */
export function lineVertexIndex(vertex: number, spec: LineIndexSpec): { chan: number; flat: number } {
  const { channels, slots, mode } = spec
  const scroll = Math.floor(spec.scroll ?? 0)
  const tp = spec.timepoint ?? 0
  const rowOf = (chan: number): number => (spec.rowMap ? spec.rowMap[chan] : chan)

  if (mode.kind === 'curve3d') {
    // Whole points, read at the clock frame. No row map: a 3D curve's buffer IS its
    // geometry, so there is no montage to select through.
    return { chan: Math.floor(vertex / slots), flat: tp * channels * slots + vertex }
  }

  if (mode.kind === 'envelope') {
    const chan = Math.floor(vertex / slots)
    const j = vertex - chan * slots
    const b = Math.floor(j / 2)              // local bucket
    const parity = j - b * 2                 // 0 = min, 1 = max
    const absB = scroll + b
    return { chan, flat: rowOf(chan) * 2 * mode.totalBuckets + absB * 2 + parity }
  }

  const chan = Math.floor(vertex / slots)
  const samp = vertex - chan * slots
  if (mode.totalSamples != null) {
    // CONTINUOUS recording: a window at `scroll` into a `[channels × totalSamples]` page.
    return { chan, flat: rowOf(chan) * mode.totalSamples + scroll + samp }
  }
  // FRAME-INDEXED: `[frames × channels × slots]` at the clock frame.
  return { chan, flat: tp * channels * slots + rowOf(chan) * slots + samp }
}
