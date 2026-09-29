import { Scene, OrthographicCamera, ClippingGroup, Plane, Vector3, DirectionalLight, AmbientLight, type BufferGeometry } from 'three/webgpu'
import { GraphicsObject } from './GraphicsObject'
import { Axis, type AxisScale } from './Axis'
import { AxesOverlay } from './AxesOverlay'
import { AxesCube } from './AxesCube'
import { AxesColorbar } from './AxesColorbar'
import type { Figure, AxesLike } from './Figure'
import type { Drawable } from './Drawable'
import { Image, type ImageOptions } from './Image'
import { Glyphs, type GlyphsOptions } from './Glyphs'
import { Band, type BandOptions } from './Band'
import type { GridDomain } from './domain/gridDomain'
import type { Domain, ParametricDomain } from './domain/Domain'
import type { FieldSource } from './field/source'
import { Slice, type SliceOptions } from './Slice'
import { ClipHelper, type ClipHelperOptions } from './ClipHelper'
import { Labels, type LabelsOptions } from './Labels'
import type { VolumeDims } from './sliceUVW'
import { Volume, type VolumeOptions } from './Volume'
import { Surface, type SurfaceOptions } from './Surface'
import { Quiver, type QuiverOptions } from './Quiver'
import type { LegendEntry } from './AxesLegend'
import { Particles, type ParticlesOptions } from './Particles'
import { Line, type LineOptions } from './Line'
import { Fibers, type FibersOptions } from './Fibers'
import { Arrows, type ArrowsOptions, type ArrowSegment } from './Arrows'
import { unionBounds, expandForMargins, type Limits, type Bounds } from './limits'
import { frameOrthoToLimits, dataToScreen as mapDataToScreen, screenToData as mapScreenToData } from './transform'
import { frameOrthoCube, cubeCenterRadius, DEFAULT_ORBIT, type Orbit, type UpAxis } from './camera3d'
import type { ScaleUnitMode } from './ScaleBar'

type Mode = 'auto' | 'manual'
export type Projection = '2d' | '3d'

/** The screen-fixed chrome an axes draws (2D rulers or the 3D cube). */
interface AxesChrome { redraw(axes: Axes): void; dispose(): void }

/** Extra right-margin px reserved for the colorbar when it's shown. */
export const COLORBAR_RESERVE = 72
/**
 * Extra right-margin px reserved for the SECOND y ruler (`yAxisRight`) when it is shown.
 *
 * Enough for a 5 px mark, an 8 px gap and a tick label — a reserve that cleared only
 * the mark would clip every number on the ruler, which reads as a rendering bug rather
 * than as a margin one.
 */
export const RIGHT_RULER_RESERVE = 44

/**
 * The right margin, given what is shown in it.
 *
 * EXPORTED and used by both callers — `framed()` below, which shrinks the plot box, and
 * `AxesColorbar`, which places itself outboard of whatever precedes it. Two spellings of
 * one offset is how a colorbar gradient comes to sit on top of a hertz label.
 *
 * The two bands are additive because they are different bands: the ruler sits against
 * the plot (its ticks point at the data) and the colorbar outside it.
 */
export function rightMarginPx(base: number, rightRuler: boolean, colorbar: boolean): number {
  return base + (rightRuler ? RIGHT_RULER_RESERVE : 0) + (colorbar ? COLORBAR_RESERVE : 0)
}
/** Extra top-margin px reserved for the per-subplot title when it's set. */
const AXES_TITLE_RESERVE = 20

export interface AxesOptions {
  position?: { left: number; bottom: number; width: number; height: number }
  xlim?: Limits
  ylim?: Limits
  zlim?: Limits
  colormap?: string
  grid?: boolean
  /** '2d' (default) = top-down ortho pan/zoom + flat rulers; '3d' = ortho ORBIT
   *  around the data cube + the projected AxesCube chrome. Drawables are
   *  dimension-agnostic — the same primitive renders under either. */
  projection?: Projection
  /** 3D UP axis / orbit pole — `'y'` (default) or `'z'` (neuroimaging SCS). */
  upAxis?: UpAxis
  /** DATA unit for the 3D scale bar (`'m'` adapts the SI prefix). */
  scaleBarUnit?: string
  /** How a metre-valued scale bar picks its prefix. Default 'adaptive'. */
  scaleBarUnitMode?: ScaleUnitMode
  /** Lock the data-to-pixel scale between the axes — see {@link Axes.dataAspect}. */
  dataAspect?: number | null
}

