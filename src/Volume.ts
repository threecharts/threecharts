import { Mesh, NodeMaterial, BoxGeometry, BackSide } from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, float, int, vec3, vec4, uint, uniform, floor, clamp, min, max, normalize, cameraPosition, positionWorld, Loop, If, Break } from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import { gridDomain, type GridDomain } from './domain/gridDomain'
import { resolveField, type FieldSource, type ResolvedField , type Timepoint } from './field/source'
import type { Limits, Bounds } from './limits'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'

/** Resolve a colormap NAME → atlas row, or null (→ grayscale). */
/** Hard cap on raymarch steps (the Loop bound must be a constant; `steps` breaks early). */
const STEPS_MAX = 192

export interface VolumeOptions {
  /**
   * `[depth, height, width]` — the DATA's own order, matching the documented
   * `[frames × D × H × W]` layout and the shader's `iz·(H·W) + iy·W + ix`.
   *
   * The positional form this replaces took `(W, H, D)` — the REVERSE of the layout
   * its own doc comment states. A caller with a `[D][H][W]` array had to hand the
   * three numbers over backwards, and nothing said so.
   */
  shape?: readonly [depth: number, height: number, width: number]
  xExtent?: Limits
  yExtent?: Limits
  zExtent?: Limits
  /** Value range the buffer's floats span (colormap + opacity normalize). Default [0,1]. */
  clim?: Limits
  /** Per-step opacity multiplier — a LIVE uniform (`volume.density.value`). Default 0.14. */
  density?: number
  /** Raymarch step count — a LIVE uniform (`volume.steps.value`). Default 96 (≤192). */
  steps?: number
  /** Frame-index uniform — which volume of the stacked buffer to read. Defaults to the
   *  Figure clock's shared `frameUniform`, so it animates in lock-step. */
  timepoint?: Timepoint
}

/**
 * Volume — the 3D Image: a scalar field `[frames × D × H × W]` in an EXTERNAL GPU
 * storage buffer (arrangement 1), raymarched through a box at the data extents. The
 * fragment casts a ray from the camera, slab-intersects the data cube, and marches
 * front-to-back, reading the buffer READ-ONLY at
 * `timepoint*D*H*W + iz*H*W + iy*W + ix` per step, colormapping the scalar and
 * accumulating emission·absorption. `timepoint`/`density`/`steps` are live uniforms →
 * advancing the clock re-renders the next volume with ZERO re-upload (a static volume
 * is the 1-frame case). The 3D counterpart of `Image`; drop it in a `projection:'3d'`
 * (orbit) axes.
 */
export class Volume extends Drawable {
  private readonly _material: NodeMaterial
  private readonly _mesh: Mesh
  /** The voxel lattice. Share it with anything drawn in the same volume — a slice,
   *  a glyph field — so they address ONE grid rather than two that agree by hand. */
  readonly domain: GridDomain
  private readonly _field: ResolvedField
  private readonly _W: number
  private readonly _H: number
  private readonly _D: number
  private readonly _tp: any
  private _lastColormap = ''
  /** Live per-step opacity uniform — set `.value` to make the volume denser/thinner. */
  readonly density: any
  /** Live raymarch step-count uniform (≤ STEPS_MAX). */
  readonly steps: any

