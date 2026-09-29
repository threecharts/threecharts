import { Mesh, MeshBasicNodeMaterial, DoubleSide, BufferGeometry, BufferAttribute } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, uv, vec4, vec3, float, floor, clamp, int, uniform, mix, fwidth, smoothstep } from 'three/tsl'
import { Color } from 'three/webgpu'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Limits, Bounds } from './limits'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { zeroCrossingMask } from './contour-node'
import { createVertexMask, type MaskSource, type VertexMask } from './vertex-mask'
import { gridDomain } from './domain/gridDomain'
import { isParametric, type ParametricDomain } from './domain/Domain'
import { resolveField, type FieldSource, type ResolvedField , type Timepoint } from './field/source'

const DEFAULT_MASK_STRENGTH = 0.85
const DEFAULT_MASK_EDGE = '#7ce7c4'
const DEFAULT_MASK_EDGE_WIDTH = 1.5

/** Resolve a colormap NAME → atlas row, or null (→ grayscale). */
/**
 * An `nu × nv` grid of quads with UVs spanning (0,0)→(1,1).
 *
 * **The UVs ARE the domain's parameters**, which is what makes this work: the
 * vertex shader positions each vertex at `positionAtUV(uv.x, uv.y)` and the
 * fragment shader samples the raster at the same `uv`. One attribute, two jobs,
 * and no second coordinate to keep in step.
 *
 * At `nu = nv = 1` this is the two-triangle quad a raster has always been, and on
 * an affine domain that is EXACT — subdividing a straight-to-straight map changes
 * nothing. It is only a curved domain that needs the subdivision, because its
 * edges are arcs and four corners describe a bowtie rather than a ring segment.
 */
