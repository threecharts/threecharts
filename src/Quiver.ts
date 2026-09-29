import { InstancedMesh, MeshBasicNodeMaterial, DoubleSide, Color } from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, abs, instanceIndex, positionGeometry, float, int, vec3, vec4, max, clamp, mix, step, uniform, varying, cameraPosition, cross, normalize, attributeArray } from 'three/tsl'

/**
 * Guards `v / |v|` against a ZERO vector, and nothing more.
 *
 * It was `1e-5` — a length in the FIELD's units — and the direction `d = v / len` is
 * only a unit vector while the true magnitude wins. A cortical current in raw A·m has
 * |v| ~ 5e-11, so the floor won every arrow and `d` came out 5e-6 long instead of 1:
 * every glyph collapsed to a millionth of its size. It is masked today only because
 * the app rescales the field into a pA·m display unit of order 1–50 before it ever
 * reaches here — which is to say it is masked by a decision made in another package,
 * for other reasons, that could be revisited at any time.
 */
const VEC_EPS = 1e-30

import { Drawable } from './Drawable'
import type { LegendEntry } from './AxesLegend'
import type { Axes } from './Axes'
import type { Limits, Bounds } from './limits'
import { arrowGeometry } from './arrowShape'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { categoricalColor, type CategoricalScheme } from './categorical'
import { asReadOnly } from './storage-access'
import { createVertexMask, type MaskSource, type VertexMask } from './vertex-mask'
import { isMovable, type Domain, type MovableDomain } from './domain/Domain'
import { pointsDomain } from './domain/pointsDomain'
import { gridDomain } from './domain/gridDomain'
import { resolveField, resolveFieldOrNull, type FieldSource, type Timepoint } from './field/source'

/** What the arrows' colour encodes — see `QuiverOptions.colorBy`. */
export type QuiverColorBy = 'magnitude' | 'direction' | 'value'