  /** `W`/`H`/`D` OR a `GridDomain` — the voxel lattice, said two ways. Shape alone
   *  is unambiguous for a volume, so the dimensions INFER a lattice. */
  constructor(axes: Axes, values: FieldSource, opts: VolumeOptions & { shape: readonly [number, number, number] })
  constructor(axes: Axes, values: FieldSource, domain: GridDomain, opts?: VolumeOptions)
  constructor(
    axes: Axes,
    values: FieldSource,
    a: GridDomain | (VolumeOptions & { shape: readonly [number, number, number] }),
    b?: VolumeOptions,
  ) {
    const fromDomain = 'positionAt' in a
    const opts: VolumeOptions = (fromDomain ? b : a as VolumeOptions) ?? {}
    const g = a as GridDomain
    // A lattice is fastest-first (nx, ny, nz); the data is [depth, height, width].
    const [W, H, D] = fromDomain
      ? [g.shape[0], g.shape[1], g.shape[2]]
      : [opts.shape![2], opts.shape![1], opts.shape![0]]
    const xExtent = fromDomain ? g.extents[0] : (opts.xExtent ?? [0, W])
    const yExtent = fromDomain ? g.extents[1] : (opts.yExtent ?? [0, H])
    const zExtent = fromDomain ? g.extents[2] : (opts.zExtent ?? [0, D])
    const domain = fromDomain
      ? g
      : gridDomain({ nx: W, ny: H, nz: D, x: xExtent, y: yExtent, z: zExtent })
    const [x0, x1] = xExtent, [y0, y1] = yExtent, [z0, z1] = zExtent

    const material = new NodeMaterial()
    material.side = BackSide            // fragment runs on the far faces → march toward them
    material.transparent = true
    material.depthWrite = false
    material.depthTest = false

    // A box sized to the extents, positioned at the cube center — the mesh transform
    // maps it into world space, so `positionWorld` is the true data-space entry point.
    const geo = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
    const mesh = new Mesh(geo, material)
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    mesh.frustumCulled = false
    super(axes, mesh)

    this._material = material
    this._mesh = mesh
    this.domain = domain
    this._clim = opts.clim ?? [0, 1]
    this._field = resolveField(values, 'float')
    this._W = W; this._H = H; this._D = D
    this._tp = opts.timepoint ?? axes.figure.clock.frameUniform
    this.density = (uniform as any)(opts.density ?? 0.14)
    this.steps = (uniform as any)(opts.steps ?? 96)
    this.invalidate()
  }

  dataBounds(): Bounds {
    const e = this.domain.extents
    return { xlim: e[0], ylim: e[1], zlim: e[2] }
  }

  protected onUpdate(): void {
    // Rebuild only on colormap change; timepoint/density/steps update in place.
    const cmap = this.effectiveColormap()
    if (cmap === this._lastColormap) return
    this._lastColormap = cmap
    const row = colormapRowOrNull(cmap)
    const buf = this._field.node as any
    const W = this._W, H = this._H, D = this._D, tp = this._tp
    const e = this.domain.extents
    const [x0, x1] = e[0], [y0, y1] = e[1], [z0, z1] = e[2]
    const [d0, d1] = this._clim
    const density = this.density, uSteps = this.steps

    this._material.colorNode = (Fn as any)(() => {
      const bmin: any = vec3(x0, y0, z0)
      const bmax: any = vec3(x1, y1, z1)
      const ro: any = cameraPosition.toVar()
      const rd: any = normalize(positionWorld.sub(cameraPosition)).toVar()

      // Slab intersection of the ray with the data cube → [tN, tF].
      const invR: any = vec3(1.0).div(rd)
      const t0: any = bmin.sub(ro).mul(invR)
      const t1: any = bmax.sub(ro).mul(invR)
      const tmin: any = min(t0, t1)
      const tmax: any = max(t0, t1)
      const tN: any = max(max(tmin.x, tmin.y), tmin.z).toVar()
      const tF: any = min(min(tmax.x, tmax.y), tmax.z).toVar()
      tN.assign(max(tN, float(0.0)))

      const acc: any = vec4(0).toVar()
      const N: any = uint(uSteps)
      const dt: any = tF.sub(tN).div(float(uSteps)).toVar()
      const p: any = ro.add(rd.mul(tN)).toVar()
      const span: any = bmax.sub(bmin)

      Loop(STEPS_MAX, ({ i }: { i: any }) => {
        If(uint(i).greaterThanEqual(N), () => { Break() })
        If(acc.a.greaterThanEqual(0.98), () => { Break() })

        const uvw: any = p.sub(bmin).div(span)                              // [0,1]³
        const ix: any = clamp(floor(uvw.x.mul(W)), float(0), float(W - 1))
        const iy: any = clamp(floor(uvw.y.mul(H)), float(0), float(H - 1))
        const iz: any = clamp(floor(uvw.z.mul(D)), float(0), float(D - 1))
        const flat: any = tp.mul(W * H * D).add(iz.mul(H * W)).add(iy.mul(W)).add(ix)
        const s: any = buf.element(int(flat))                               // scalar at the voxel
        const sn: any = clamp(s.sub(d0).div(d1 - d0), float(0), float(1))   // normalize to [0,1]

        const col: any = row === null ? vec3(sn) : (createColormapSampler('default').sample(sn, row) as any).xyz
        const a: any = clamp(sn.mul(density), float(0), float(1))           // per-step opacity
        acc.rgb.addAssign(acc.a.oneMinus().mul(a).mul(col))                 // front-to-back
        acc.a.addAssign(acc.a.oneMinus().mul(a))

        p.addAssign(rd.mul(dt))
      })

      return acc
    })()
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    super.dispose()
  }
}
