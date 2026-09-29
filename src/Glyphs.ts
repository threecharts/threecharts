import { InstancedMesh, MeshBasicNodeMaterial, Color, DoubleSide, type BufferGeometry } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, instanceIndex, positionGeometry, uniform, vec3, vec4, float, int, clamp } from 'three/tsl'
import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds, Limits } from './limits'
import { isParametric, type Domain, type ParametricDomain } from './domain/Domain'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { resolveFieldOrNull, type FieldSource, type Timepoint } from './field/source'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Which axes a per-address size scales. Bars want `'y'`; a marker wants `'xyz'`. */
export type GlyphSizeMode = 'xyz' | 'x' | 'y' | 'z'

/**
 * How a `[frames × N]` field is laid out — and both orders are legitimate.
 *
 * `frame-major` (`t·N + i`) keeps ONE FRAME contiguous, which is what an
 * animation wants and what every other drawable here assumes.
 *
 * `row-major` (`i·frames + t`) keeps ONE ADDRESS's whole history contiguous,
 * which is how a recording is stored and what scrubbing wants. `Line`'s windowed
 * mode already takes this form; `Glyphs` takes it because a caller with a
 * `[rows × time]` array should not have to transpose a large buffer to plot it.
 */
export type GlyphLayout = 'frame-major' | 'row-major'

export interface GlyphsOptions {
  /**
   * Where each glyph's ORIGIN sits along the size axis, as a normalised `v` in
   * `[0, 1]` across the domain's second extent. A field, or one constant.
   *
   * **Its presence switches how a glyph is placed, and that is the point.** Without
   * it a glyph sits at its ADDRESS — right for a marker, a scatter point, a quiver
   * anchor. With it a glyph sits at a VALUE, which is what anything with a baseline
   * needs: a bar rising from zero, a box floating between Q1 and Q3, a candlestick,
   * a gantt span, an error bar.
   *
   * Without this, a bar grew from `positionAt(i)` — the cell CENTRE of the second
   * extent — so a bar chart over `y: [0, 1]` started at 0.5 and nothing said so.
   *
   * In this mode `size` is in the same normalised `v` units, so `baseline: 0,
   * size: 0.7` is a bar covering seven-tenths of the extent. It also requires a
   * PARAMETRIC domain, because a value between samples is where the glyph goes.
   */
  baseline?: FieldSource | number
  /** Per-address magnitude — a bar's height, a marker's radius. */
  size?: FieldSource
  /** Which axes `size` scales. Default `'xyz'`. */
  sizeMode?: GlyphSizeMode
  /** Constant multiplier on top of `size`. A live uniform. Default 1. */
  scale?: number
  /** Per-address value → colour through the axes colormap. */
  values?: FieldSource
  /** A single colour for every glyph instead — overrides `values`. */
  color?: string | number
  /** Value range `values` spans. Default [0, 1]. */
  clim?: Limits
  /** Which slice of a stacked field to read. Defaults to the figure clock. */
  timepoint?: Timepoint
  /** Slices in a stacked field. Required by `layout: 'row-major'`, where it is
   *  the per-address stride. Default 1 (a static field). */
  frames?: number
  /** How a stacked field is indexed. Default `'frame-major'`. */
  layout?: GlyphLayout
  /** Opacity. Default 1. */
  opacity?: number
}

/**
 * Glyphs — one copy of a geometry at every address of a domain, scaled and
 * coloured by fields.
 *
 * **The general form of a mark**, and the one primitive the library was missing.
 * `Quiver`, `Particles`, `Labels` and the markers are each a SPECIALISED version
 * of this with a fixed shape and a fixed orientation rule; `contrib/ring` proved a
 * caller can author their own, but had to write the placement, the field plumbing
 * and the colour node from scratch to do it. With this, a bar chart is a unit quad,
 * a box plot is a rectangle, a scatter is a disc, and none of them is new code.
 *
 * This is `place` + `paint` in the sense of FOUNDATIONS §1.4: the domain says
 * WHERE each glyph goes, a field says HOW BIG, another says WHAT COLOUR, and the
 * geometry itself is fixed. Nothing is rebuilt when the data changes — advancing
 * `timepoint` moves every glyph, which is why a time-varying bar chart costs one
 * uniform write per frame rather than a re-upload.
 *
 * It deliberately does NOT orient glyphs. Orientation is where the specialised
 * marks genuinely differ — a quiver aligns to a vector and faces the camera, a
 * label faces the camera and never rotates — and a single option covering all of
 * those would be the over-abstraction §5 warns about. A mark that needs
 * orientation subclasses `Drawable`, as `contrib/ring` shows.
 */