/**
 * Axes — a plotting region: coordinate frame (limits + rulers), camera (auto =
 * padded camera-to-limits), and host for drawables (in its own scene). Owns its
 * `scene`/`camera`; the Figure renders it into a viewport rect. The rulers +
 * frame render into a screen-fixed `AxesOverlay` (not the GPU scene).
 */
export class Axes extends GraphicsObject implements AxesLike {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera()
  readonly xAxis = new Axis('x')
  readonly yAxis = new Axis('y')
  /**
   * A SECOND y ruler, drawn on the right — MATLAB's `yyaxis right`.
   *
   * It shares the y COORDINATE with `yAxis` and differs only in ticks and format, which
   * is what a lane chart needs: one set of rows reading as channels on the left and as
   * hertz on the right. It is NOT a second data axis — nothing plots against it, and
   * giving it its own limits would let a reader take a value off a ruler no drawable
   * used.
   */
  readonly yAxisRight = new Axis('y')
  /** Off by default: a visible ruler reserves margin, and no existing axes wants one. */
  yAxisRightVisible = false
  readonly zAxis = new Axis('z')
  /** '2d' | '3d' — set once at construction. Selects the camera framing,
   *  interaction, and chrome; drawables don't branch on it. */
  readonly projection: Projection
  /** 3D orbit state (az/el/zoom). Mutated by `attachOrbit`; read by `syncFrame`
   *  to frame the camera each render. Unused in 2D. */
  orbit: Orbit = { ...DEFAULT_ORBIT }
  position: { left: number; bottom: number; width: number; height: number }
  /** Fixed-PIXEL margins reserved for the chrome. ASYMMETRIC: the ticks + titles
   *  live on the LEFT (y) and BOTTOM (x), so those sides reserve real room; the
   *  label-free TOP/RIGHT reserve only enough for the last tick label's overflow
   *  (so it isn't clipped). This keeps adjacent subplots from doubling a full
   *  margin on their shared edge. (The colorbar adds COLORBAR_RESERVE to the right
   *  on demand — see `framed()`.) */
  margins = { top: 16, right: 18, bottom: 44, left: 52 }
  /** Per-subplot title (MATLAB `title`), drawn top-center above the frame. Empty →
   *  no title and no reserved space (title-less subplots stay tight). */
  title = ''
  /** Toggle the title without losing its text; when false it's hidden and reserves
   *  no space (same as an empty title). */
  titleVisible = true
  grid: boolean
  /** Frame rectangle (the axes "box") visibility. In 2D this is the plot frame and
   *  defaults ON; in 3D it is the bare bounding-box wireframe (no ticks, no labels) and
   *  defaults OFF — an opt-in spatial reference, since the adaptive scale bar is the
   *  informative chrome for 3D data whose absolute coordinates are arbitrary. */
  box = true
  /** UP axis = the orbit pole and the direction that reads as up on screen. `'y'` is
   *  generic three.js; `'z'` is the neuroimaging convention (Brainstorm SCS, +Z superior)
   *  used by the app's `ManifoldViewport`. Settable by a parent (the app) at any time —
   *  it is read every frame. Only the CAMERA changes; data is never rotated. 3D only. */
  upAxis: UpAxis = 'y'
  /** Adaptive physical SCALE BAR visibility (3D). Defaults ON for `projection:'3d'`,
   *  replacing the numeric axis ticks. */
  scaleBar = false
  /** The DATA unit the scale bar labels. `'m'` ADAPTS the SI prefix to the magnitude
   *  (5 cm rather than 0.05 m); any other string is shown as-is; `''` = unitless. */
  scaleBarUnit = ''
  scaleBarUnitMode: ScaleUnitMode = 'adaptive'
  /** Colorbar illustration visibility. When on, the Axes reserves extra right
   *  margin (`COLORBAR_RESERVE`) and the colorbar renders in that band. */
  colorbar = false
  /** Optional PLAYHEAD cursor for a 2D axes: a provider returning the data-x to mark
   *  with a vertical line (or null to hide). Evaluated by the overlay every frame, so a
   *  host can bind it to the clock — `axes.cursorX = () => clock.position` — and the
   *  cursor sweeps the traces in lock-step with an animation, no per-frame host code. */
  cursorX: (() => number | null) | null = null

