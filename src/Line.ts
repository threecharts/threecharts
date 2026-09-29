import { LineSegments, LineBasicNodeMaterial, BufferGeometry, BufferAttribute, Color } from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray, Fn, attribute, uniform, varying, clamp, vec3, vec4, float, int, max } from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds, Limits } from './limits'
import { type StorageNode, resolveField, type FieldSource, type ResolvedField , type Timepoint } from './field/source'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { asReadOnly } from './storage-access'
import type { LegendEntry } from './AxesLegend'
import { categoricalColor, type CategoricalScheme } from './categorical'
import { scrollSlotFor, envelopeColumnSeconds } from './envelope'

export interface LineOptions {
  /** X-axis range the `samples` map across (sample s → x). Default `[0, samples-1]`. */
  xExtent?: Limits
  /** Y (value) range, for the axes' auto-limits. Default `[0, 1]`. */
  yExtent?: Limits
  /** z-extent for 3D curves (`dims: 3`), for the auto-cube. Default [-1, 1]. */
  zExtent?: Limits
  /** 2 (default) → a `[frames × channels × samples]` SCALAR (y) field, x from the sample
   *  grid, on the z=0 plane. 3 → a `[frames × channels × samples] vec3` field: each vertex
   *  is a full 3D point (parametric 3D curves). 3D ignores gain/spacing/scroll/windowed. */
  dims?: 2 | 3
  /** A single solid color for every line. Omit → per-channel color from the axes colormap. */
  color?: string
  opacity?: number
  /** Per-channel baseline spacing (channel c sits at `c*channelSpacing`). Default 0
   *  → all channels overlaid; >0 → stacked traces (multi-channel timeseries). */
  channelSpacing?: number
  /** Vertical GAIN applied to the signal DEVIATION only (baselines stay put). A live
   *  uniform — set `line.gain.value` to stretch every trace instantly. Default 1. */
  gain?: number
  /** Which slice of the stacked buffer to read. Defaults to the Figure clock's
   *  shared `frameUniform`, so lines animate in lock-step. Pass a NUMBER for a
   *  static line (a spectrum, a template — a 1-slice buffer that must not follow
   *  the clock), or your own uniform to drive it yourself. */
  timepoint?: Timepoint
  /** WINDOWED / SCROLL mode: set this to the per-channel length of a CONTINUOUS
   *  recording (`buffer` is `[channels × totalSamples]`). Then `samples` is the visible
   *  WINDOW width, and the drawable reads a window starting at `scroll` (a live sample
   *  offset), with `x` in absolute time (`sample*sampleDt`). Omit → frame-indexed. */
  totalSamples?: number
  /** Seconds per sample (windowed mode) → x-axis is time. Default 1 (x = samples). */
  sampleDt?: number
  /** Initial scroll offset in samples (windowed mode). Live via `line.scroll.value`. Default 0. */
  scroll?: number
  /**
   * Absolute sample index of the buffer's FIRST sample — where this buffer sits in
   * the recording. Default 0.
   *
   * x ONLY. The buffer is still indexed from zero; this shifts where the drawing
   * lands on the time axis. It exists because a chart may draw several buffers that
   * do not share an origin — a page of one recording and a whole-recording summary,
   * say, or a native-rate page under a decimated clock — and page-relative x cannot
   * place both on one axis.
   */
  sampleOffset?: number
  /**
   * ENVELOPE mode: `buffer` is `[channels × buckets × 2]` — min at even indices,
   * max at odd — and `samples` is ignored. Bucket `b` covers `bucket` samples
   * starting at `b·bucket`, and both of its values are drawn at the bucket's
   * CENTRE in x, so the pair renders as the column's vertical extent.
   *
   * This is what makes a wide zoom cheap without changing what it shows: past
   * ~2 samples a pixel, every sample in a column already draws into the same
   * column and their union IS the min–max extent. See `envelope.ts`, whose
   * `envelopeVertexXY` is the tested CPU mirror of the formula below.
   */
  envelope?: {
    /** Buckets in the GEOMETRY — the window drawn. */
    buckets: number
    /** Samples a bucket spans. */
    bucket: number
    /** Buckets in the BUFFER — the whole page. `scroll` is the first drawn bucket,
     *  the exact analogue of `totalSamples` + `scroll` in sample mode. */
    totalBuckets: number
  }
  /**
   * Draw a SUBSET (or reordering) of the buffer's channels: a `[channels]` GPU
   * buffer of row indices, so drawn channel `k` reads buffer row `rowMap[k]`.
   * Baselines/colors still follow the drawn index `k`, so the traces stack in the
   * order given. Omit → drawn channel `k` is buffer row `k`.
   *
   * This is what lets a montage (every Nth channel, one lobe, a hand-picked set)
   * be a selection over the recording's own buffer instead of a filtered copy of
   * it — the buffer stays whatever the reader uploaded.
   */
  rowMap?: unknown
  /**
   * Per-row COLOR position: a `[channels]` GPU buffer of `t` in [0,1], used as the
   * colormap lookup for drawn channel `k` instead of the default `k/(channels-1)`
   * ramp. The color analogue of `rowMap` — it lets traces be colored by something
   * they BELONG to (a group, a category) rather than by where they happen to sit
   * in the draw order.
   *
   * With a CATEGORICAL colormap (`tab10`, `Set2`, `glasbey`) sample the bin centre:
   * `t = (group + 0.5) / groupCount`. Ignored when `color` is set (solid wins).
   */
  colorIndex?: unknown
  /** Multiply the sampled colormap RGB (see `setColorGain`). Default 1. */
  colorGain?: number
  /**
   * A SECOND CHANNEL of information, per VERTEX: a float buffer indexed EXACTLY like
   * the y buffer, colour-mapped through the axes colormap.
   *
   * The y buffer shapes the line's GEOMETRY; this one colours it. The two are
   * independent quantities — a signal drawn as a line while its PHASE runs through a
   * cyclic colormap, or its instantaneous amplitude through a sequential one. Colour
   * is never derived from what is plotted; if you want the trace coloured by its own
   * value, hand the same buffer to both.
   *
   * Shape follows the mode, slot for slot: `[frames × channels × samples]`
   * frame-indexed, `[channels × totalSamples]` windowed, `[channels × buckets × 2]`
   * in envelope mode (so a bucket's min and max may carry different colours).
   *
   * Omit → per-ROW colour (`colorIndex`, else the drawn-index ramp). A solid `color`
   * outranks both. `colorGain` does NOT apply: it is the theme lever for a
   * categorical palette, and darkening a scientific colormap misstates its scale.
   */
  values?: unknown
  /** Range `values` span, for the colormap normalize (+ the legend). Default [0,1]. */
  clim?: Limits
  /**
   * Read `values` as LABEL IDS through a categorical scheme instead of as quantities
   * through a ramp — segment labelling, the atlas idea on a 1D geometry: which band a
   * stretch of spectrum falls in, which state a trace is in, which montage group owns
   * a channel.
   *
   * `clim` does not apply and is ignored; a label addresses its texel directly.
   * The scheme's ALPHA is respected, so label 0 (or any gap) leaves that stretch of
   * line INVISIBLE rather than black — which is what "unlabelled here" should look
   * like. Requires `values`; without it there is nothing to label.
   */
  categorical?: CategoricalScheme
  /**
   * Plot `log10(value)` instead of `value` — for a `log`-scaled y axis, whose
   * limits are in the same exponent space. Applied in the SHADER, so the buffer
   * you upload stays linear (nothing is re-uploaded to change scale). Values ≤ 0
   * have no logarithm and are floored to `logFloor`.
   */
  logY?: boolean
  /**
   * Smallest value a `logY` line will show — anything below is drawn AT it.
   *
   * Defaults to a true degeneracy guard, not a scale. It used to default to `1e-12`,
   * which is a value in the DATA's units and therefore a claim this drawable is in no
   * position to make: a cortical eigenspectrum's power sits near 1e-25, so every point
   * clamped to 1e-12 and the whole trace collapsed onto one horizontal line — visible
   * as a flat line pinned to the top of the plot while the axis happened to end there,
   * and as NOTHING AT ALL once the axis was corrected to bracket the real data and the
   * clamped line fell outside it.
   *
   * Pass the axis' own lower limit when you have one: below the axis there is nothing
   * to represent, and clamping there keeps the trace continuous instead of clipping it.
   */
  logFloor?: number
}

