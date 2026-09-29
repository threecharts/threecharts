import { LineSegments, LineBasicNodeMaterial, BufferGeometry, BufferAttribute, StorageBufferAttribute, AdditiveBlending, NormalBlending, Color } from 'three/webgpu'
import type { Timepoint } from './field/source'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, attribute, storage, vec3, vec4, float, clamp, int, uniform } from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Limits, Bounds } from './limits'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'

/** Resolve a colormap NAME → atlas row, or null (→ grayscale). */
/** How the bundle is colored: a neutral structural color, or a scalar FIELD → colormap. */
export type FiberColorMode = 'neutral' | 'field'

/** Segment endpoint-pair indices for LineSegments — fiber `f` included iff
 *  `f % stride === 0`; each kept fiber contributes nPoints-1 segments (density lives
 *  entirely in the index, so changing it never rebuilds the geometry). */
function buildFiberIndex(nPoints: number, nFibers: number, stride: number): Uint32Array {
  const s = Math.max(1, Math.floor(stride))
  let kept = 0
  for (let f = 0; f < nFibers; f += s) kept++
  const segs = Math.max(0, nPoints - 1)
  const index = new Uint32Array(kept * segs * 2)
  let w = 0
  for (let f = 0; f < nFibers; f += s) {
    const base = f * nPoints
    for (let p = 0; p < nPoints - 1; p++) { index[w++] = base + p; index[w++] = base + p + 1 }
  }
  return index
}

/** density (0..1) → integer stride. */
function densityToStride(d: number): number {
  return Math.max(1, Math.round(1 / Math.min(1, Math.max(0.0001, d))))
}

export interface FibersOptions {
  /** 'neutral' (default) = a single solid `color` (the structural view, like Surface's
   *  matte cortex); 'field' = the scalar → colormap (the data evolving on the bundle). */
  colorMode?: FiberColorMode
  /** Neutral solid color (structural view). Default a soft grey. */
  color?: string
  /** Scalar FIELD → colormap by fiber id. `[nFibers]` static, or `[scalarFrames × nFibers]`
   *  (row-major) to ANIMATE — the read is frame-indexed at `timepoint·nFibers + fiberId`,
   *  so advancing the clock recolors the bundle with ZERO re-upload (the Surface pattern). */
  scalar?: Float32Array
  /** Rows in `scalar` (= animation frames). >1 → time-animated. Default 1 (static). */
  scalarFrames?: number
  /** Frame-index uniform for the animated field. Defaults to the Figure clock. */
  timepoint?: Timepoint
  /** Value range the scalar spans (colormap normalize). Default [0,1]. */
  clim?: Limits
  /** Line opacity — a LIVE uniform (`fibers.opacity`). Default 0.6. */
  opacity?: number
  /** Fraction of fibers rendered (0..1) via index stride — live via `fibers.setDensity`. Default 1. */
  density?: number
  /** Additive blending (density glow) — default true; false = normal alpha. */
  additive?: boolean
}

/**
 * Fibers — a tractography bundle as a COORDINATE SYSTEM of 3D polylines (an indexed
 * `LineSegments`, plain 1px `LineBasicNodeMaterial`), the curve analogue of `Surface`.
 * Like Surface it defaults to a neutral structural color; a scalar FIELD (from a compute
 * pass) evolves ON it, read per fiber (`storage.element(frame·nFibers + aFiberId)`) →
 * colormap, animated by the shared clock with zero re-upload. (Direction/curvature-style
 * *structural* coloring is a separate concern — a property of the geometry, not a field —
 * and isn't a color mode here.) The `[nFibers × nPoints × 3]` points are `Line`'s
 * channels×samples; density is a pure index-stride subsample. Drop it in a `projection:'3d'`
 * (orbit) axes.
 */
export class Fibers extends Drawable {
  private readonly _material: LineBasicNodeMaterial
  private readonly _geo: BufferGeometry
  private readonly _nPoints: number
  private readonly _nFibers: number
  private readonly _scalar: StorageBufferAttribute | null
  private readonly _scalarFrames: number
  private readonly _tp: any
  private readonly _color: Color
  private readonly _xExtent: Limits
  private readonly _yExtent: Limits
  private readonly _zExtent: Limits
  private readonly _opacityU: any
  private _mode: FiberColorMode
  private _lastKey = ''
  /** Live opacity uniform — set `.value`. */
  readonly opacity: any