  /**
   * LOCK the data-to-pixel scale between the two axes (2D only). `null` (the
   * default) leaves them independent — the limits stretch to fill whatever
   * viewport the layout gives, which is right for a plot whose axes are a
   * coordinate SYSTEM (seconds against volts) and wrong for one that is a
   * PICTURE.
   *
   * The value is x-units-per-pixel ÷ y-units-per-pixel, so **1 means one data
   * unit covers the same number of pixels on both axes** — an MRI section in
   * millimetres, a map, anything where a circle must render as a circle. A
   * non-1 value states a deliberate ratio between two differently-scaled
   * quantities.
   *
   * It FITS, never crops: the axis with more data per pixel sets the scale and
   * the other is WIDENED around its midpoint, so the whole of the data box stays
   * visible with background either side. Cropping would be the alternative, and
   * it would mean a window resize could hide anatomy — a picture that quietly
   * loses its edges is worse than one with a margin.
   *
   * It changes only what the CAMERA sees, never `xlim`/`ylim`. That is what lets
   * it compose with `attachPanZoom`'s `bounds`: the reader's zoom state stays a
   * plain data range that can be clamped to the data's real edge, and the lock is
   * re-derived from the live viewport on every frame — so it survives a resize
   * with no listener and no state.
   */
  dataAspect: number | null = null

  /** Data-space clipping planes = the axis box (unpadded limits). Carried by the
   *  Axes' node (a `ClippingGroup`), so every drawable under it clips to the box
   *  (the WebGPU renderer honors ClippingGroup planes, NOT `material.clippingPlanes`).
   *  `syncFrame` keeps the constants in step with the limits so panned/zoomed data
   *  outside the box is hidden — the pad margin (ticks/labels) shows no data. Kept
   *  `x∈[xlo,xhi]`, `y∈[ylo,yhi]`: a fragment survives only inside ALL four. */
  readonly clipPlanes: Plane[] = [
    new Plane(new Vector3(1, 0, 0), 0),   // x ≥ xlo  → constant = -xlo
    new Plane(new Vector3(-1, 0, 0), 0),  // x ≤ xhi  → constant =  xhi
    new Plane(new Vector3(0, 1, 0), 0),   // y ≥ ylo  → constant = -ylo
    new Plane(new Vector3(0, -1, 0), 0),  // y ≤ yhi  → constant =  yhi
  ]

  private _colormap: string
  private _drawables: Drawable[] = []
  private _xdata: Limits = [0, 1]
  private _ydata: Limits = [0, 1]
  private _zdata: Limits = [0, 1]
  private _xmode: Mode = 'auto'
  private _ymode: Mode = 'auto'
  private _zmode: Mode = 'auto'
  private _lastLimKey = ''
  private chrome: AxesChrome
  private colorbarOverlay: AxesColorbar

  private _light: DirectionalLight | null = null   // key
  private _fill: DirectionalLight | null = null    // fill