/** What a `Line` is currently reading — see `Line.setSource`. */
export type LineSource =
  | {
      kind: 'samples'; buffer: FieldSource; samples: number; sampleOffset?: number
      /** Seconds per sample of THIS buffer. Omit to keep the current one. */
      sampleDt?: number
      /**
       * THIS buffer's per-channel length — the stride between its channel ROWS, not
       * the visible window. Omit to keep the current one.
       *
       * Required whenever a swap changes the buffer's WIDTH, and the failure it
       * prevents is silent: `flat = row·totalSamples + abs`, so a stride left behind
       * by the previous buffer draws row `k` at `k·oldStride` inside rows that are
       * `k·newStride` apart. Row 0 stays correct and every other trace becomes a
       * different channel's data, shifted in time — a plausible picture of the wrong
       * channels. (See root CLAUDE.md: never use the owned length as a row stride.)
       */
      totalSamples?: number
    }
  | {
      kind: 'envelope'; buffer: FieldSource; buckets: number; bucket: number
      totalBuckets: number; sampleOffset?: number
      /** Seconds per sample of THIS buffer. Omit to keep the current one. */
      sampleDt?: number
      /** The sample-mode row stride, retained across an envelope bind so a swap back
       *  does not need it again. The ENVELOPE's own stride is `2·totalBuckets` above
       *  — that is the number this mode reads. */
      totalSamples?: number
    }