function buildRasterGrid(nu: number, nv: number): BufferGeometry {
  const cols = nu + 1, rows = nv + 1
  const pos = new Float32Array(cols * rows * 3)      // written by the position node
  const uvs = new Float32Array(cols * rows * 2)
  for (let r = 0, k = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, k += 2) {
      uvs[k] = c / nu
      uvs[k + 1] = r / nv
    }
  }
  const idx = new Uint32Array(nu * nv * 6)
  for (let r = 0, k = 0; r < nv; r++) {
    for (let c = 0; c < nu; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1
      idx[k++] = a; idx[k++] = b; idx[k++] = e
      idx[k++] = a; idx[k++] = e; idx[k++] = d
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('uv', new BufferAttribute(uvs, 2))
  g.setIndex(new BufferAttribute(idx, 1))
  return g
}

/**
 * A MASK over the image — a `[rows × cols]` field in `0..1`, dimming the raster where
 * it is low and outlining where it crosses a half.
 *
 * The shape is the point: a mask with the image's own dimensions is read at the SAME
 * index, so no resampling, no second extent, and no way for the two to disagree about
 * which cell is which. On a joint spectrum that makes a filter's `g(λ,ω)` — which is
 * `[modes × bins]`, exactly the image's shape — drawable directly over the spectrum it
 * acts on.
 *
 * DIMS rather than tints, and that is deliberate: the raster underneath is already
 * colormapped, so any tint competes with the data's own colours somewhere in the ramp.
 * Scaling luminance leaves the hue alone, so a masked region still reads as the same
 * value, just attenuated — which is what a gain IS.
 */
export interface ImageMask {
  /** `[rows × cols]` values, or an external storage node. Omit for all-ones. */
  values?: MaskSource
  /** How dark a fully-masked cell goes, `0..1`. Default 0.85 — nearly out, but not
   *  black, because a cell reading zero and a cell outside the mask are different
   *  claims and only one of them should look like absence. */
  strength?: number
  /** Outline at the mask's half-crossing — where the filter's band edge is. Default
   *  `#7ce7c4`; `edgeWidth: 0` for none. */
  edgeColor?: string
  edgeWidth?: number
}

export interface ImageOptions {
  /**
   * Subdivisions per axis when covering the domain. Default 1 on an AFFINE domain
   * (a plain lattice), where one quad is exact, and 64 otherwise — a curved
   * domain's edges are arcs, so four corners would draw a bowtie. Raise it if a
   * strongly curved domain still shows facets.
   */
  tessellation?: number
  /**
   * `[rows, cols]` — the DATA's own order, matching how the values are stored
   * (`v[row * cols + col]`).
   *
   * It is a named option rather than two positional numbers because the same two
   * counts also describe the lattice, where they are ordered fastest-axis-first —
   * `[cols, rows]`. Both are correct for different things, and positionally they
   * are indistinguishable. Passing a `GridDomain` instead says it the lattice's
   * way; this says it the array's way; neither can be read as the other.
   */
  shape?: readonly [rows: number, cols: number]
  xExtent?: Limits
  yExtent?: Limits
  /** Value range the buffer's floats span (for the colorbar). Default [0,1]. */
  clim?: Limits
  /** Which slice of the stacked buffer to read. Defaults to the Figure clock's
   *  shared `frameUniform`, so drawables animate in lock-step. Pass a NUMBER for a
   *  static image (a spectrogram, a template) that must not follow the clock. */
  timepoint?: Timepoint
  /** Dim the raster where a same-shaped mask is low — see `ImageMask`. Declare it
   *  (even empty) to keep `setMask` a buffer write rather than a shader rebuild. */
  mask?: ImageMask
}

/**
 * Image — a scalar field drawn as a colormapped raster. It renders ONE slice of a
 * `[frames × rows × cols]` scalar field held in an EXTERNAL GPU storage buffer
 * (arrangement 1: the buffer is owned outside the Figure; the drawable holds a
 * handle). The fragment reads the buffer read-only at `timepoint*rows*cols +
 * row*cols + col` and colormaps it; `timepoint` is a live uniform, so advancing it
 * re-renders the next slice with ZERO re-upload. A STATIC image is just the
 * degenerate case — a 1-slice buffer (or the timepoint uniform pinned to 0); there
 * is no separate "series" primitive. The buffer must live on the Figure's renderer.
 */
export class Image extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  /** The lattice this raster's cells address. Pass it to a glyph layer and the
   *  arrows sit on exactly these cells rather than on a second lattice that agrees
   *  by coincidence. */
  readonly domain: ParametricDomain
  /** The values, however they arrived — a `Float32Array` we copied and own, or a
   *  GPU node someone else produced. `resolveField` is the only place that
   *  difference is decided. */
  private _field: ResolvedField
  private readonly _rows: number
  private readonly _cols: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _tp: any
  private _lastColormap = ''
  private _mask: {
    mask: VertexMask
    strength: any        // eslint-disable-line @typescript-eslint/no-explicit-any
    edgeColor: any       // eslint-disable-line @typescript-eslint/no-explicit-any
    edgeWidth: any       // eslint-disable-line @typescript-eslint/no-explicit-any
  } | null = null

  /**
   * `rows`/`cols` OR a `GridDomain` — the same lattice, said two ways.
   *
   * The domain form is what lets an image and a quiver drawn over it be placed on
   * ONE lattice instead of two that merely happen to agree. Declared separately,
   * `xExtent`/`yExtent` can drift between the layers and the arrows quietly stop
   * sitting on the cells they sample.
   *
   * Shape alone is unambiguous for a raster, so `rows`/`cols` INFERS a domain
   * rather than requiring one — the rule FOUNDATIONS records for the rectilinear
   * case. Note the axis order: a `GridDomain` is first-axis-fastest and an image is
   * row-major, so its shape is `[cols, rows]`.
   */
  constructor(axes: Axes, values: FieldSource, opts: ImageOptions & { shape: readonly [number, number] })
  constructor(axes: Axes, values: FieldSource, domain: ParametricDomain, opts?: ImageOptions)
  constructor(
    axes: Axes,
    values: FieldSource,
    a: ParametricDomain | (ImageOptions & { shape: readonly [number, number] }),
    b?: ImageOptions,
  ) {
    const fromDomain = 'positionAt' in a
    const opts: ImageOptions = (fromDomain ? b : a as ImageOptions) ?? {}
    /* ANY parametric domain, not a `GridDomain` specifically. A raster reads `u` as
       its column and `v` as its row, and a domain that can be addressed
       continuously supplies both — so the same drawable covers a lattice, a polar
       lattice, or a contributed warped grid. Reading `.extents` here is what tied
       it to one implementation, and a polar domain has no such field. */
    const g = a as ParametricDomain & { shape?: readonly number[] }
    const [rows, cols] = fromDomain
      ? [g.shape?.[1] ?? 1, g.shape?.[0] ?? 1]
      : opts.shape!
    const domain = fromDomain
      ? g
      : gridDomain({
          nx: cols, ny: rows,
          x: opts.xExtent ?? [0, cols], y: opts.yExtent ?? [0, rows],
        })
    if (!isParametric(domain)) {
      throw new Error('Image: needs a domain that can be addressed between its samples.')
    }
    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    material.depthTest = false; material.depthWrite = false
    /* An affine domain needs no subdivision — one quad is exact. Anything else
       does, and the default is safe rather than fast, because a domain that does
       not declare itself affine is treated as curved. */
    const tess = Math.max(1, Math.round(
      opts.tessellation ?? (domain.affine ? 1 : 64),
    ))
    const mesh = new Mesh(buildRasterGrid(tess, tess), material)
    /* The `position` attribute is a placeholder — every vertex is placed by the
       position node below — so the bounding sphere three computes from it is a
       point at the origin, and the mesh is culled the moment the camera looks
       anywhere else. Every other drawable that overrides `positionNode` does this;
       a raster only started needing it when it stopped being a literal quad. */
    mesh.frustumCulled = false
    super(axes, mesh)

    /* Every vertex is placed by the DOMAIN, through the same `uv` the fragment
       samples with. On a lattice this reproduces the axis-aligned quad exactly; on
       a polar domain the identical drawable becomes a radial heatmap — which is the
       point of asking the domain rather than computing corners here.

       In the CONSTRUCTOR, not `onUpdate`: placement has nothing to do with the
       colormap, and `onUpdate` early-outs when the colormap is unchanged. Putting
       it there tied the geometry to a guard that exists for the colour node.  */
    material.positionNode = (Fn as any)(() => {
      const u = uv() as any
      return domain.positionAtUV(u.x, u.y)
    })()
    this._material = material
    this._field = resolveField(values, 'float')
    this._rows = rows; this._cols = cols
    this.domain = domain
    this._clim = opts.clim ?? [0, 1]
    // Read the shared Figure clock's frame uniform (or an explicit override).
    this._tp = typeof opts.timepoint === 'number'
      ? (uniform as any)(opts.timepoint)          // static: a fixed slice, off the clock
      : (opts.timepoint ?? axes.figure.clock.frameUniform)
    if (opts.mask) {
      const n = rows * cols
      this._mask = {
        // Allocated even when empty, for the reason the Surface's selection is: a mask
        // appearing later would be a STRUCTURAL change, and rebuilding the shader while
        // a filter parameter is being dragged is the one moment it must not happen.
        mask: createVertexMask(opts.mask.values ?? new Float32Array(n).fill(1), n),
        strength: (uniform as any)(opts.mask.strength ?? DEFAULT_MASK_STRENGTH),
        edgeColor: (uniform as any)(new Color(opts.mask.edgeColor ?? DEFAULT_MASK_EDGE)),
        edgeWidth: (uniform as any)(opts.mask.edgeWidth ?? DEFAULT_MASK_EDGE_WIDTH),
      }
    }
    this.invalidate()
  }

  dataBounds(): Bounds { return this.domain.bounds() }

  /** Retarget the value→colormap range. Live, like `Surface.setClim`. */
  /** BAKED into the colour node — the range appears in the shader, so a change
   *  means rebuilding it. See `Drawable.onClimChanged`. */
  protected onClimChanged(): void { this._lastColormap = '' }

  /**
   * Swap the EXTERNAL data buffer this image reads, keeping the same `rows × cols`
   * shape — the parameter-drag case: a filter response is recomputed on the CPU and
   * uploaded to a fresh GPU buffer every tick (the caller owns disposing the old
   * one), but its shape never changes, only the values.
   *
   * The buffer reference is baked into `colorNode` at `onUpdate()` time, same as the
   * colormap, so forcing `_lastColormap` stale is what makes `setClim` rebuild —
   * this reuses that exact mechanism rather than adding a second dirty flag.
   *
   * Exists so a host can push new data into an already-built Figure instead of
   * disposing and reconstructing it per tick — see `JointSpectrumPanel`'s two-effect
   * split (structural vs data) for the caller.
   */
  setBuffer(values: FieldSource): void {
    this._field.dispose()
    this._field = resolveField(values, 'float')
    this._lastColormap = ''
    this.invalidate()
  }

  /**
   * Rewrite the values in place — a buffer write, not a rebuild.
   *
   * Only when this image OWNS its values (a `Float32Array` was passed). A caller
   * who handed over a GPU node cannot be handed write access to it, because
   * something else produced it and may still be writing it.
   */
  setData(values: Float32Array): void {
    this._field.set(values)
    this.invalidate()
  }

  /** Whether the values can be rewritten with `setData`. */
  get ownsData(): boolean { return this._field.owned }

  /** Replace the mask values — a buffer write, so dragging a filter parameter repaints
   *  without touching the shader. No-op on an image that declared no mask. */
  setMask(values: Float32Array | Uint8Array | null): void {
    if (!this._mask) return
    this._mask.mask.set(values ?? new Float32Array(this._rows * this._cols).fill(1))
  }

  /** Restyle the mask. Uniform writes. */
  setMaskStyle(style: { strength?: number; edgeColor?: string; edgeWidth?: number }): void {
    const m = this._mask
    if (!m) return
    if (style.strength !== undefined) m.strength.value = Math.max(0, Math.min(1, style.strength))
    if (style.edgeColor !== undefined) m.edgeColor.value.set(style.edgeColor)
    if (style.edgeWidth !== undefined) m.edgeWidth.value = Math.max(0, style.edgeWidth)
  }

  protected onUpdate(): void {
    // Rebuild on a colormap OR clim change; the timepoint uniform updates in place.
    const cmap = this.effectiveColormap()
    if (cmap === this._lastColormap) return
    this._lastColormap = cmap
    const row = colormapRowOrNull(cmap)
    const buffer = this._field.node as any
    const rows = this._rows, cols = this._cols, tp = this._tp
    const msk = this._mask
    const mbuf = msk ? (msk.mask.node as any) : null
    const [d0, d1] = this._clim
    const span = d1 - d0 || 1
    this._material.colorNode = (Fn as any)(() => {
      const u = uv() as any
      const col = clamp(floor(u.x.mul(cols)), float(0), float(cols - 1))
      const rw = clamp(floor(u.y.mul(rows)), float(0), float(rows - 1))
      const flat = tp.mul(rows * cols).add(rw.mul(cols)).add(col)
      // Normalize the value through the DOMAIN before sampling. Without this the
      // colormap is indexed by the raw datum, so any field that isn't already in
      // [0,1] renders as two flat colours — everything below 0 at one end,
      // everything above 1 at the other.
      const vn = clamp(buffer.element(int(flat)).sub(d0).div(span), float(0), float(1))
      const base = row === null
        ? vec3(vn, vn, vn)
        : ((createColormapSampler('default').sample(vn, row) as any).xyz)
      if (!msk) return vec4(base, float(1))

      // The mask is read at the image's OWN index — no timepoint, because a filter's
      // gain is a property of the filter and not of the frame.
      const m = mbuf.element(int(rw.mul(cols).add(col)))
      // Scale LUMINANCE, leaving hue alone: a masked cell still reads as the value it
      // is, attenuated — which is what a gain does. `1 - strength` is how dark a fully
      // masked cell goes.
      const dimmed = base.mul(mix(float(1).sub(msk.strength), float(1), m))
      // The band EDGE, at the half-crossing, one fragment wide in screen space.
      const on = smoothstep(float(0), float(0.01), msk.edgeWidth)
      const edge = zeroCrossingMask(m.sub(float(0.5)), fwidth(m), msk.edgeWidth)
      return vec4(mix(dimmed, msk.edgeColor, edge.mul(on)), float(1))
    })()
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    // The quad is built in the constructor (`buildQuad`) and belongs to no one
    // else — unlike `Surface`, whose geometry is the CALLER's (the cortex mesh,
    // shared with other consumers) and therefore deliberately left alone here.
    // Forgetting this is what a tab-switch teardown gate exists to catch: each
    // mount built a fresh quad and each unmount freed the material but not it,
    // so `renderer.info.memory.geometries` climbed by one per cycle with
    // nothing visibly wrong on screen.
    ;(this.node as Mesh).geometry.dispose()
    super.dispose()
  }
}