  constructor(readonly figure: Figure, opts: AxesOptions = {}) {
    super(new ClippingGroup())
    this.projection = opts.projection ?? '2d'
    // 2D clips descendants to the data box (the 4 axis-aligned planes). 3D does not
    // box-clip — the whole cube is in view — so leave the group's planes empty.
    if (this.projection === '2d') (this.node as ClippingGroup).clippingPlanes = this.clipPlanes
    this.scene.add(this.node)                 // drawables (children → this.node) render in this scene
    this.position = opts.position ?? { left: 0, bottom: 0, width: 1, height: 1 }
    this._colormap = opts.colormap ?? figure.colormap
    this.grid = opts.grid ?? false
    if (opts.xlim) { this._xdata = opts.xlim; this._xmode = 'manual' }
    if (opts.ylim) { this._ydata = opts.ylim; this._ymode = 'manual' }
    if (opts.zlim) { this._zdata = opts.zlim; this._zmode = 'manual' }
    this.chrome = this.projection === '3d' ? new AxesCube(figure.container) : new AxesOverlay(figure.container)
    if (this.projection === '3d') {
      this.box = false; this.scaleBar = true          // the scale bar replaces the ticks…
      this.margins = { top: 12, right: 12, bottom: 12, left: 12 }   // …so reclaim the ruler margins
    }
    if (opts.dataAspect !== undefined) this.dataAspect = opts.dataAspect
    if (opts.upAxis) this.upAxis = opts.upAxis
    if (opts.scaleBarUnit !== undefined) this.scaleBarUnit = opts.scaleBarUnit
    if (opts.scaleBarUnitMode !== undefined) this.scaleBarUnitMode = opts.scaleBarUnitMode
    this.colorbarOverlay = new AxesColorbar(figure.container)
    if (this.projection === '3d') {
      // A camera-TRACKING key+fill rig (+ ambient) so lit drawables (Surface) read the
      // folds with form, not the flat look of a pure headlight. Both directionals are
      // offset from the eye along the camera basis and re-aimed each frame in syncFrame.
      this._light = new DirectionalLight(0xffffff, 1.7)   // key — up/right of the eye
      this._fill = new DirectionalLight(0xffffff, 0.7)    // fill — lower/left, softer
      this.scene.add(this._light, this._fill)
      this.scene.add(new AmbientLight(0xffffff, 0.5))
    }
  }

  /**
   * What the LEGEND states, one entry per VISIBLE layer that encodes by colour.
   *
   * Asked of the drawables themselves, in draw order, and rebuilt every frame from
   * their LIVE state — so switching the cortex scalar relabels the panel in the same
   * frame, and hiding a layer removes its key in the same frame. It used to read one
   * remembered `Surface`, which meant the panel could only ever describe one layer and
   * went on describing it after the layer was hidden.
   */
  legendEntries(): LegendEntry[] {
    const out: LegendEntry[] = []
    for (const d of this._drawables) {
      const e = d.legendEntry()
      if (e) out.push(e)
    }
    return out
  }

  /** The value range the colorbar maps — the first Image's value range, or [0,1]. */
  colorbarClim(): Limits {
    for (const d of this._drawables) if (d instanceof Image) return d.clim()
    return [0, 1]
  }

  // ── limits ──
  get xlim(): Limits { return this._xdata }
  set xlim(v: Limits) { this._xdata = v; this._xmode = 'manual'; this.invalidate() }
  get ylim(): Limits { return this._ydata }
  set ylim(v: Limits) { this._ydata = v; this._ymode = 'manual'; this.invalidate() }
  get zlim(): Limits { return this._zdata }
  set zlim(v: Limits) { this._zdata = v; this._zmode = 'manual'; this.invalidate() }
  get xLimMode(): Mode { return this._xmode }
  set xLimMode(m: Mode) { this._xmode = m; this.invalidate() }
  get yLimMode(): Mode { return this._ymode }
  set yLimMode(m: Mode) { this._ymode = m; this.invalidate() }
  get zLimMode(): Mode { return this._zmode }
  set zLimMode(m: Mode) { this._zmode = m; this.invalidate() }

  /** Reset the 3D view to the default orbit + auto limits (the double-click / autoscale
   *  action for a 3D axes). */
  resetView(): void {
    this.orbit = { ...DEFAULT_ORBIT }
    this._xmode = 'auto'; this._ymode = 'auto'; this._zmode = 'auto'
    this.invalidate()
  }

  /** Colormap shared by all images + the colorbar (axes-level). Changing it
   *  invalidates the drawables so they rebuild their color node. */
  get colormap(): string { return this._colormap }
  set colormap(v: string) { this._colormap = v; for (const d of this._drawables) d.invalidate() }

  dataLimits(): { xlim: Limits; ylim: Limits } { return { xlim: this._xdata, ylim: this._ydata } }