/**
 * Build a `rowMap` / `colorIndex` buffer from plain numbers.
 *
 * Exported so a host can select rows without importing `three` — `@nxr/cortical-flow`
 * composes this engine but has no business reaching into TSL to make a buffer of
 * three integers, and `rowMap`'s type is deliberately opaque (`unknown`) at the
 * option site.
 */
export function rowIndexBuffer(rows: ArrayLike<number>): unknown {
  return asReadOnly((attributeArray as (d: unknown, t: string) => unknown)(Float32Array.from(rows), 'float'))
}

/**
 * A `[channels]` COLOUR-position buffer for `LineOptions.colorIndex` — `t` in [0,1] per
 * drawn channel, looked up in the axes colormap.
 *
 * Identical in shape to `rowIndexBuffer` and deliberately not the same function: one
 * carries buffer ROW indices and the other colormap POSITIONS, and a call site that
 * builds colours out of something named `rowIndexBuffer` reads like a bug every time
 * anyone finds it.
 */
export function colorIndexBuffer(t: ArrayLike<number>): StorageNode {
  return asReadOnly((attributeArray as (d: unknown, ty: string) => StorageNode)(Float32Array.from(t), 'float'))
}

/** One `LineSegments` batching `channels` polylines: for each channel, `samples-1`
 *  segments = pairs of consecutive-sample vertices, each tagged with its flat
 *  `channel*samples + sample` index. The positionNode reads the buffer at that index. */
function buildGeometry(channels: number, samples: number): BufferGeometry {
  const segs = Math.max(0, samples - 1)
  const n = channels * segs * 2
  const aIdx = new Float32Array(n)
  let k = 0
  for (let c = 0; c < channels; c++) {
    const base = c * samples
    for (let s = 0; s < segs; s++) { aIdx[k++] = base + s; aIdx[k++] = base + s + 1 }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))  // overridden by positionNode
  g.setAttribute('aIdx', new BufferAttribute(aIdx, 1))
  g.setDrawRange(0, n)
  return g
}

/**
 * Line — a batch of polylines drawn from a `[frames × channels × samples]` scalar
 * (y) field in an EXTERNAL GPU storage buffer (arrangement 1). One `LineSegments`
 * for all channels: the vertex `positionNode` decodes `(channel, sample)` from a
 * per-vertex index, maps the sample to `x` on a regular grid, and reads `y` from the
 * buffer at `timepoint*channels*samples + channel*samples + sample`. `timepoint` is a
 * live uniform → advancing it re-renders the next slice for every line with ZERO
 * re-upload. Plain 1px (WebGPU ignores linewidth), so it's clipped by the axes'
 * ClippingGroup + camera-panned exactly like Image. A static line = a 1-slice buffer.
 */
export class Line extends Drawable {
  private readonly _material: LineBasicNodeMaterial
  private readonly _mesh: LineSegments
  private _field: ResolvedField
  private readonly _opts: LineOptions
  private _channels: number
  /** Slots per channel in the GEOMETRY: `samples` normally, `2·buckets` in
   *  envelope mode. Mutable because `setSource` swaps between the two. */
  private _samples: number
  private readonly _xExtent: Limits
  private readonly _yExtent: Limits
  private readonly _zExtent: Limits | null
  private _color: string | null
  private _rowMap: unknown | null
  /** Null in sample mode. */
  private _envelope: { buckets: number; bucket: number; totalBuckets: number } | null
  /** Where this buffer starts in the recording. x only — see `LineOptions`. */
  private _sampleOffset: number
  /** The drawn buffer's seconds-per-sample. Mutable because `setSource` may swap a
   *  buffer at a different rate — see `LineSource.sampleDt`. */
  private _sampleDt: number
  /**
   * The drawn buffer's per-channel length — its ROW STRIDE — or null when the line is
   * frame-indexed rather than windowed.
   *
   * Mutable for the same reason `_sampleDt` is, and it was `_opts.totalSamples` (fixed
   * at construction) until a host bound a buffer of a different width: see
   * `LineSource.totalSamples` for what that draws.
   */
  private _totalSamples: number | null
  private _colorIndex: unknown | null
  private _colorGain = 1
  /** The per-vertex VALUE channel, or null → per-row colour. */
  private _values: unknown | null
  /** Read `_values` as labels through this scheme, or null → a continuous ramp. */
  private _categorical: CategoricalScheme | null
  private readonly _opacity: number
  private _lastColormap = ''
  /** Live vertical-gain uniform — set `.value` to stretch the traces (zero re-upload). */
  readonly gain: any
  /**
   * Live scroll uniform — the first DRAWN slot: a buffer sample index in sample
   * mode, a bucket index in envelope mode.
   *
   * **Prefer `setViewCentre`.** Writing this directly means writing it in units
   * that depend on which source is currently BOUND, and a host that tracks the
   * source itself is tracking it one async round trip behind — see
   * `setViewCentre` for what that cost.
   */
  readonly scroll: any
  /**
   * The view's centre as an ABSOLUTE sample index, or null while no host has set
   * one. Retained so a source swap can re-derive `scroll` in the new units.
   */
  private _viewCentre: number | null = null
  /** Live per-channel spacing uniform — `0` = butterfly (all overlaid), `>0` = stacked
   *  columns. Set `.value` (or lerp it) to flip/animate between the two layouts. */
  readonly spacing: any

