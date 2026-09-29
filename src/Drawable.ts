import type { Object3D, Plane, ClippingGroup } from 'three/webgpu'
import { GraphicsObject } from './GraphicsObject'
import type { Bounds, Limits } from './limits'
import type { Axes } from './Axes'
import type { LegendEntry } from './AxesLegend'

/**
 * Drawable — base for the data primitives (`Image`, `Line`, …). A subtype of
 * `GraphicsObject`, parented to an `Axes`, holding data in DATA coordinates. Its
 * `dataBounds()` feeds the axes' `auto` limits.
 */
export abstract class Drawable extends GraphicsObject {
  private _name = ''
  private _colormap: string | null = null

  constructor(readonly axes: Axes, node: Object3D) { super(node) }

  get name(): string { return this._name }
  set name(v: string) { this._name = v; this.invalidate() }

  /** Per-drawable colormap OVERRIDE. `null` (default) inherits the Axes colormap, so
   *  layered drawables on one Axes share the axes default; set it to give this drawable
   *  its own colormap independently (e.g. an Image + a Line, or the cortex Surface +
   *  Particles + Quiver, each colormapped differently). Colormapped drawables resolve
   *  `effectiveColormap()` in their `onUpdate`. */
  get colormap(): string | null { return this._colormap }
  set colormap(v: string | null) { this._colormap = v; this.invalidate() }
  /** The colormap this drawable renders with — its own override, else the Axes default. */
  protected effectiveColormap(): string { return this._colormap ?? this.axes.colormap }

  /** True if this drawable must rebuild when the axes limits change (i.e. it
   *  clips itself on the CPU rather than via the axes' GPU `ClippingGroup`).
   *  The Axes invalidates such drawables in `syncFrame` on any limit change.
   *  Mesh drawables (Image) return false — the ClippingGroup clips them. */
  get reactsToLimits(): boolean { return false }

  /** The planes this drawable declared, captured the first time the cut is
   *  toggled — see `setClipEnabled`. */
  private _clipPlanes: Plane[] | null = null

  /**
   * Turn this drawable's DECLARED clip planes on or off.
   *
   * A write on the drawable's own `ClippingGroup`, never a rebuild: the group is
   * read every frame, so emptying its plane array un-cuts the drawable without
   * touching the figure the reader is looking at. That is the whole reason a
   * drawable that may ever be clipped declares `clip: []` at construction —
   * adding the group later would be a structural change mid-view.
   *
   * A no-op on a drawable that declared no planes; there is nothing to turn on.
   */
  setClipEnabled(on: boolean): void {
    const g = this.clipGroup()
    if (!g) return
    if (this._clipPlanes === null) this._clipPlanes = g.clippingPlanes as Plane[]
    g.clippingPlanes = on ? this._clipPlanes : []
    this.invalidate()
  }

  /**
   * Set WHICH declared planes cut and HOW they combine — both live writes.
   *
   * `intersection: false` (the default) is UNION: a fragment is cut if ANY plane
   * cuts it, which with one plane is a half-cut. `true` keeps only what EVERY
   * plane cuts, so three planes remove the one octant they share — the corner
   * notch of three.js's own `webgl_clipping_intersection`.
   *
   * An EMPTY array is "no clipping" under either mode, so this is also how a cut
   * is turned off. (Vacuous truth does not bite: three generates no clipping node
   * at all when the plane count is zero.)
   */
  setClip(planes: readonly Plane[] | null, intersection = false): void {
    const g = this.clipGroup()
    if (!g) return
    g.clippingPlanes = (planes ?? []) as Plane[]
    g.clipIntersection = intersection
    this.invalidate()
  }

  /** This drawable's own clipping group, or null when it declared no planes. */
  private clipGroup(): ClippingGroup | null {
    const g = this.node as ClippingGroup
    return (g as unknown as { isClippingGroup?: boolean }).isClippingGroup ? g : null
  }

  /* ── The colormapped-field concern ──────────────────────────────────────────
     Eight drawables carried their own copy of this: a `_clim`, a `clim()`, a
     `setClim` whose body was byte-identical between `Line` and `Particles`, and a
     `legend`. It lives here because `Drawable` already owns the other half — the
     `colormap` override above — and splitting one concern across two levels is
     what let `Volume` and `Fibers` end up with a range nothing could retarget. */

  protected _clim: Limits = [0, 1]

  /** The value range this drawable's colours key to — what a colorbar or a legend
   *  entry is labelled with. */
  clim(): Limits { return this._clim }

  /**
   * Retarget the value range.
   *
   * The EARLY-OUT is not a micro-optimisation. An auto-clim that tracks the data
   * writes this on every frame the cursor moves, and for a drawable that bakes the
   * range into its colour node an unchanged value would mean a shader rebuild
   * mid-drag — the one moment it must not happen.
   */
  setClim(c: Limits): void {
    if (c[0] === this._clim[0] && c[1] === this._clim[1]) return
    this._clim = c
    this.onClimChanged()
    this.invalidate()
  }

  /**
   * How this drawable takes a new range — and there are exactly two answers.
   *
   * A range BAKED INTO the colour node needs that node rebuilt, which subclasses
   * signal by clearing their `_lastColormap` guard. A range held in a UNIFORM is a
   * buffer write and must NOT rebuild: that is what lets a clim follow the time
   * cursor at no cost, and it is why `Surface` and `Slice` differ from `Image` and
   * `Line` here rather than by accident.
   *
   * The default does neither, which is right for a drawable whose colours do not
   * depend on the range at all.
   */
  protected onClimChanged(): void {}

  /**
   * What this layer calls itself in a legend, or null to go unnamed.
   *
   * MUTABLE: a host that relabels the field relabels the key in the same frame.
   * Naming is the HOST's business — a drawable knows a buffer and a range, never a
   * quantity — so this stays empty unless something says otherwise.
   */
  legend: { title: string; unit: string } | null = null

  /** Data extent in data coords, or null if empty. */
  abstract dataBounds(): Bounds | null

  /**
   * What this layer states in the legend, or null for nothing.
   *
   * NULL WHEN THE LAYER IS NOT SHOWING, which is the point of putting it here: a key
   * for a layer you cannot see is a key to a picture that is not on screen. Each
   * subtype decides what "showing" means for it — `visible` for most, and for a
   * `Surface` also its opacity, since the app hides the cortex by fading it rather
   * than by removing it (the glyphs sit on it and are depth-tested against it).
   *
   * Default: nothing. A layer that encodes by colour overrides.
   */
  legendEntry(): LegendEntry | null { return null }
}