  // ── plotting functions ──
  /** Add an Image (colormapped raster) backed by an external GPU storage buffer.
   *  A `[frames × rows × cols]` stack; the current slice is read at `opts.timepoint`
   *  (defaults to the Figure clock). A static image is a 1-slice buffer. */
  image(values: FieldSource, opts: ImageOptions & { shape: readonly [number, number] }): Image
  image(values: FieldSource, domain: ParametricDomain, opts?: ImageOptions): Image
  image(values: FieldSource, a: ParametricDomain | (ImageOptions & { shape: readonly [number, number] }), b?: ImageOptions): Image {
    return this.addDrawable(
      'positionAt' in a
        ? new Image(this, values, a as ParametricDomain, b)
        : new Image(this, values, a as ImageOptions & { shape: readonly [number, number] }),
    )
  }
  /** Add a Volume (raymarched colormapped scalar field — the 3D Image) backed by an
   *  external GPU storage buffer. A `[frames × D × H × W]` stack; the current volume is
   *  read at `opts.timepoint` (defaults to the Figure clock). Use in a `projection:'3d'`
   *  axes. */
  /**
   * One plane of a 3D volume, sampling a `Data3DTexture`. Three of these on
   * three axes, under one crosshair, is what an MRI viewer is made of — where
   * `volume()` is the raymarch, which answers a different question.
   */
  slice(texture: unknown, dims: VolumeDims, opts?: SliceOptions): Slice {
    return this.addDrawable(new Slice(this, texture as never, dims, opts))
  }

  /**
   * Short text pinned to points in 3D, always facing the camera — one instanced
   * draw over one atlas, not an object per label.
   *
   * Sized in PIXELS rather than data units, because text must be. The cost is
   * fill rather than geometry, so how many labels a host asks for is a
   * performance decision — see `Labels`.
   */
  labels(anchors: Float32Array, texts: readonly string[], opts?: LabelsOptions): Labels {
    return this.addDrawable(new Labels(this, anchors, texts, opts))
  }

  volume(values: FieldSource, opts: VolumeOptions & { shape: readonly [number, number, number] }): Volume
  volume(values: FieldSource, domain: GridDomain, opts?: VolumeOptions): Volume
  volume(values: FieldSource, a: GridDomain | (VolumeOptions & { shape: readonly [number, number, number] }), b?: VolumeOptions): Volume {
    return this.addDrawable(
      'positionAt' in a
        ? new Volume(this, values, a as GridDomain, b)
        : new Volume(this, values, a as VolumeOptions & { shape: readonly [number, number, number] }),
    )
  }
  /** Add a Surface — a lit triangulated mesh (the cortical surface) colored by a
   *  per-vertex scalar from an external GPU storage buffer (the manifold Image). The
   *  caller owns the `geometry` (positions/indices/normals). Use in a `projection:'3d'`
   *  axes; the mesh's vertices are the coordinate system. */
  /** Draw WHERE the given clipping planes are — see {@link ClipHelper}. */
  clipHelper(planes: readonly Plane[], opts?: ClipHelperOptions): ClipHelper {
    return this.addDrawable(new ClipHelper(this, planes, opts))
  }

  surface(geometry: BufferGeometry, opts?: SurfaceOptions): Surface {
    const s = this.addDrawable(new Surface(this, geometry, opts))
    // ADOPT the mesh's frame. A surface is this axes' coordinate system, so it is
    // the authority on which way is up, and saying it once on the geometry beats
    // making every call site remember to configure the camera to match its data.
    // Only ever a promotion to 'z': a second, y-up surface in the same axes must
    // not silently un-rotate a camera the cortex already set.
    if (s.upAxis === 'z') this.upAxis = 'z'
    return s
  }
  /** Add a Fibers bundle (tractography polylines) — `[nFibers × nPoints × 3]` points as an
   *  indexed LineSegments. Like Surface it is a COORDINATE SYSTEM: a neutral structural
   *  color by default, with an optional per-fiber scalar FIELD → colormap. Use in a
   *  `projection:'3d'` axes. */
  fibers(points: Float32Array, nPoints: number, opts?: FibersOptions): Fibers {
    return this.addDrawable(new Fibers(this, points, nPoints, opts))
  }
  /** Add oriented 3-D arrow segments (real shaft + arrowhead geometry, lit) — one
   *  instance per `{from, to}` pair, e.g. linked-track segments. The real-geometry
   *  answer to `Fibers`' 1px `LineSegments`: GPU line rasterisation ignores
   *  `linewidth`, so width needs actual triangles. `meshRadius` scales the default
   *  radius the same mesh-relative way `SignMarkers.setScale` does. Use in a
   *  `projection:'3d'` axes. */
  arrows(segments: readonly ArrowSegment[], meshRadius: number, opts?: ArrowsOptions): Arrows {
    return this.addDrawable(new Arrows(this, segments, meshRadius, opts))
  }
  /** Add a vector field (arrow glyphs) backed by an external GPU storage buffer. */
  quiver(vectors: FieldSource, rows: number, cols: number, opts?: QuiverOptions): Quiver {
    return this.addDrawable(new Quiver(this, vectors, rows, cols, opts))
  }