  /** The timepoint node — a fixed uniform, the caller's, or the figure clock's. */
  private readonly _tp: any

  constructor(axes: Axes, values: FieldSource, channels: number, samples: number, opts: LineOptions = {}) {
    const material = new LineBasicNodeMaterial()
    material.depthTest = false; material.depthWrite = false
    // In envelope mode the geometry holds 2 values a bucket, not `samples` of them.
    const nSlots = opts.envelope ? 2 * opts.envelope.buckets : samples
    const mesh = new LineSegments(buildGeometry(channels, nSlots), material)
    mesh.frustumCulled = false
    super(axes, mesh)
    this._material = material; this._mesh = mesh
    this._field = resolveField(values, 'float'); this._opts = opts
    const dims = opts.dims ?? 2
    this._channels = channels; this._samples = nSlots
    this._xExtent = opts.xExtent ?? [0, Math.max(1, samples - 1)]
    this._yExtent = opts.yExtent ?? [0, 1]
    this._zExtent = dims === 3 ? (opts.zExtent ?? [-1, 1]) : null
    this._color = opts.color ?? null
    this._rowMap = opts.rowMap ?? null
    this._envelope = opts.envelope ?? null
    this._sampleOffset = opts.sampleOffset ?? 0
    this._sampleDt = opts.sampleDt ?? 1
    this._totalSamples = opts.totalSamples ?? null
    this._colorIndex = opts.colorIndex ?? null
    this._colorGain = opts.colorGain ?? 1
    this._values = opts.values ?? null
    this._clim = opts.clim ?? [0, 1]
    this._categorical = opts.categorical ?? null
    this._opacity = opts.opacity ?? 1

    this.gain = (uniform as any)(opts.gain ?? 1)
    this.scroll = (uniform as any)(opts.scroll ?? 0)
    this.spacing = (uniform as any)(opts.channelSpacing ?? 0)
    this._tp = typeof opts.timepoint === 'number'
      ? (uniform as any)(opts.timepoint)          // static: a fixed slice, off the clock
      : (opts.timepoint ?? axes.figure.clock.frameUniform)

    material.transparent = this._opacity < 1
    this._buildPosition()
    this.invalidate()
  }

  /**
   * Decode a vertex's `aIdx` into the three facts every node needs: which DRAWN
   * channel it belongs to, which BUFFER slot it reads, and where it sits in x.
   *
   * ONE definition, shared by `positionNode` and the colour node. The arithmetic
   * differs four ways — 3D, envelope, windowed, frame-indexed — and each applies
   * `rowMap` and `scroll` differently, so a second copy does not fail loudly: it
   * renders a perfectly plausible chart whose colours are offset by the scroll, or
   * taken from the unmapped channel. The same class of defect as reading a page's
   * owned length as its row stride.
   *
   * `lineVertexIndex` in `lineIndex.ts` is the TESTED CPU mirror of the `chan`/`flat`
   * half of this — a shader cannot be unit-tested, so the formula is tested there and
   * this is written to match it. Keep the two in step.
   *
   * `x` is null in 3D, where the position is read wholesale from the buffer.
   */
  private _decode(idx: any): { chan: any; flat: any; x: any } {
    const opts = this._opts
    const chans = this._channels, samps = this._samples
    const { scroll, _tp: tp } = this

    // 3D outranks envelope, as it always has: a 3D curve ignores gain / spacing /
    // scroll / windowing, and its buffer holds whole points rather than y values.
    if ((opts.dims ?? 2) === 3) {
      const chan = idx.div(samps).floor()
      return { chan, flat: int(tp).mul(chans * samps).add(int(idx)), x: null }
    }

    const env = this._envelope
    if (env) {
      const per = 2 * env.buckets                 // slots in the GEOMETRY
      const bufPer = 2 * env.totalBuckets         // slots in the BUFFER (whole page)
      const colDt = envelopeColumnSeconds(env.bucket, this._sampleDt)
      const rowMapE: any = this._rowMap ? asReadOnly(this._rowMap) : null
      const chan = idx.div(per).floor()
      const j = idx.sub(chan.mul(per))            // 0 … per-1
      const b = j.div(2).floor()                  // local bucket
      const parity = j.sub(b.mul(2))              // 0 = min, 1 = max
      // `scroll` is the first DRAWN bucket — the same window mechanism sample mode
      // uses, in bucket units, so panning is a uniform write and never a rebuild.
      const absB = scroll.floor().add(b)
      /* Both values of a bucket share the bucket's CENTRE, so the pair is vertical.
         The RECORDING offset lands here and nowhere else: `flat` stays on the
         unshifted index, because the buffer is still indexed from zero. */
      const b0 = this._sampleOffset / env.bucket
      const x = absB.add(float(0.5 + b0)).mul(colDt)
      const row = rowMapE ? rowMapE.element(int(chan)) : chan
      return { chan, flat: int(row.mul(bufPer).add(absB.mul(2)).add(parity)), x }
    }

    const windowed = this._totalSamples != null
    const total = this._totalSamples ?? samps
    const dt = this._sampleDt
    const [x0, x1] = this._xExtent
    const rowMap: any = this._rowMap ? asReadOnly(this._rowMap) : null
    const chan = idx.div(samps).floor()
    const samp = idx.sub(chan.mul(samps))                      // local sample 0..samps-1
    // Which BUFFER row the drawn channel reads. The baseline stays on the drawn
    // index, so a mapped subset stacks in the order it was given.
    const row = rowMap ? rowMap.element(int(chan)) : chan
    if (windowed) {
      // CONTINUOUS recording: read a window at `scroll`, x = absolute time.
      const abs = scroll.floor().add(samp)                     // buffer sample index
      // x is in RECORDING time; `flat` stays on the buffer index.
      const x = abs.add(float(this._sampleOffset)).mul(dt)
      return { chan, flat: int(row.mul(total).add(int(abs))), x }
    }
    // FRAME-INDEXED: read frame `tp`, x = sample mapped to xExtent.
    const x = float(x0).add(samp.div(Math.max(1, samps - 1)).mul(x1 - x0))
    return { chan, flat: int(tp).mul(chans * samps).add(int(row.mul(samps).add(samp))), x }
  }