/** Resolve a colormap NAME → atlas row, or null (→ grayscale). */
export interface QuiverOptions {
  xExtent?: Limits
  yExtent?: Limits
  /** z-extent for a 3D lattice (`dims: 3`). Default [0,1]. */
  zExtent?: Limits
  /** Arrow grid resolution (x). Default 28 (2D) / 8 (3D); y/z derived if omitted. */
  arrowsX?: number
  arrowsY?: number
  /** Arrow grid resolution (z) — 3D only. Default 8. */
  arrowsZ?: number
  /** Arrow length per unit vector magnitude (data units) — a LIVE uniform
   *  (`quiver.scale.value`). Under `normalize` it is the arrow length outright. */
  scale?: number
  /**
   * Draw every arrow at the SAME length (`scale`), so only DIRECTION varies.
   *
   * Length and colour otherwise encode the same magnitude twice, which wastes one
   * channel and — on a field with a long tail, like a cortical source current —
   * lets a few large vectors dominate the picture while the rest are sub-pixel.
   * Normalizing hands magnitude entirely to the colormap and lets the arrows show
   * the flow's STRUCTURE. Default false: length-encoded, the honest default when
   * the reader has not asked for otherwise.
   *
   * That trade is only forced when length and colour read the SAME buffer. `values`
   * gives colour a quantity of its own and leaves the length encoding intact — which
   * is the better answer whenever a second quantity exists to show.
   */
  normalize?: boolean
  /**
   * How an arrow's LENGTH follows its magnitude.
   *
   *   `magnitude`  length = |v| · scale. Linear and UNBOUNDED — a vector twice the
   *                clim's top draws twice as long as the clim's top.
   *   `clim`       length = scale · clamp((|v| − d₀) / (d₁ − d₀), 0, 1). The clim
   *                is the full range, `scale` is the LONGEST arrow, and outliers
   *                SATURATE instead of growing.
   *
   * `clim` is what the manifold viewport did (`lengthScale` in
   * `@nxr/charts-webgpu/mesh`), and on a long-tailed field it is the difference
   * between a readable picture and a few spikes: a robust-max clim leaves real
   * outliers above `d₁` by construction, and under `magnitude` they draw
   * proportionally longer with nothing to stop them.
   *
   * Default `magnitude` — the existing behaviour, so nothing already drawn moves.
   */
  lengthMode?: 'magnitude' | 'clim'
  /**
   * Where on the arrow its ANCHOR sits — the grid cell, or the surface vertex.
   *
   *   `tail`    the arrow starts at the anchor and extends forward.
   *   `center`  the anchor is the arrow's midpoint; it straddles, half back, half on.
   *
   * `center` is what the manifold viewport drew (`glyph-geo-2d.ts` spans
   * `[-0.65, +0.65]`, and a comment records the shift that put the midpoint on the
   * origin). It matters most on a DENSE per-vertex field: tail-anchored, every
   * arrow's ink sits half a length downstream of the datum it describes, so the whole
   * pattern reads as displaced — and under `lengthMode: 'clim'` the displacement
   * grows with magnitude, which is a distortion rather than an offset. It also halves
   * how far a glyph protrudes, which on a folded cortex with `depthTest` is the
   * difference between an arrow staying in its sulcus and punching through the far
   * wall.
   *
   * Default `tail` — the existing behaviour, so nothing already drawn moves.
   */
  anchorAt?: 'tail' | 'center'
  /**
   * What the arrows' COLOUR encodes.
   *
   * - `magnitude` (default) — `|vector|` through the colormap, keyed by a colorbar.
   * - `direction` — the vector's ORIENTATION, as `|x|,|y|,|z|` → R,G,B in the data's
   *   own axes. See `setColorBy` for why it is the absolute value and what that costs.
   *
   * Ignored while a solid `color` is set; that outranks both.
   */
  colorBy?: QuiverColorBy
  /**
   * A COLOUR CHANNEL independent of the vectors: one float per arrow, indexed exactly
   * as the vector buffer is, colour-mapped through the axes colormap over `valueDomain`.
   *
   * The vector buffer gives an arrow its DIRECTION and, by default, its length and its
   * colour — three encodings of one quantity. `normalize` and `setSolidColor` both
   * exist to spend one of them back, by throwing an encoding away. This spends it on a
   * SECOND quantity instead: arrows lengthed by ‖J‖ and coloured by divergence, or by
   * phase, or by the region they sit in.
   *
   * Supplying it makes `colorBy` default to `'value'`; `'magnitude'` and `'direction'`
   * remain selectable, live, so a host can offer all three off one construction.
   */
  values?: FieldSource
  /** Range `values` span. Default [0,1]. Separate from `clim`, which is the LENGTH
   *  channel's range — two channels, two quantities, two ranges. */
  valueDomain?: Limits
  /**
   * Read the value channel as LABEL IDS through a categorical scheme instead of as
   * quantities through a ramp — arrows coloured by the region, bundle or
   * state they belong to while their length still carries a quantity. Requires
   * `values`, and makes `colorBy` default to `'value'` as any value channel does.
   *
   * `valueDomain` does not apply and is ignored; a label addresses its texel directly. The
   * scheme's ALPHA is respected, so label 0 (or any gap) is drawn invisible rather
   * than black.
   */
  categorical?: CategoricalScheme
  /**
   * A LENGTH CHANNEL independent of the vectors: one float per arrow, indexed exactly
   * as the vector buffer is, mapped to arrow length through `clim`, `scale` and
   * `lengthMode` exactly as ‖vector‖ is.
   *
   * The vectors still set DIRECTION — that is what a vector is for. This only replaces
   * the magnitude the length reads. `Particles.sizes` is the same idea one primitive
   * over.
   */
  lengths?: FieldSource
  /** Solid color for every arrow. Omit → color by |vector| through the axes colormap. */
  color?: string
  /**
   * How this layer describes itself in the legend — `{ title, unit }` — or omit for
   * no entry. The glyphs carry their OWN colour scale (a quiver and the surface under
   * it routinely encode different quantities through different colormaps), so they
   * state it themselves rather than borrowing the surface's key.
   */
  legend?: { title?: string; unit?: string }
  /** Magnitude range the colormap spans (color-by-|vector|). Default [0,1]. */
  clim?: Limits
  /**
   * Per-SAMPLE visibility, `>= 0.5` draws — the same `MaskSource` a `Surface` takes,
   * and deliberately the same module, so hiding a hemisphere hides the surface and its
   * glyphs through one array rather than two conventions.
   *
   * Indexed like the vector read: in anchor mode that is one entry per anchor, which
   * for the app's per-vertex glyph model IS the vertex mask the Surface is given.
   *
   * A masked arrow is collapsed to zero LENGTH in the vertex stage rather than
   * discarded in the fragment stage, because a vertex shader cannot discard. Its
   * triangles come out zero-area and rasterize nothing — the same end, one stage
   * earlier, and it costs the hidden arrows no fragments at all.
   *
   * DECLARE IT UP FRONT, even all-ones: `setMask` can then rewrite values into the
   * buffer already bound, where arriving from `null` has to rebuild the node graph.
   */
  mask?: MaskSource
  /** Depth-test the arrows (default false). Set true when the arrows sit on a 3D
   *  SURFACE so far-side arrows are hidden behind it. */
  depthTest?: boolean
  /** 2 (default) → a `[frames × rows·cols] vec2` field sampled on the x/y grid; 3 →
   *  a `[frames × AX·AY·AZ] vec3` field, ONE vector per lattice cell, drawn as a
   *  CAMERA-FACING flat arrow along the 3D vector (readable at any orbit angle). */
  dims?: 2 | 3
  /**
   * ANCHOR mode (with `dims: 3`): a `[N × 3]` buffer of anchor positions — one arrow
   * per anchor (e.g. surface VERTICES), oriented by the `[N × 3]` vector buffer indexed
   * 1:1. Pass N as `rows` (cols = 1). The glyph is pinned to its anchor and only
   * scales/orients; it does not advect. Overrides the lattice.
   *
   * A **Float32Array** is copied into a buffer this drawable OWNS, and `setAnchors`
   * can then rewrite it — which is what lets glyphs follow a surface that is being
   * smoothed or inflated, since an arrow left at the folded vertex would float off the
   * moved cortex. Anything else is an external storage node, read only, and
   * `setAnchors` throws: the same two-source contract `VertexMask` uses, for the same
   * reason — a caller who did not hand over a buffer cannot be handed write access to
   * one.
   */
  positions?: Float32Array | unknown
  /**
   * The DOMAIN these arrows are anchored on — a `Surface`'s mesh, a point set.
   *
   * Preferred over `positions`, and it supplies three things that option cannot:
   * the anchor COUNT (so a mismatch with the vector buffer is a structural error
   * rather than a runtime `throw`), the anchor EXTENT (so the arrows contribute to
   * auto-limits instead of contributing nothing), and a SHARED buffer — a surface
   * and every glyph layer on it read the same vertices, so one `setPositions`
   * moves all of them and there is no way to leave a layer behind at the folded
   * position.
   */
  domain?: Domain
  /** Which slice of the vector buffer to read. Defaults to the Figure clock's
   *  shared uniform. Pass a NUMBER when the buffer holds ONE timepoint (the host
   *  re-solves it per frame) or is static. */
  timepoint?: Timepoint
}