  particles(positions: FieldSource, count: number, opts?: ParticlesOptions): Particles {
    return this.addDrawable(new Particles(this, positions, count, opts))
  }
  /**
   * One copy of `geometry` at every address of `domain`, scaled and coloured by
   * fields — the general form of a mark. A unit quad makes a bar chart; a disc
   * makes a scatter; a box makes a box plot.
   */
  glyphs(geometry: BufferGeometry, domain: Domain, opts?: GlyphsOptions): Glyphs {
    return this.addDrawable(new Glyphs(this, geometry, domain, opts))
  }

  /**
   * The region between two boundary fields — an area, a violin, one layer of a
   * streamgraph, one channel's ridgeline fill. Needs a domain that can be
   * addressed between its samples; a mesh cannot and is rejected.
   */
  band(domain: Domain, upper: FieldSource, opts?: BandOptions): Band {
    return this.addDrawable(new Band(this, domain, upper, opts))
  }

  /** Add a Line (fat polyline) to this axes. */
  /** Add a batch of polylines backed by an external GPU storage buffer. A
   *  `[frames × channels × samples]` y-field; each channel is a line, the current
   *  slice is read at `opts.timepoint` (defaults to the Figure clock). */
  /** Log-scale a ruler: `axes.setScale('y', 'log')`. The axis LIMITS and any
   *  drawable's plotted positions are then `log10(value)` — drawables reading a
   *  raw buffer take a flag for it (`Line`'s `logY`); the ruler labels the ticks
   *  back as values. */
  setScale(dim: 'x' | 'y', scale: AxisScale): this {
    ;(dim === 'x' ? this.xAxis : this.yAxis).scale = scale
    this.invalidate()
    return this
  }

  line(values: FieldSource, channels: number, samples: number, opts?: LineOptions): Line {
    return this.addDrawable(new Line(this, values, channels, samples, opts))
  }

  /** CSS-px viewport rect within the figure container (origin top-left). */
  viewportPx(): { left: number; top: number; w: number; h: number } {
    const cw = this.figure.container.clientWidth || 600
    const ch0 = this.figure.container.clientHeight || 400
    const inset = this.figure.topInsetPx()   // figure super-title band reserved at the top
    const ch = ch0 - inset
    const p = this.position
    return { left: p.left * cw, top: inset + (1 - p.bottom - p.height) * ch, w: p.width * cw, h: p.height * ch }
  }

  /** The data limits expanded to reserve the fixed-pixel chrome margins (so the
   *  data frame is inset by `margins`). Shared by the camera + the overlay so the
   *  GPU render and the SVG chrome agree. */
  private framed(): { fx: Limits; fy: Limits; w: number; h: number } {
    const { w, h } = this.viewportPx()
    const m = this.margins
    const right = rightMarginPx(m.right, this.yAxisRightVisible, this.colorbar)
    const top = m.top + (this.title && this.titleVisible ? AXES_TITLE_RESERVE : 0)   // reserve the title band
    // The lock works in PLOT-BOX px — the region the data box actually occupies
    // — because that is where equal-scale has to hold. Applying it to the whole
    // viewport would bake the asymmetric ruler margins (52 left, 18 right) into
    // the ratio and leave the picture slightly stretched anyway.
    const [dx, dy] = this.aspectFitted(w - m.left - right, h - m.bottom - top)
    return {
      w, h,
      fx: expandForMargins(dx, m.left / w, right / w),
      fy: expandForMargins(dy, m.bottom / h, top / h),
    }
  }