  /**
   * (Re)build the vertex `positionNode` from the current shape, row map and source
   * mode. Split out of the constructor so `setRowMap` can swap the drawn channels
   * without losing the live gain / scroll / spacing uniforms the host already holds.
   *
   * The index arithmetic lives in `_decode`; this method owns only what turns a
   * decoded vertex into a POSITION — the log transform, the gain and the baseline.
   */
  private _buildPosition(): void {
    const opts = this._opts
    const buf: any = this._field.node
    const { gain, spacing } = this

    if ((opts.dims ?? 2) === 3) {
      // 3D CURVES: each vertex is a full vec3 read from `[frames × channels × samples]`
      // at the shared clock frame. 1px segments read from any orbit angle — no billboard.
      this._material.positionNode = (Fn as any)(() => {
        const p: any = buf.element(this._decode(attribute('aIdx')).flat)   // vec3 point
        return vec3(p.x, p.y, p.z)
      })()
      this._material.needsUpdate = true
      return
    }

    const logY = opts.logY === true
    // Small enough that it can only ever catch a zero — `log10(0)` is -Infinity, and
    // that is the single thing this guard exists to prevent.
    const logFloor = opts.logFloor ?? 1e-300
    /** The plotted y for a raw buffer value. */
    const plotted = (v: any): any => (logY ? max(v, float(logFloor)).log().div(Math.LN10) : v)

    /* In envelope mode the CPU mirror of the x/index formula is `envelopeVertexXY` in
       `envelope.ts`, and it is TESTED — a shader cannot be. Keep the two in step. */
    this._material.positionNode = (Fn as any)(() => {
      const { chan, flat, x } = this._decode(attribute('aIdx'))
      const signal = plotted(buf.element(flat))
      const y = chan.mul(spacing).add(gain.mul(signal))
      return vec3(x, y, float(0))
    })()
    this._material.needsUpdate = true
  }

  /** Channels currently drawn (changes with `setRowMap`). */
  get channels(): number { return this._channels }

  /** Seconds per sample of the buffer currently bound. */
  get sampleDt(): number { return this._sampleDt }

  /**
   * Swap the EXTERNAL data buffer this line reads, keeping the same
   * `channels × samples` shape — the parameter-drag case: a filter response is
   * recomputed on the CPU and uploaded to a fresh GPU buffer every tick (the caller
   * owns disposing the old one), but its shape never changes, only the values.
   * Rebuilds only the `positionNode` (`_buildPosition`, the same call `setRowMap`
   * makes), never the geometry — gain / scroll / spacing survive untouched.
   *
   * Exists so a host can push new data into an already-built Figure instead of
   * disposing and reconstructing it per tick — see `ModeGainPanel`'s two-effect
   * split (structural vs data) for the caller.
   */
  setBuffer(values: FieldSource): void {
    this._field.dispose()
    this._field = resolveField(values, 'float')
    this._buildPosition()
    this.invalidate()
  }

  /**
   * Rewrite the samples in place — a buffer write, not a rebuild.
   *
   * Only when this line OWNS its values (a `Float32Array` was passed). A caller who
   * handed over a GPU node cannot be handed write access to it.
   */
  setData(values: Float32Array): void {
    this._field.set(values)
    this.invalidate()
  }