/**
 * Quiver — a vector field drawn as arrow glyphs. Reads a `[frames × N × D]` vector
 * field from an EXTERNAL GPU storage buffer (arrangement 1) — the drawable holds only
 * a handle. One instanced arrow per grid cell; the VERTEX shader reads the buffer
 * (read-only) at the shared Clock's frame, orients + scales the base arrow to the
 * vector, and places it in data coords. `timepoint` + `scale` are live uniforms → zero
 * re-upload. `dims:3` places the arrows on a 3D lattice as camera-facing glyphs.
 *
 * THREE CHANNELS, and the vector buffer is only the first. It always sets DIRECTION;
 * by default it also sets length and colour, so one quantity is drawn three ways.
 * `lengths` and `values` take those two over — arrows lengthed by ‖J‖ and coloured by
 * divergence — in the shape `Particles` established with `buffer`/`sizes`/`values`. A
 * solid `color` still outranks colour entirely.
 */
export class Quiver extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _mesh: InstancedMesh
  private readonly _xExtent: Limits
  private readonly _yExtent: Limits
  private readonly _zExtent: Limits | null
  private _color: string | null
  private readonly _vMag: any        // per-arrow |vector| varied to the fragment (colormap)
  private readonly _vDir: any        // per-arrow vector varied to the fragment (direction colour)
  private readonly _vVal: any        // per-arrow VALUE channel varied to the fragment
  private _valueDomain: Limits
  /** Read `values` as labels through this scheme, or null → a continuous ramp. */
  private readonly _categorical: CategoricalScheme | null
  private _colorBy: QuiverColorBy
  /** The anchors' domain, when there is one. Answers `dataBounds`, and is what
   *  `setAnchors` writes through so a surface and its glyphs move together. */
  private readonly _anchorDomain: Domain | null
  /** Whether this drawable MADE its domain (from a `Float32Array`), and so whether
   *  it may free it. A domain handed in is shared and is the caller's. */
  private readonly _ownsDomain: boolean
  /** True only where the extent CANNOT be known: an external buffer handle with no
   *  extents declared. Not "deferred to the surface" — nothing to defer to. */
  private readonly _boundsUnknown: boolean
  private _lastColormap = ''
  private _mask: VertexMask | null = null
  /** Live arrow-length uniform — set `.value` to scale every arrow (zero re-upload). */
  readonly scale: any
  /** Live `1 = length encodes magnitude` / `0 = one length for all` uniform. Prefer
   *  `setNormalized`; this is exposed for the same reason `scale` is. */
  readonly byLength: any
  /** Glyph-origin uniform: 0 = tail at the anchor, 0.5 = centred on it. */
  private readonly _origin: any
  /** Length-mapping clim uniforms, live alongside `setClim`. */
  private readonly _dMin: any
  private readonly _dSpan: any
  /** True when every arrow is drawn at the same length — see `QuiverOptions.normalize`. */
  get normalized(): boolean { return Number(this.byLength.value) === 0 }
  /** Switch length-encoding on or off. One uniform write — no rebuild, no re-upload,
   *  and the camera the user set survives it. */
  setNormalized(v: boolean): void { this.byLength.value = v ? 0 : 1 }
  /** Where the anchor sits on the arrow — see `QuiverOptions.anchorAt`. Live, for the
   *  same reason `setNormalized` is: it is one subtraction in the shader, so making it
   *  construction-time would cost a rebuild for a uniform's worth of change. */
  setAnchorAt(v: 'tail' | 'center'): void { this._origin.value = v === 'center' ? 0.5 : 0 }
  get anchorAt(): 'tail' | 'center' { return Number(this._origin.value) === 0 ? 'tail' : 'center' }

  constructor(axes: Axes, vectors: FieldSource, rows: number, cols: number, opts: QuiverOptions = {}) {
    const dims = opts.dims ?? 2
    const xExtent = opts.xExtent ?? [0, cols]
    const yExtent = opts.yExtent ?? [0, rows]
    const zExtent = opts.zExtent ?? [0, 1]
    const tp: any = typeof opts.timepoint === 'number'
      ? (uniform as any)(opts.timepoint)          // static: a one-slice buffer, off the clock
      : (opts.timepoint ?? axes.figure.clock.frameUniform)
    /* `vec3` for a 3-D field, `vec2` for the 2-D lattice — the element layout the
       shader reads, decided here so a caller never has to name it. */
    const buf: any = resolveField(vectors, (opts.dims ?? 2) === 3 ? 'vec3' : 'vec2').node
    /* The two INDEPENDENT channels. Read at the same per-arrow index the vector is —
       each branch's `vecIdx`/`cellIdx` — so a length, a colour and a direction always
       describe the same arrow. */
    const valuesBuf: any = resolveFieldOrNull(opts.values)?.node ?? null
    const lengthsBuf: any = resolveFieldOrNull(opts.lengths)?.node ?? null
    const colorByMap = opts.color == null
    /* ANCHOR MODE ONLY, and stated rather than half-defined. There the mask has an
       unambiguous meaning — one entry per anchor, which in the app's per-vertex glyph
       model is exactly the array the Surface is masked with. The lattice modes resample
       a field onto their own grid, so "one entry per arrow" and "one entry per field
       cell" are different arrays and neither is obviously the caller's intent. A mode
       that cannot say what an index means should not accept one.
       Declared before the position nodes, which close over it. */
    let mask: VertexMask | null = null
    /** Set only when this drawable owns its anchor buffer — see `positions`. */

    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    material.depthTest = opts.depthTest ?? false; material.depthWrite = false
    if (!colorByMap) material.color = new Color(opts.color)

    let count: number
    let scaleU: any
    let vMag: any = null
    /* The VECTOR itself, varied to the fragment for direction colouring. Built beside
       `vMag` in each branch rather than derived from it, because the length throws the
       direction away — and it is a `vec3` in all three branches so the fragment has one
       shape to handle (the 2D lattice pads z with 0). */
    let vDir: any = null
    let vVal: any = null
    // A LIVE uniform, not a construction-time branch: 1 = length encodes magnitude,
    // 0 = every arrow one length. Switching it as a boolean would rebuild the node
    // graph, and rebuilding the drawable costs the camera and a frame — for what is,
    // in the shader, a choice between multiplying by `len` and multiplying by 1.
    const byLenU: any = (uniform as any)(opts.normalize ? 0 : 1)
    const climMode = opts.lengthMode === 'clim'
    // The glyph spans x ∈ [0, 1] (see `arrowShape`), so subtracting a half centres it.
    // A uniform rather than two geometries: it is one subtraction in the shader, and
    // the silhouette stays single-sourced.
    const originU: any = (uniform as any)(opts.anchorAt === 'center' ? 0.5 : 0)
    const d0 = (opts.clim ?? [0, 1])[0], d1 = (opts.clim ?? [0, 1])[1]
    /* Guard the DEGENERATE span only — never impose an absolute floor.
       `Math.max(d1 - d0, 1e-8)` was a divide-by-zero guard, but 1e-8 is a value in
       the data's own units, so it silently becomes the span whenever the field is
       naturally smaller than that. A cortical current in A·m has a 98th-percentile
       magnitude of ~5e-11 — 204x below the floor — so every arrow was drawn at
       ~0.5 % of its length (0.02 mm instead of 4 mm) and the layer looked empty
       while reporting itself visible. It went unnoticed because the field that
       used to feed this was dSPM, a z-score-like statistic of order 1, where the
       floor never binds. A quantity's scale is not a bug to clamp away. */
    const dSpan = d1 - d0
    const dSpanU: any = (uniform as any)(dSpan > 0 ? dSpan : 1e-8)
    const dMinU: any = (uniform as any)(d0)
    /* The anchors' DOMAIN — supplied, or built from values handed over. Building
       one is what makes those values framable: a bare `Float32Array` of anchors used
       to contribute no auto-bounds at all, because nothing measured it. Scanning
       `[N × 3]` floats once is cheap beside uploading them. */
    const anchorDomain: Domain | null = opts.domain
      ?? (opts.positions instanceof Float32Array ? pointsDomain(opts.positions) : null)
    /* Genuinely UNKNOWABLE, which is a different claim from the "defer framing to the
       surface" this used to make: an external storage node is a buffer handle the host
       never described, so its extent cannot be measured from here and explicit extents
       are the only way to state it. */
    const boundsUnknown = !anchorDomain && !!opts.positions && dims === 3
      && !(opts.xExtent && opts.yExtent && opts.zExtent)

    if (dims === 3 && (anchorDomain || opts.positions)) {
      // ANCHOR mode: N arrows at explicit STATIC positions (surface VERTICES), oriented
      // by the vector buffer read at `frame·N + i` — so the direction/length ANIMATE with
      // the clock while the anchor stays pinned (a static field is the frame-0 case, so
      // frameCount ≤ 1 leaves it static). The app's per-vertex vector-glyph model.
      const N = anchorDomain ? anchorDomain.count : Math.max(1, rows * cols)
      if (anchorDomain && rows * cols > 1 && rows * cols !== N) {
        throw new Error(`Quiver: domain has ${N} addresses but ${rows * cols} were requested`)
      }
      count = N
      /* Where an arrow sits. A domain answers it — and answers it the same way for
         every drawable on that domain, which is the point. The remaining branch is
         the external-node path, where the host owns a `[N × 3]` vec3 buffer we only
         read. */
      const anchorAt = anchorDomain
        ? (i: any): any => anchorDomain.positionAt(i)
        : ((posBuf: any) => (i: any): any => posBuf.element(i))(asReadOnly(opts.positions))
      if (opts.mask != null) mask = createVertexMask(opts.mask, N)
      scaleU = (uniform as any)(opts.scale ?? 1)
      const vecIdx = (i: any) => int(tp).mul(int(N)).add(i)            // frame slice + anchor
      material.positionNode = (Fn as any)(() => {
        const i: any = instanceIndex
        const base: any = anchorAt(i)                                  // vec3 anchor (vertex, static)
        const v: any = buf.element(vecIdx(i))                          // vec3 vector at frame t
        const len: any = max(v.length(), float(VEC_EPS))
        const d: any = v.div(len)
        const toCam: any = normalize(cameraPosition.sub(base))
        const c: any = cross(d, toCam)
        const right: any = c.div(max(c.length(), float(1e-4)))
        /* The LENGTH source. ‖v‖ still divides out the direction above — that is what a
           vector is for — but what the arrow's LENGTH reads may be another quantity
           entirely. */
        const lv: any = lengthsBuf ? lengthsBuf.element(vecIdx(i)) : len
        const s0: any = climMode
          ? scaleU.mul(mix(float(1), clamp(lv.sub(dMinU).div(dSpanU), float(0), float(1)), byLenU))
          : scaleU.mul(mix(float(1), lv, byLenU))
        // Hidden ⇒ every vertex of this arrow lands on `base`, so its triangles are
        // zero-area and produce no fragments. `step` rather than a branch: the mask
        // is a per-instance value, and a uniform-control-flow branch on it would be
        // divergent inside the workgroup for one multiply's worth of work.
        const s: any = mask ? s0.mul(step(float(0.5), mask.node.element(i))) : s0
        const p: any = positionGeometry
        return base.add(d.mul(p.x.sub(originU).mul(s))).add(right.mul(p.y.mul(s)))
      })()
      if (colorByMap) {
        const v: any = buf.element(vecIdx(instanceIndex))
        vMag = (varying as any)(v.length())
        vDir = (varying as any)(vec3(v.x, v.y, v.z))
        if (valuesBuf) vVal = (varying as any)(valuesBuf.element(vecIdx(instanceIndex)))
      }
    } else if (dims === 3) {
      // 3D LATTICE: AX·AY·AZ arrows, ONE vec3 per cell. Each is a camera-facing flat
      // arrow lying in the plane (d, right) where d = unit vector and right ⊥ d toward
      // the camera — so it points along the true 3D direction, foreshortens under the
      // ortho projection, and never goes fully edge-on (except pointing at the camera,
      // the correct degenerate case, guarded against a divide-by-zero).
      const AX = opts.arrowsX ?? 8
      const AY = opts.arrowsY ?? 8
      const AZ = opts.arrowsZ ?? 8
      const N = AX * AY * AZ
      count = N
      scaleU = (uniform as any)(opts.scale ?? ((xExtent[1] - xExtent[0]) / AX) * 0.8)
      const cellIdx = (i: any) => int(tp).mul(int(N)).add(i)   // one vector per lattice cell
      // The lattice is a DOMAIN: the same cell-centre arithmetic this branch used to
      // spell out, now stated once and shared with every other drawable placed on a
      // grid. Nothing is allocated — a rectilinear domain computes from strides.
      const lattice = gridDomain({ nx: AX, ny: AY, nz: AZ, x: xExtent, y: yExtent, z: zExtent })
      material.positionNode = (Fn as any)(() => {
        const i: any = instanceIndex
        const base: any = lattice.positionAt(i)
        const v: any = buf.element(cellIdx(i))                          // vec3 (vx, vy, vz)
        const len: any = max(v.length(), float(VEC_EPS))
        const d: any = v.div(len)                                       // unit 3D direction
        const toCam: any = normalize(cameraPosition.sub(base))
        const c: any = cross(d, toCam)
        const right: any = c.div(max(c.length(), float(1e-4)))         // ⊥ d, camera-facing (NaN-guarded)
        /* The LENGTH source. ‖v‖ still divides out the direction above — that is what a
           vector is for — but what the arrow's LENGTH reads may be another quantity
           entirely. */
        const lv: any = lengthsBuf ? lengthsBuf.element(cellIdx(i)) : len
        const s: any = climMode
          ? scaleU.mul(mix(float(1), clamp(lv.sub(dMinU).div(dSpanU), float(0), float(1)), byLenU))
          : scaleU.mul(mix(float(1), lv, byLenU))
        const p: any = positionGeometry                                // arrow in local xy: +x shaft, y across
        return base.add(d.mul(p.x.sub(originU).mul(s))).add(right.mul(p.y.mul(s)))
      })()
      if (colorByMap) {
        const v: any = buf.element(cellIdx(instanceIndex))
        vMag = (varying as any)(v.length())
        vDir = (varying as any)(vec3(v.x, v.y, v.z))
        if (valuesBuf) vVal = (varying as any)(valuesBuf.element(cellIdx(instanceIndex)))
      }
    } else {
      const AX = opts.arrowsX ?? 28
      const AY = opts.arrowsY ?? Math.max(2, Math.round(AX * (rows / cols)))
      const N = rows * cols
      count = AX * AY
      scaleU = (uniform as any)(opts.scale ?? (cols / AX) * 0.9)
      // Field cell (fr,fc) sampled by an arrow at instance i (shared by position + color).
      const cellIdx = (i: any) => {
        const gx: any = i.mod(int(AX)).toFloat().add(0.5).div(float(AX))
        const gy: any = i.div(int(AX)).toFloat().add(0.5).div(float(AY))
        const fc: any = gx.mul(cols).floor().clamp(0, cols - 1)
        const fr: any = gy.mul(rows).floor().clamp(0, rows - 1)
        return int(tp).mul(int(N)).add(int(fr.mul(cols).add(fc)))
      }
      // Same lattice, same arithmetic, one statement of it — see the 3-D branch.
      const lattice = gridDomain({ nx: AX, ny: AY, x: xExtent, y: yExtent })
      material.positionNode = (Fn as any)(() => {
        const i: any = instanceIndex
        const base: any = lattice.positionAt(i)                           // data base position
        const bx: any = base.x, by: any = base.y
        const v: any = buf.element(cellIdx(i))                            // vec2 (vx, vy)
        const len: any = max(v.length(), float(VEC_EPS))
        const dx: any = v.x.div(len), dy: any = v.y.div(len)             // unit direction
        /* The LENGTH source. ‖v‖ still divides out the direction above — that is what a
           vector is for — but what the arrow's LENGTH reads may be another quantity
           entirely. */
        const lv: any = lengthsBuf ? lengthsBuf.element(cellIdx(i)) : len
        const s: any = climMode
          ? scaleU.mul(mix(float(1), clamp(lv.sub(dMinU).div(dSpanU), float(0), float(1)), byLenU))
          : scaleU.mul(mix(float(1), lv, byLenU))
        const p: any = positionGeometry
        const ox: any = p.x.sub(originU)
        const rx: any = ox.mul(dx).sub(p.y.mul(dy)).mul(s)              // rotate + scale
        const ry: any = ox.mul(dy).add(p.y.mul(dx)).mul(s)
        return vec3(bx.add(rx), by.add(ry), float(0))
      })()
      if (colorByMap) {
        const v: any = buf.element(cellIdx(instanceIndex))
        vMag = (varying as any)(v.length())
        // z = 0: a planar field has no third component, and padding here keeps the
        // fragment's direction path one shape across all three branches.
        vDir = (varying as any)(vec3(v.x, v.y, float(0)))
        if (valuesBuf) vVal = (varying as any)(valuesBuf.element(cellIdx(instanceIndex)))
      }
    }

    const mesh = new InstancedMesh(arrowGeometry(), material, count)
    mesh.frustumCulled = false
    super(axes, mesh)
    this._material = material
    this._mesh = mesh
    this._xExtent = xExtent
    this._yExtent = yExtent
    this._zExtent = dims === 3 ? zExtent : null
    this._clim = opts.clim ?? [0, 1]
    this.legend = opts.legend ? { title: opts.legend.title ?? '', unit: opts.legend.unit ?? '' } : null
    this._color = opts.color ?? null
    this._vMag = vMag
    this._vDir = vDir
    this._vVal = vVal
    this._valueDomain = opts.valueDomain ?? [0, 1]
    this._categorical = opts.categorical ?? null
    /* A scheme's alpha is how a label says "no region here"; without blending the
       arrow is drawn at the transparent texel's RGB, which is black. */
    if (opts.categorical) material.transparent = true
    // A supplied VALUE channel is the reason to supply one: colour by it unless the
    // caller says otherwise. Without it, ‖vector‖ as always.
    this._colorBy = opts.colorBy ?? (valuesBuf ? 'value' : 'magnitude')
    this._anchorDomain = anchorDomain
    this._ownsDomain = opts.domain == null && anchorDomain != null
    this._boundsUnknown = boundsUnknown
    this.scale = scaleU
    this.byLength = byLenU
    this._origin = originU
    this._dMin = dMinU
    this._dSpan = dSpanU
    this._mask = mask
    this.invalidate()
  }

  /**
   * Rewrite per-arrow visibility. Values only — the buffer the vertex shader is bound
   * to is reused, so this is an upload and not a rebuild, and it is why the mask should
   * be DECLARED at construction even when nothing is hidden yet.
   *
   * Throws when the drawable was built without one, rather than silently doing nothing:
   * a mask that never arrives is indistinguishable from a mask that never applies, and
   * the anchor-mode restriction above makes that a real possibility.
   */
  setMask(m: Uint8Array | Float32Array): void {
    if (!this._mask) throw new Error('Quiver: no mask was declared at construction (anchor mode only)')
    this._mask.set(m)
    this.invalidate()
  }

  /** Whether a mask is in play at all — lets a host skip building one. */
  get masked(): boolean { return this._mask != null }

  /**
   * Move every arrow's anchor. Values only — the buffer the vertex shader reads is
   * reused, so this is an upload and not a rebuild, and the arrows keep their
   * orientation, length, colour and the camera.
   *
   * Throws when the anchors are externally owned, rather than silently doing nothing:
   * a host that expected its glyphs to follow a moving surface should hear about it.
   */
  setAnchors(p: Float32Array): void {
    const d = this._anchorDomain
    if (!d || !isMovable(d)) {
      throw new Error('Quiver: anchors are externally owned — pass a Float32Array or a movable domain')
    }
    /* Writes the DOMAIN, not a private copy — so a surface and every other glyph
       layer sharing it move in the same call. That is the whole reason this is not
       a local buffer any more: three separate copies had to be kept in step by
       hand, and a layer left behind floats off the moved surface. */
    ;(d as MovableDomain).setPositions(p)
    this.invalidate()
  }

  /** Whether the anchors can be moved, and so whether `setAnchors` will work. */
  get ownsAnchors(): boolean {
    return this._anchorDomain != null && isMovable(this._anchorDomain)
  }

  /** The domain these arrows are anchored on, when there is one. */
  get domain(): Domain | null { return this._anchorDomain }

  /** How this layer describes itself in the legend, or null. MUTABLE: a host that
   *  relabels the field relabels the key in the same frame. */

  /** The legend entry, or null when the glyphs are hidden or colour-free. A quiver
   *  with a SOLID colour encodes nothing by colour and states nothing — and one coloured
   *  by DIRECTION encodes something a colorbar cannot show, so it states nothing either
   *  rather than keying an orientation to a magnitude ramp it is not using. Colouring by
   *  the VALUE channel does key a ramp, over that channel's own range — see
   *  `clim`. The `legend` title is the host's, and on a value channel it had
   *  better name the value rather than the vector. */
  legendEntry(): LegendEntry | null {
    if (!this.legend || !this.visible || this._color != null) return null
    if (this._colorBy === 'direction') return null
    /* A categorical layer keys a swatch list, not a ramp. */
    if (this._colorBy === 'value' && this._categorical) return null
    return {
      title: this.legend.title,
      unit: this.legend.unit,
      clim: this.clim(),
      colormap: this.colormap || this.axes.colormap,
    }
  }

  /**
   * The range the colormap maps, for a colorbar — the VALUE channel's when colouring by
   * it, the magnitude's otherwise. It follows the colour, because that is the only
   * thing a colorbar is a key to: `clim` also drives arrow LENGTH, and keying a bar
   * to it while the fill comes from another quantity would state a scale that is not
   * the one on screen.
   */
  clim(): Limits { return this._colorBy === 'value' ? this._valueDomain : this._clim }

  /**
   * Retarget the VALUE channel's colour range. Live, like `setClim`.
   *
   * Deliberately separate from `setClim`, which moves the LENGTH mapping with it:
   * two channels carrying two quantities cannot share one range without one of them
   * being wrong.
   */
  setValueDomain(d: Limits): void {
    if (d[0] === this._valueDomain[0] && d[1] === this._valueDomain[1]) return
    this._valueDomain = d
    this._lastColormap = ''    // the clim is captured in the node — force a rebuild
    this.invalidate()
  }

  /** Retarget the magnitude→colormap range. Live, like `scale`. */
  /**
   * BOTH — a live uniform pair AND a node rebuild.
   *
   * Under `lengthMode: 'clim'` the range drives arrow LENGTH as well as colour, so
   * retargeting it has to move both or the two stop agreeing. The length mapping is
   * a uniform; the colour mapping is baked into the node.
   *
   * Same guard as the constructor: test for a DEGENERATE span, never impose an
   * absolute floor — 1e-8 is a value in the data's own units, and a cortical current
   * in A·m is 200x below it. (The constructor was fixed first; this path kept the
   * floor, so any live retarget silently reintroduced the collapse.)
   */
  protected onClimChanged(): void {
    if (this._dMin) {
      const span = this._clim[1] - this._clim[0]
      this._dMin.value = this._clim[0]
      this._dSpan.value = span > 0 ? span : 1e-8
    }
    this._lastColormap = ''
  }
  dataBounds(): Bounds | null {
    // The domain knows where its addresses are; that is what it is for.
    if (this._anchorDomain) return this._anchorDomain.bounds()
    if (this._boundsUnknown) return null
    return this._zExtent
      ? { xlim: this._xExtent, ylim: this._yExtent, zlim: this._zExtent }
      : { xlim: this._xExtent, ylim: this._yExtent }
  }

  /**
   * Colour every arrow the SAME, or hand colour back to the colormap with `null`.
   *
   * Live, where `color` used to be construction-only. Uniform is worth having because
   * length and colour otherwise encode the same magnitude twice: with the length
   * already carrying it, a flat colour lets the arrows show the field's STRUCTURE
   * without a second redundant channel — and it stops a dense per-vertex quiver
   * reading as a colormap competing with the surface underneath it. (`values` is the
   * other way out of the same redundancy: keep the colour, give it its own quantity.)
   *
   * The legend follows on its own: `legendEntry` returns null while a solid colour is
   * set, because a quiver that encodes nothing by colour has nothing to key.
   */
  setSolidColor(color: string | null): void {
    if (color === this._color) return
    this._color = color
    if (color !== null) {
      this._material.color = new Color(color)
      // The node OUTRANKS `material.color`, so it has to go or the flat colour never
      // shows — and it is rebuilt from scratch on the way back, hence the reset below.
      this._material.colorNode = null
    }
    this._lastColormap = ''      // force `onUpdate` past its unchanged-colormap guard
    this._material.needsUpdate = true
    this.invalidate()
  }

  /** The uniform colour in force, or null when colouring by magnitude. */
  get solidColor(): string | null { return this._color }

  /**
   * Colour the arrows by their ORIENTATION instead of their magnitude.
   *
   * `|x|, |y|, |z|` of the unit vector → R, G, B, in the DATA's own axes — the standard
   * orientation-colour convention from diffusion imaging, which on a subject in SCS
   * reads red = left–right, green = anterior–posterior, blue = superior–inferior.
   *
   * **ABSOLUTE, so it is UNDIRECTED**: a vector and its negative get the same colour.
   * That is deliberate and it is the convention's own trade. The signed alternative
   * (`v·0.5 + 0.5`) keeps the sign but spends the whole saturated gamut on it, so every
   * colour lands in a pastel band around grey and orientation — the thing being asked
   * for — becomes the harder of the two to read. Sign is still legible here: it is what
   * the ARROWHEAD shows, and on an eigenmode it flips across a nodal line where the
   * hue does not.
   *
   * **Why it is worth having beside a colormap.** Length already encodes magnitude, so
   * colouring by it too spends a second channel on one quantity — the same argument
   * `setSolidColor` makes, one step further: rather than giving the channel up, this
   * gives it to the quantity the arrows are otherwise silent about. `'value'` is the
   * third answer: a quantity the caller supplies, unrelated to the vector.
   *
   * Live. Rebuilds the colour NODE (a material update, like `setSolidColor` and a
   * colormap change), never the drawable — so the camera and the buffers are untouched.
   * Ignored while a solid colour is set; that outranks both.
   */
  setColorBy(mode: QuiverColorBy): void {
    if (mode === this._colorBy) return
    this._colorBy = mode
    this._lastColormap = ''      // force `onUpdate` past its unchanged-colormap guard
    this.invalidate()
  }

  /** What the arrows' colour encodes. */
  get colorBy(): QuiverColorBy { return this._colorBy }

  protected onUpdate(): void {
    if (this._color !== null) return   // solid color → material.color, no colorNode
    const cmap = this.effectiveColormap()
    if (cmap === this._lastColormap) return
    this._lastColormap = cmap
    const row = colormapRowOrNull(cmap)
    const [d0, d1] = this._clim
    const vm = this._vMag
    const vd = this._vDir
    const vv = this._vVal
    const byDir = this._colorBy === 'direction' && vd != null
    const byVal = this._colorBy === 'value' && vv != null
    const cat = this._categorical
    const [v0, v1] = this._valueDomain
    // A degenerate span would paint every arrow NaN; 1 leaves them at the ramp's floor.
    const vSpan = (v1 - v0) || 1
    this._material.colorNode = (Fn as any)(() => {
      if (byVal && cat) {
        // Labels, not quantities: no clim, and the scheme's alpha rides through so an
        // unassigned arrow disappears rather than drawing black. Per-INSTANCE, so no
        // flat varying is needed — every vertex of an arrow carries the same label.
        const c: any = categoricalColor(vv, cat)
        return vec4(c.x, c.y, c.z, c.w)
      }
      if (byVal) {
        // THE INDEPENDENT CHANNEL: a quantity of its own, over its own range. The
        // arrows' length still says ‖vector‖ (or whatever `lengths` carries) — the
        // two encodings no longer compete for the same number.
        const vn = clamp(vv.sub(v0).div(vSpan), float(0), float(1))
        if (row === null) return vec4(vn, vn, vn, float(1))
        const rgb = createColormapSampler('default').sample(vn, row) as any
        return vec4(rgb.r, rgb.g, rgb.b, float(1))
      }
      if (byDir) {
        /* NORMALIZED IN THE FRAGMENT, not the vertex shader: the varying is
           interpolated across the arrow's triangles, and interpolating two unit vectors
           does not give a unit vector — the shaft would desaturate toward its middle.
           Guarded against a zero-length vector, whose direction is undefined and whose
           normalize is NaN; it renders black, which is the honest answer for "no
           direction here". */
        const n: any = vd.div(max(vd.length(), float(1e-20)))
        return vec4(abs(n.x), abs(n.y), abs(n.z), float(1))
      }
      const vn = clamp(vm.sub(d0).div(d1 - d0), float(0), float(1))   // normalize |v| to [0,1]
      if (row === null) return vec4(vn, vn, vn, float(1))
      const rgb = createColormapSampler('default').sample(vn, row) as any
      return vec4(rgb.r, rgb.g, rgb.b, float(1))
    })()
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    if (this._ownsDomain) (this._anchorDomain as { dispose?: () => void })?.dispose?.()
    super.dispose()
  }
}