  /**
   * The data limits WIDENED so `dataAspect` holds against a `pw × ph` plot box.
   *
   * Returns the limits untouched when there is no lock, in 3D (`syncFrame3D`
   * aspect-corrects the cube itself), or when either span is degenerate — a
   * zero-width axis has no scale to match and the caller's own guards are
   * downstream of this.
   */
  private aspectFitted(pw: number, ph: number): [Limits, Limits] {
    const a = this.dataAspect
    if (a === null || !(a > 0) || this.projection === '3d') return [this._xdata, this._ydata]
    const xs = this._xdata[1] - this._xdata[0]
    const ys = this._ydata[1] - this._ydata[0]
    if (!(pw > 0) || !(ph > 0) || !(xs > 0) || !(ys > 0)) return [this._xdata, this._ydata]
    // Units per pixel on each axis; the LARGER wins, which is what makes this a
    // fit rather than a crop — the axis that needs more room sets the scale.
    const sy = Math.max(ys / ph, (xs / pw) / a)
    const grow = ([lo, hi]: Limits, span: number): Limits => {
      const mid = (lo + hi) / 2
      return [mid - span / 2, mid + span / 2]
    }
    return [grow(this._xdata, sy * a * pw), grow(this._ydata, sy * ph)]
  }

  /** Data coords → viewport px (through the framed camera frustum, matching the GPU render). */
  dataToScreen(x: number, y: number): [number, number] {
    const { fx, fy, w, h } = this.framed()
    return mapDataToScreen(fx, fy, { w, h }, x, y)
  }

  /** Viewport px → data coords (inverse of {@link dataToScreen}). */
  screenToData(px: number, py: number): [number, number] {
    const { fx, fy, w, h } = this.framed()
    return mapScreenToData(fx, fy, { w, h }, px, py)
  }

  /** The plot box (the data-limits region, inset by the pad) in viewport CSS px
   *  (origin top-left). Drawables are clipped to this so out-of-bounds data is
   *  hidden rather than spilling over the ticks/labels. */
  plotBoxPx(): { left: number; top: number; w: number; h: number } {
    const [lx, by] = this.dataToScreen(this._xdata[0], this._ydata[0])   // bottom-left
    const [rx, ty] = this.dataToScreen(this._xdata[1], this._ydata[1])   // top-right
    return { left: lx, top: ty, w: rx - lx, h: by - ty }
  }

  // ── drawables ──
  get drawables(): readonly Drawable[] { return this._drawables }
  /** Register a drawable (used by the plotting functions `image`/`line`). Draw
   *  order = insertion order: later drawables stack on top (renderOrder, since 2D
   *  drawables disable depth to avoid z-fighting on the shared z=0 plane). */
  addDrawable<D extends Drawable>(d: D): D {
    d.node.renderOrder = this._drawables.length
    this.add(d); this._drawables.push(d); this.invalidate(); return d
  }

  /**
   * Drop a drawable and free it — the inverse of `addDrawable`.
   *
   * `dispose()` alone detaches the node but leaves the entry in `_drawables`, where
   * it goes on contributing to `auto` limits and to the draw order. That is the
   * difference this method exists for: a LAYER that comes and goes (rebound to a new
   * buffer, toggled off for good) has to leave the list, while a layer merely hidden
   * should stay in it. Silently ignores a drawable that is not ours.
   */
  removeDrawable(d: Drawable): void {
    const i = this._drawables.indexOf(d)
    if (i < 0) return
    this._drawables.splice(i, 1)
    d.dispose()
    // Draw order IS the index, so the survivors have to be renumbered or a later
    // insertion collides with a stale renderOrder.
    this._drawables.forEach((x, k) => { x.node.renderOrder = k })
    this.invalidate()
  }