  constructor(axes: Axes, points: Float32Array, nPoints: number, opts: FibersOptions = {}) {
    const nFibers = points.length / (nPoints * 3)
    const nVerts = nFibers * nPoints

    const material = new LineBasicNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.blending = (opts.additive ?? true) ? AdditiveBlending : NormalBlending

    // Geometry: shared vertices (indexed), fiber-major. Only position + fiber id — the
    // per-fiber field is addressed by aFiberId; point-along-fiber is derivable from
    // vertexIndex (= f·nPoints + p) if a per-point field is ever needed.
    const aFiberId = new Float32Array(nVerts)
    for (let f = 0; f < nFibers; f++) for (let p = 0; p < nPoints; p++) aFiberId[f * nPoints + p] = f
    const index = buildFiberIndex(nPoints, nFibers, densityToStride(opts.density ?? 1))

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(points, 3))
    geo.setAttribute('aFiberId', new BufferAttribute(aFiberId, 1))
    geo.setIndex(new BufferAttribute(index, 1))

    const mesh = new LineSegments(geo, material)
    mesh.frustumCulled = false
    super(axes, mesh)

    // `mesh` is not held here — `super(axes, mesh)` above already owns it.
    this._material = material; this._geo = geo
    this._nPoints = nPoints; this._nFibers = nFibers
    this._scalar = opts.scalar ? new StorageBufferAttribute(opts.scalar, 1) : null
    this._scalarFrames = Math.max(1, opts.scalarFrames ?? 1)
    this._tp = opts.timepoint ?? axes.figure.clock.frameUniform
    this._clim = opts.clim ?? [0, 1]
    this._color = new Color(opts.color ?? '#c9ccd6')
    this._mode = opts.colorMode ?? 'neutral'
    this._opacityU = (uniform as any)(opts.opacity ?? 0.6)
    this.opacity = this._opacityU

    // Bounds — the points extent (subsampled scan) frames the orbit cube.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (let i = 0; i < points.length; i += 3 * 30) {
      const x = points[i], y = points[i + 1], z = points[i + 2]
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    this._xExtent = [x0, x1]; this._yExtent = [y0, y1]; this._zExtent = [z0, z1]
    this.invalidate()
  }

  dataBounds(): Bounds { return { xlim: this._xExtent, ylim: this._yExtent, zlim: this._zExtent } }

  /** Swap between 'neutral' (structural color) and 'field' (scalar → colormap). */
  get colorMode(): FiberColorMode { return this._mode }
  set colorMode(m: FiberColorMode) { this._mode = m; this.invalidate() }

  /** Fraction of fibers rendered (0..1) — rebuilds only the index buffer. */
  setDensity(d: number): void {
    this._geo.setIndex(new BufferAttribute(buildFiberIndex(this._nPoints, this._nFibers, densityToStride(d)), 1))
  }

  protected onUpdate(): void {
    const field = this._mode === 'field' && this._scalar !== null
    const key = field ? `field:${this.effectiveColormap()}` : 'neutral'
    if (key === this._lastKey) return
    this._lastKey = key
    const op = this._opacityU
    this._material.colorNode = (Fn as any)(() => {
      if (!field) {                                          // neutral structural color
        const c = this._color
        return vec4(float(c.r), float(c.g), float(c.b), op)
      }
      // per-fiber FIELD, frame-indexed: idx = frame·nFibers + fiberId (frames=1 → static).
      const total = this._scalarFrames * this._nFibers
      const fid = int((attribute as any)('aFiberId', 'float'))
      const idx = int(this._tp).mul(int(this._nFibers)).add(fid)
      const s = (storage as any)(this._scalar, 'float', total).toReadOnly().element(idx)
      const [d0, d1] = this._clim
      const sn = clamp(s.sub(d0).div(d1 - d0), float(0), float(1))
      const row = colormapRowOrNull(this.effectiveColormap())
      const rgb = row === null ? vec3(sn) : (createColormapSampler('default').sample(sn, row) as any).xyz
      return vec4(rgb, op)
    })()
    this._material.needsUpdate = true
  }

  dispose(): void { this._material.dispose(); this._geo.dispose(); super.dispose() }
}