  /** Whether the samples can be rewritten with `setData`. */
  get ownsData(): boolean { return this._field.owned }

  /**
   * Centre the drawn window on an ABSOLUTE sample index — the playhead, in the
   * recording's own numbering.
   *
   * THIS EXISTS BECAUSE `scroll`'s UNITS DEPEND ON THE BOUND SOURCE, and the host
   * cannot know which source is bound. A host writing `scroll` writes it from the
   * plan it has just DECIDED, while the drawable is still on the source it was last
   * GIVEN — and between those two sit a React commit and a GPU reduce. In that
   * window a bucket index is read as a sample index (or the reverse), the geometry
   * is drawn hundreds of buckets from the playhead, and the plot goes blank or
   * jumps sideways. That is not a degraded picture while a level loads; it is a
   * wrong one, and it happened at EVERY level transition — each zoom octave, each
   * page↔pyramid crossing, each page turn.
   *
   * So the conversion moves to the only object that knows what it is drawing. The
   * host says WHERE, in units that never change; this decides WHICH SLOT, and
   * `setSource` re-derives it the instant the source swaps. A transition now
   * degrades to the coarser or finer picture of the same instant, which is what the
   * fallback was always documented to do.
   *
   * `sampleOffset` comes off here rather than at the call site for the same reason:
   * it too changes with the source (a page's envelope is indexed from that page's
   * start, the stored pyramid from the recording's).
   */
  setViewCentre(absoluteSample: number): void {
    this._viewCentre = absoluteSample
    this._applyScroll()
  }

  /**
   * `scroll` for the retained centre, in the CURRENT source's units.
   *
   * The arithmetic is `scrollSlotFor` in `envelope.ts` — pure and TESTED, in the
   * shape `envelopeVertexXY` established, because this class needs a WebGPU device
   * to construct and so cannot be unit-tested itself.
   */
  private _applyScroll(): void {
    const centre = this._viewCentre
    if (centre == null) return
    const env = this._envelope
    this.scroll.value = env
      ? scrollSlotFor(centre, this._sampleOffset, env.buckets, env.totalBuckets, env.bucket)
      : scrollSlotFor(centre, this._sampleOffset, this._samples,
        this._totalSamples ?? this._samples)
  }

  /**
   * Swap between drawing SAMPLES and drawing an ENVELOPE, in place.
   *
   * One method for both directions rather than a pair, because the two are the
   * same decision and a host holding two setters can leave them disagreeing — an
   * envelope buffer read by the sample formula is not an error, it is a plausible
   * wrong picture. The geometry is rebuilt only when the slot count actually
   * changes; `gain`, `spacing` and the row map all survive, so a zoom that crosses
   * a bucket boundary does not reset the host's tool state.
   *
   * `scroll` is the one thing that must NOT survive: its units are this source's.
   * It is re-derived from the retained view centre instead, which is the same
   * window in the new units — see `setViewCentre` for the artefact that came of
   * carrying the number across.
   */
  setSource(src: LineSource): void {
    const slots = src.kind === 'envelope' ? 2 * src.buckets : src.samples
    this._field.dispose()
    this._field = resolveField(src.buffer, 'float')
    this._sampleOffset = src.sampleOffset ?? 0
    if (src.sampleDt != null) this._sampleDt = src.sampleDt
    /* BEFORE `_applyScroll` and `_buildPosition` below, both of which read it — the
       scroll clamp and the row-index formula are exactly the two things a stale
       stride corrupts. */
    if (src.totalSamples != null) this._totalSamples = src.totalSamples
    this._envelope = src.kind === 'envelope'
      ? { buckets: src.buckets, bucket: src.bucket, totalBuckets: src.totalBuckets }
      : null
    // The colour node captures the slot count and the source mode through `_decode`,
    // so a source swap invalidates it exactly as it invalidates the position node.
    // (Before the value channel existed this was already wrong for per-row colour:
    // `chan = idx / samps` kept the OLD denominator after a sample↔envelope swap.)
    this._lastColormap = ''
    if (slots !== this._samples) {
      this._samples = slots
      const old = this._mesh.geometry as { dispose(): void }
      this._mesh.geometry = buildGeometry(this._channels, slots)
      old.dispose()
    }
    /* AFTER the slot count is committed — `_applyScroll` clamps against it. */
    this._applyScroll()
    this._buildPosition()
    this.invalidate()
  }

  /**
   * Swap which buffer rows are drawn — the montage seam, live. Pass the new
   * `[channels]` row-index buffer and how many rows it holds; the geometry is
   * rebuilt only when the count changes, and the gain / scroll / spacing uniforms
   * survive so the host's tool state is not reset by changing the selection.
   */
  setRowMap(rowMap: unknown | null, channels: number): void {
    this._rowMap = rowMap
    // The value channel reads through the row map, so any swap rebuilds the colour
    // node — not only a change of COUNT, which is all the per-row ramp cared about.
    this._lastColormap = ''
    if (channels !== this._channels) {
      this._channels = channels
      const old = this._mesh.geometry as { dispose(): void }
      this._mesh.geometry = buildGeometry(channels, this._samples)
      old.dispose()
    }
    this._buildPosition()
    this.invalidate()
  }