export class Glyphs extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _domain: Domain
  /** Live constant scale — set `.value` to resize every glyph without a rebuild. */
  readonly scale: any
  /**
   * The slice being read, as a live uniform.
   *
   * Exposed because it IS the animation: setting `.value` moves every glyph to the
   * next frame's data with no re-upload and no node rebuild. When the caller
   * follows the figure clock this is the clock's own uniform, so writing it would
   * fight the loop — read it, and drive the clock instead.
   */
  readonly timepoint: any

  constructor(axes: Axes, geometry: BufferGeometry, domain: Domain, opts: GlyphsOptions = {}) {
    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    const opacity = opts.opacity ?? 1
    if (opacity < 1) { material.transparent = true; material.depthWrite = false }

    const mesh = new InstancedMesh(geometry, material, Math.max(1, domain.count))
    mesh.frustumCulled = false
    super(axes, mesh)

    this._material = material
    this._domain = domain
    this.scale = (uniform as any)(opts.scale ?? 1)

    const N = domain.count
    const frames = Math.max(1, opts.frames ?? 1)
    const tp: any = typeof opts.timepoint === 'number'
      ? (uniform as any)(opts.timepoint)
      : (opts.timepoint ?? axes.figure.clock.frameUniform)
    this.timepoint = tp

    /* The index formula IS the layout, and it is the whole reason `layout` exists:
       a caller holding `[rows × time]` should not transpose a large buffer to plot
       it. `frame-major` reads `t·N + i`; `row-major` reads `i·frames + t`. */
    const at = opts.layout === 'row-major'
      ? (i: any) => int(i).mul(int(frames)).add(int(tp))
      : (i: any) => int(tp).mul(int(N)).add(int(i))

    const sizeF = resolveFieldOrNull(opts.size, 'float')
    const valueF = resolveFieldOrNull(opts.values, 'float')
    const mode = opts.sizeMode ?? 'xyz'

    const hasBaseline = opts.baseline != null
    if (hasBaseline && !isParametric(domain)) {
      throw new Error(
        'Glyphs: `baseline` places a glyph at a VALUE, which needs a domain that ' +
        'can be addressed between its samples. Lattice and polar domains can; a mesh cannot.',
      )
    }
    const baseF = typeof opts.baseline === 'number' || opts.baseline == null
      ? null
      : resolveFieldOrNull(opts.baseline, 'float')
    const baseConst = float(typeof opts.baseline === 'number' ? opts.baseline : 0)

    material.positionNode = (Fn as any)(() => {
      const i: any = instanceIndex
      const p: any = positionGeometry
      const s: any = sizeF
        ? float((sizeF.node as any).element(at(i))).mul(this.scale)
        : this.scale

      if (hasBaseline) {
        /* VALUE placement. The glyph's x spans its slot (geometry x is a fraction
           of one) and its y runs from the baseline through `size`, both in the
           domain's own parameters — so on a polar domain a "bar" becomes a radial
           wedge without a line of extra code. */
        const b: any = baseF ? float((baseF.node as any).element(at(i))) : baseConst
        const u: any = float(i).add(float(0.5)).add(p.x).div(float(N))
        const v: any = b.add(p.y.mul(s))
        return (this._domain as ParametricDomain).positionAtUV(u, v)
      }

      // ADDRESS placement — right for a marker, a scatter point, a quiver anchor.
      const base: any = this._domain.positionAt(i)
      const sx: any = mode === 'xyz' || mode === 'x' ? s : float(1)
      const sy: any = mode === 'xyz' || mode === 'y' ? s : float(1)
      const sz: any = mode === 'xyz' || mode === 'z' ? s : float(1)
      return vec3(base.x.add(p.x.mul(sx)), base.y.add(p.y.mul(sy)), base.z.add(p.z.mul(sz)))
    })()

    const solid = opts.color != null ? new Color(opts.color as any) : null
    this._clim = opts.clim ?? [0, 1]
    const [d0, d1] = this._clim
    const span = d1 - d0 || 1

    material.colorNode = (Fn as any)(() => {
      if (solid || !valueF) {
        const c = solid ?? new Color(0xffffff)
        return vec4(vec3(c.r, c.g, c.b), float(opacity))
      }
      const v: any = float((valueF.node as any).element(at(instanceIndex)))
      const n: any = clamp(v.sub(float(d0)).div(float(span)), float(0), float(1))
      const row = colormapRowOrNull(this.effectiveColormap())
      const rgb: any = row === null
        ? vec3(n)
        : (() => { const c = createColormapSampler('default').sample(n, row) as any; return vec3(c.r, c.g, c.b) })()
      return vec4(rgb, float(opacity))
    })()

    this.invalidate()
  }

  /** The domain's extent. A glyph layer does not measure its own — see the
   *  `Surface`/glyph pairing this mirrors. */
  dataBounds(): Bounds { return this._domain.bounds() }

  /** The domain these glyphs sit on. */
  get domain(): Domain { return this._domain }

  protected onClimChanged(): void { /* baked into the colour node */ }

  dispose(): void {
    this._material.dispose()
    super.dispose()   // the GEOMETRY is the caller's, as with `Surface`
  }
}