  // ── per-frame (AxesLike) ──
  syncFrame(): void {
    // Auto-limits: union the drawables' data extents (incl. z in 3D).
    if (this._xmode === 'auto' || this._ymode === 'auto' || this._zmode === 'auto') {
      const b = unionBounds(this._drawables.map((d) => d.dataBounds()).filter((x): x is Bounds => x != null))
      if (b) {
        if (this._xmode === 'auto') this._xdata = b.xlim
        if (this._ymode === 'auto') this._ydata = b.ylim
        if (this._zmode === 'auto' && b.zlim) this._zdata = b.zlim
      }
    }
    this.xAxis.limits = this._xdata
    this.yAxis.limits = this._ydata
    /* THE SAME COORDINATE — see `yAxisRight`. An unsynced second axis keeps its [0,1]
       default and labels rows nobody is looking at, which draws as a plausible ruler. */
    this.yAxisRight.limits = this._ydata
    this.zAxis.limits = this._zdata

    if (this.projection === '3d') { this.syncFrame3D(); return }

    const { fx, fy } = this.framed()
    frameOrthoToLimits(this.camera, fx, fy)
    // Keep the clip box on the (unpadded) data limits.
    this.clipPlanes[0].constant = -this._xdata[0]
    this.clipPlanes[1].constant = this._xdata[1]
    this.clipPlanes[2].constant = -this._ydata[0]
    this.clipPlanes[3].constant = this._ydata[1]
    // On any limit change, rebuild CPU-clipped drawables (lines) so they re-clip
    // to the new box. Mesh drawables (Image) clip on the GPU and are untouched.
    const key = `${this._xdata[0]},${this._xdata[1]},${this._ydata[0]},${this._ydata[1]}`
    if (key !== this._lastLimKey) {
      this._lastLimKey = key
      for (const d of this._drawables) if (d.reactsToLimits) d.invalidate()
    }
  }

  /** 3D framing: orbit the ortho camera around the data cube, aspect-corrected to the
   *  viewport, and aim the headlight down the view direction. */
  private syncFrame3D(): void {
    const { w, h } = this.viewportPx()
    const center = cubeCenterRadius(this._xdata, this._ydata, this._zdata)
    frameOrthoCube(this.camera, center, this.orbit, (w || 1) / (h || 1), this.upAxis)
    if (this._light && this._fill) {
      // Re-aim the rig from the camera basis (right/up), so key/fill track the orbit
      // and keep consistent form as the surface spins.
      const r = new Vector3(), u = new Vector3(), f = new Vector3()
      this.camera.matrixWorld.extractBasis(r, u, f)
      const R = center.radius, C = new Vector3(center.cx, center.cy, center.cz)
      this._light.position.copy(this.camera.position).addScaledVector(r, R).addScaledVector(u, R)
      this._light.target.position.copy(C); this._light.target.updateMatrixWorld()
      this._fill.position.copy(this.camera.position).addScaledVector(r, -R * 1.3).addScaledVector(u, -R * 0.5)
      this._fill.target.position.copy(C); this._fill.target.updateMatrixWorld()
    }
  }

  overlayRedraw(): void { this.chrome.redraw(this); this.colorbarOverlay.redraw(this) }

  /**
   * Tear down the whole axes: its screen-fixed chrome, its colorbar overlay, and
   * every drawable it still holds — EXPLICITLY, not as a side effect of the
   * generic `GraphicsObject` child walk `super.dispose()` performs.
   *
   * Before this, `_drawables` was never touched here at all: `super.dispose()`
   * happens to reach the same objects (`addDrawable` parents a drawable via
   * `this.add()`, so it is also a `GraphicsObject` CHILD, and the child walk
   * disposes it) — but that is coincidental, not a stated contract, and nothing
   * cleared `_drawables` itself, so a still-referenced Axes went on reporting its
   * disposed drawables from `drawables`/`legendEntries`/`colorbarClim`. Disposing
   * through `_drawables` first — the same list `removeDrawable` maintains — makes
   * this axes' bookkeeping authoritative regardless of how `GraphicsObject` chooses
   * to walk children, and `removeDrawable` is now the ONLY other path that can
   * shrink the list, exactly mirroring `Figure.removeAxes`/`Figure.dispose` for
   * the axes list one level up.
   *
   * Each drawable's own `dispose()` already detaches itself from `_children` (via
   * `GraphicsObject.dispose`'s `parent.remove(this)`), so by the time `super.
   * dispose()` runs its own child walk there is nothing left to iterate — no
   * double-dispose.
   */
  dispose(): void {
    this.chrome.dispose()
    this.colorbarOverlay.dispose()
    for (const d of [...this._drawables]) d.dispose()
    this._drawables = []
    super.dispose()
  }
}