  /**
   * Solid color for every trace, or `null` to fall back to the colormap
   * (per-row via `colorIndex`, else the drawn-index ramp). Live — rebuilds only
   * the material's `colorNode`, never the geometry.
   */
  setColor(color: string | null): void {
    this._color = color
    this._lastColormap = ''
    this.invalidate()
  }

  /** Swap the per-row colormap-position buffer (see `LineOptions.colorIndex`). Live. */
  setColorIndex(colorIndex: unknown | null): void {
    this._colorIndex = colorIndex
    this._lastColormap = ''
    this.invalidate()
  }

  /**
   * Multiply the SAMPLED colormap RGB (1 = as shipped). The theme lever for
   * categorical lines: a palette tuned for a dark ground reads pastel on a
   * light one, and no darker categorical row exists in the atlas — so the
   * host darkens the samples instead (e.g. 0.7 on the light scheme). Solid
   * `color` is untouched: an explicit colour is already the host's choice.
   */
  setColorGain(gain: number): void {
    if (gain === this._colorGain) return
    this._colorGain = gain
    this._lastColormap = ''
    this.invalidate()
  }

  /**
   * Swap the per-vertex VALUE buffer — the second channel (see `LineOptions.values`).
   * Pass `null` to fall back to per-row colour. Live: rebuilds only the colour node.
   */
  setValues(values: unknown | null): void {
    this._values = values
    this._lastColormap = ''
    this.invalidate()
  }

  /**
   * Retarget the value channel's colour clim.
   *
   * The clim is CAPTURED in the colour node, so this forces `onUpdate` past its
   * early-out — the same reason `Particles.setClim` does. A line whose clim never
   * moved would render a correct second channel through the wrong scale, which is a
   * picture, not an error.
   */
  /** BAKED into the colour node — see `Drawable.onClimChanged`. */
  protected onClimChanged(): void { this._lastColormap = '' }

  /** The value channel's colour clim — what the colorbar and legend key to. */

  /**
   * Read the value channel as labels through `scheme`, or `null` for a continuous ramp.
   *
   * Live, but note what it does NOT do: the buffer is untouched. Swapping a scheme
   * while the values still hold quantities paints a plausible parcellation of noise —
   * commit a buffer and the scheme it belongs to together.
   */
  setCategorical(scheme: CategoricalScheme | null): void {
    this._categorical = scheme
    if (!scheme) this._material.transparent = this._opacity < 1
    this._lastColormap = ''
    this.invalidate()
  }

  /**
   * What this line states in the legend, or null for nothing. Set by the host, like
   * `Particles.legend` — the drawable knows a buffer and a clim, never a quantity.
   */

  /**
   * The extent, WITH the channel stack accounted for.
   *
   * `channelSpacing` puts channel `c` at baseline `c·spacing`, so `channels`
   * traces at spacing `s` occupy `yExtent` widened by `(channels − 1)·s`. Before
   * this, `dataBounds` reported the single-trace extent and a caller stacking
   * twenty-eight channels had to pass a matching `yExtent` by hand.
   *
   * **Read from the LIVE uniform, not from a constructed constant**, because
   * `spacing` is a uniform precisely so a host can animate between butterfly
   * (`0`, all overlaid) and stacked (`>0`). A construction-time extent stops
   * matching the moment that animation starts, which is the one situation the
   * uniform exists for. `Axes.syncFrame` asks every frame, so the frame follows.
   */
  dataBounds(): Bounds {
    const s = Number((this.spacing as { value: number }).value) || 0
    const stack = s > 0 ? (this._channels - 1) * s : 0
    const ylim: Limits = [this._yExtent[0], this._yExtent[1] + stack]
    return this._zExtent
      ? { xlim: this._xExtent, ylim, zlim: this._zExtent }
      : { xlim: this._xExtent, ylim }
  }

  /**
   * The legend entry, or null while hidden, solid-coloured, or carrying no value
   * channel.
   *
   * Per-ROW colour is deliberately excluded: it encodes IDENTITY — which trace this
   * is — and a ramp labelled with a clim would claim those colours mean a quantity.
   * A key for grouped traces is a swatch list, which this legend does not draw.
   */
  legendEntry(): LegendEntry | null {
    if (!this.legend || !this.visible || !this._values || this._color !== null) return null
    /* A CATEGORICAL LAYER HAS NO RAMP TO KEY. The bar states "this colormap, over this
       clim" and neither half is true — the fill comes from a lookup table the bar
       does not sample, and the numbers are ids with no order to put on an axis. Its key
       is a swatch list, which this legend does not draw. */
    if (this._categorical) return null
    return {
      title: this.legend.title,
      unit: this.legend.unit,
      clim: this.clim(),
      colormap: this.colormap || this.axes.colormap,
    }
  }

  /**
   * Colour every vertex by the VALUE channel, through the axes colormap.
   *
   * `t` is computed in the VERTEX stage and carried by a `varying`, so what the
   * rasteriser interpolates along a segment is the NORMALISED VALUE and not the RGB.
   * The ramp is then sampled per fragment. Interpolating the colour instead would cut
   * a straight line through colour space between two vertices — which for a cyclic
   * map (phase) walks backwards through hues the data never took, and for a diverging
   * map crosses the neutral centre between two same-sign samples.
   */
  private _buildValueColor(): void {
    const cat = this._categorical
    // The scheme, not the colormap, is what a categorical line's node depends on — key
    // the rebuild guard on whichever is actually in force.
    const key = cat ? `__cat:${cat.id}:${cat.width}` : this.effectiveColormap()
    if (key === this._lastColormap) return
    this._lastColormap = key
    const vals: any = asReadOnly(this._values)
    const opq = this._opacity
    if (cat) {
      /* THE LABEL ARRIVES FLAT. Nearest sampling in `categoricalColor` fixes the
         lookup and does nothing about a label interpolated on the way in: a segment
         spanning labels 12 and 30 walks through 13…29, painting regions that are not
         there, before the sampler is ever consulted. Either half alone still bleeds.

         UNGUARDED, as `Surface`'s is: a `typeof v.setInterpolation === 'function'`
         check would turn a renamed three API into silently bleeding labels — the exact
         defect this line exists to prevent, and one no test and no type error can see.
         Better it throws on the first categorical draw. */
      const label: any = (varying as any)(vals.element(this._decode(attribute('aIdx')).flat))
      label.setInterpolation('flat')
      /* THE SCHEME'S ALPHA IS LOAD-BEARING and a `LineBasicNodeMaterial` ignores alpha
         unless it is told to blend — leaving an unlabelled stretch drawn at the
         transparent texel's RGB, which is BLACK. The same defect that shipped on the
         cortex in another shape. */
      this._material.transparent = true
      this._material.colorNode = (Fn as any)(() => {
        const c: any = categoricalColor(label, cat)
        return vec4(c.x, c.y, c.z, c.w.mul(float(opq)))
      })()
      this._material.needsUpdate = true
      return
    }
    const row = colormapRowOrNull(key)
    const [d0, d1] = this._clim
    // A degenerate clim would divide by zero and paint the whole line NaN; 1 leaves
    // every value at the ramp's floor instead, which reads as "no range here".
    const span = (d1 - d0) || 1
    const op = opq
    // Read at the SAME slot the position node draws from — `_decode` is why the two
    // cannot drift apart under `rowMap`, `scroll` or an envelope source.
    const t: any = (varying as any)(
      clamp(vals.element(this._decode(attribute('aIdx')).flat).sub(float(d0)).div(float(span)),
            float(0), float(1)),
    )
    this._material.colorNode = (Fn as any)(() => {
      if (row === null) return vec4(t, t, t, float(op))
      const rgb = createColormapSampler('default').sample(t, row) as any
      return vec4(rgb.r, rgb.g, rgb.b, float(op))
    })()
    this._material.needsUpdate = true
  }

  protected onUpdate(): void {
    // Solid color → set once. Per-channel color → rebuild the colorNode on colormap change.
    if (this._color !== null) {
      if (this._lastColormap !== '__solid') {
        this._lastColormap = '__solid'
        const c = new Color(this._color)
        this._material.colorNode = vec4(float(c.r), float(c.g), float(c.b), float(this._opacity))
        this._material.needsUpdate = true
      }
      return
    }
    // THE VALUE CHANNEL outranks the per-row colour: a line carrying a second
    // quantity is coloured by it, not by which trace it is.
    if (this._values) { this._buildValueColor(); return }
    const cmap = this.effectiveColormap()
    if (cmap === this._lastColormap) return
    this._lastColormap = cmap
    const row = colormapRowOrNull(cmap)
    const chans = this._channels, samps = this._samples, op = this._opacity
    // Where each drawn channel sits on the colormap: its own `t` when the host
    // supplied one (color by group / category), else the drawn-index ramp.
    const ci: any = this._colorIndex ? asReadOnly(this._colorIndex) : null
    this._material.colorNode = (Fn as any)(() => {
      const idx: any = attribute('aIdx')
      const chan = idx.div(samps).floor()
      const t = ci
        ? ci.element(int(chan))
        : (chans > 1 ? chan.div(chans - 1) : float(0))
      if (row === null) return vec4(t, t, t, float(op))
      const rgb = createColormapSampler('default').sample(t, row) as any
      const g = float(this._colorGain)
      return vec4(rgb.r.mul(g), rgb.g.mul(g), rgb.b.mul(g), float(op))
    })()
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    super.dispose()
  }
}
