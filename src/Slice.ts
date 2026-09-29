import {
  Mesh, MeshBasicNodeMaterial, BufferGeometry, BufferAttribute, DoubleSide,
  type Texture, type Plane,
} from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, uv, uniform, vec2, vec3, vec4, float, clamp, texture3D } from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds, Limits } from './limits'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { categoricalColor, type CategoricalScheme } from './categorical'
import { freeAxes, fixedAxis, sliceCount, sliceExtent, type SliceAxis, type VolumeDims } from './sliceUVW'
import type { LegendEntry } from './AxesLegend'
import { withClipping } from './clip'

export interface SliceOptions {
  /** Which volume axis this slice holds fixed. Default `'k'`. */
  axis?: SliceAxis
  /** Initial slice index along that axis (voxels). Default the middle one. */
  index?: number
  /**
   * WINDOW/LEVEL, in the volume's own values (0..255 for a uint8 MRI).
   *
   * Default `[0, 255]`, the whole range. It is the radiological window under
   * another name, and it is a live pair of uniforms rather than a rebuild: a
   * reader drags it continuously.
   */
  clim?: Limits
  /** Read the volume as LABEL IDS through a scheme instead of as intensities
   *  through a ramp. `clim` does not apply. The texture must be NEAREST — see
   *  `createVolumeTexture`, which sets that from the volume's own `kind`. */
  categorical?: CategoricalScheme
  /** Millimetres per voxel `[i, j, k]`, so the quad is drawn to true proportions.
   *  Default `[1,1,1]`. An anisotropic volume drawn without this is stretched by
   *  the ratio, which reads as a different head rather than as a scaling bug. */
  voxsize?: readonly [number, number, number]
  /** Where the quad sits, overriding the voxsize-derived extent. */
  xExtent?: Limits
  yExtent?: Limits
  opacity?: number
  /**
   * Place the quad at four explicit points in 3D instead of on the z = 0 plane —
   * the slice AS IT SITS in the volume's own space, which is what puts an MRI
   * plane inside a head surface.
   *
   * Order is the quad's uv corners: `(0,0)`, `(1,0)`, `(1,1)`, `(0,1)` — so the
   * caller decides which way the image runs, and the SAME uv the shader samples
   * lands on the point the caller nominated. Passing them in the wrong order
   * mirrors or rotates the image without any other symptom.
   *
   * The caller owns UNITS. A cortex mesh is in metres and an MRI's SCS transform
   * yields millimetres, and a slice placed in mm inside a metres scene is 1000×
   * too big — the surfaces become an invisible dot at the origin.
   */
  corners?: readonly [
    readonly [number, number, number], readonly [number, number, number],
    readonly [number, number, number], readonly [number, number, number],
  ]
  /** Clip this slice with its own planes — see `clip.ts`. Declare `[]` to make a
   *  later cut a plane MUTATION rather than a rebuild. */
  clip?: readonly Plane[] | null
  /** UNION (default) or INTERSECTION of `clip` — see `Drawable.setClip`. Live
   *  afterwards; declared here so the first render is already right. */
  clipIntersection?: boolean
}

function buildQuad(
  [x0, x1]: Limits, [y0, y1]: Limits, corners?: SliceOptions['corners'],
): BufferGeometry {
  const g = new BufferGeometry()
  /* The four uv corners, in uv order — flat, either from explicit 3D points or
     from the z = 0 rectangle. One geometry builder for both, so the winding and
     the uv attribute below cannot drift between the 2D and 3D paths. */
  const pos = corners
    ? new Float32Array(corners.flatMap((c) => [c[0], c[1], c[2]]))
    : new Float32Array([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0])
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/**
 * Slice — one plane of a 3D volume, drawn as a quad that samples a
 * `Data3DTexture`.
 *
 * The 2D counterpart of `Volume`'s raymarch and the primitive an MRI viewer is
 * actually made of: three of these, on three axes, under one crosshair. `Image`
 * is its flat sibling — same idea, one dimension down, a storage buffer instead
 * of a texture.
 *
 * `index` is a LIVE uniform, so scrubbing through slices is a uniform write and
 * never a rebuild — the same discipline `timepoint` follows on `Image` and
 * `Line`, and for the same reason: a rebuild costs the camera and a frame, which
 * is the whole interaction here.
 *
 * The uvw arithmetic is `sliceUVW.ts`, which is TESTED — a shader cannot be —
 * and the volume→texture axis mapping is `volumeTexture.ts`'s `volumeUVW`. Both
 * exist because getting either wrong renders a brain-shaped object that no
 * window level can reveal as wrong.
 */
export class Slice extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _mesh: Mesh
  private readonly _tex: Texture
  private readonly _dims: VolumeDims
  private readonly _axis: SliceAxis
  private _categorical: CategoricalScheme | null
  private _opacity: number
  private readonly _xExtent: Limits
  private readonly _yExtent: Limits
  private _corners: SliceOptions['corners']
  private _lastKey = ''
  /** Live slice-index uniform (voxels along the fixed axis). Set `.value` to scrub. */
  readonly index: any
  /** Live window/level uniforms — `lo.value` / `hi.value`, in the volume's units. */
  readonly lo: any
  readonly hi: any
  /** Live opacity uniform. A UNIFORM and not a rebuild for the same reason the
   *  window is: an overlay's opacity is something a reader drags. */
  readonly alpha: any

  constructor(axes: Axes, tex: Texture, dims: VolumeDims, opts: SliceOptions = {}) {
    const axis = opts.axis ?? 'k'
    const vs = opts.voxsize ?? [1, 1, 1]
    const [a, u] = freeAxes(axis)
    const [wVox, hVox] = sliceExtent(dims, axis)
    /* The quad is sized in MILLIMETRES, not voxels: an anisotropic volume drawn
       on a voxel grid is stretched by the ratio, and that reads as a differently
       shaped head rather than as a scaling bug. */
    const xExtent: Limits = opts.xExtent ?? [0, wVox * vs[a]]
    const yExtent: Limits = opts.yExtent ?? [0, hVox * vs[u]]

    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    /* IN 3D THE SLICE MUST TAKE PART IN DEPTH. A flat 2D slice is the only thing
       in its axes and sorts by draw order, but a plane sitting INSIDE a head
       surface has to be occluded by the parts of that surface in front of it —
       otherwise it floats over the scalp and the whole point of the view is
       lost. */
    const in3d = opts.corners != null
    material.depthTest = in3d
    material.depthWrite = in3d && (opts.opacity ?? 1) >= 1
    const mesh = new Mesh(buildQuad(xExtent, yExtent, opts.corners), material)
    super(axes, withClipping(mesh, opts.clip, opts.clipIntersection))

    this._material = material
    this._mesh = mesh
    this._tex = tex
    this._dims = dims
    this._axis = axis
    this._clim = opts.clim ?? [0, 255]
    this._categorical = opts.categorical ?? null
    this._opacity = opts.opacity ?? 1
    this._xExtent = xExtent
    this._yExtent = yExtent
    this._corners = opts.corners

    const mid = Math.floor(sliceCount(dims, axis) / 2)
    this.index = (uniform as any)(opts.index ?? mid)
    this.lo = (uniform as any)(this._clim[0])
    this.hi = (uniform as any)(this._clim[1])
    this.alpha = (uniform as any)(this._opacity)
    material.transparent = this._opacity < 1 || this._categorical !== null
    this.invalidate()
  }

  /** Slices available along this slice's axis — the range `index` may take. */
  get sliceCount(): number { return sliceCount(this._dims, this._axis) }
  get axis(): SliceAxis { return this._axis }

  /** Scrub to a slice. Clamped here rather than in the shader so a caller reading
   *  `.index.value` back gets the slice actually being drawn. */
  setIndex(i: number): void {
    this.index.value = Math.min(this.sliceCount - 1, Math.max(0, Math.round(i)))
  }

  /**
   * Move the quad to new 3D corners — what a slice's index change means in 3D.
   *
   * The PLACEMENT changes with the index, not only the texture coordinate, so
   * `setIndex` alone would sample a new plane and draw it in the old one's
   * position: a perfectly sharp image of the wrong place. Callers scrubbing a 3D
   * slice must call both.
   *
   * This rebuilds four vertices, which is the one thing in this drawable that is
   * not a uniform write — and it is still nothing beside a figure rebuild.
   */
  setCorners(corners: SliceOptions['corners']): void {
    if (!corners) return
    this._corners = corners
    const old = this._mesh.geometry as { dispose(): void }
    this._mesh.geometry = buildQuad(this._xExtent, this._yExtent, corners)
    old.dispose()
    this.invalidate()
  }

  /** Window/level, live — two uniform writes, no rebuild. */
  /** A LIVE uniform pair — a write, never a rebuild. */
  protected onClimChanged(): void {
    this.lo.value = this._clim[0]
    this.hi.value = this._clim[1]
  }


  /**
   * Fade the slice, live — one uniform write.
   *
   * It was fixed at construction, which meant an atlas-opacity control could
   * only ever be decorative: the host moved a slider, the state changed, and the
   * overlay did not. `transparent` has to follow, because a material that starts
   * opaque never reaches the blend path however low the alpha goes — and THAT is
   * a material rebuild, so it happens only on the crossing, not per drag.
   */
  setOpacity(v: number): void {
    const o = Math.min(1, Math.max(0, v))
    const wasBlending = this._material.transparent
    this._opacity = o
    this.alpha.value = o
    const blending = o < 1 || this._categorical !== null
    if (blending !== wasBlending) {
      this._material.transparent = blending
      this._material.needsUpdate = true
    }
  }

  get opacity(): number { return this._opacity }

  dataBounds(): Bounds {
    /* A 3D slice contributes its own CORNER extent, so an axes framing several
       of them frames the volume they span rather than a rectangle none of them
       lies in. */
    const c = this._corners
    if (!c) return { xlim: this._xExtent, ylim: this._yExtent }
    const at = (i: 0 | 1 | 2): Limits => [
      Math.min(...c.map((p) => p[i])), Math.max(...c.map((p) => p[i])),
    ]
    return { xlim: at(0), ylim: at(1), zlim: at(2) }
  }

  /** Swap the label scheme, or `null` for the intensity ramp. Rebuilds the node. */
  setCategorical(scheme: CategoricalScheme | null): void {
    this._categorical = scheme
    this._material.transparent = this._opacity < 1 || scheme !== null
    this._lastKey = ''
    this.invalidate()
  }

  /** How this slice describes itself in the legend, or null. Host-set. */

  legendEntry(): LegendEntry | null {
    if (!this.legend || !this.visible) return null
    /* A categorical slice keys a swatch list, not a ramp: the fill comes from a
       lookup the bar does not sample, over ids with no order to put on an axis. */
    if (this._categorical) return null
    return {
      title: this.legend.title,
      unit: this.legend.unit,
      clim: this._clim,
      colormap: this.colormap || this.axes.colormap,
    }
  }

  protected onUpdate(): void {
    const cat = this._categorical
    const key = cat ? `__cat:${cat.id}:${cat.width}` : this.effectiveColormap()
    if (key === this._lastKey) return
    this._lastKey = key
    const row = cat ? null : colormapRowOrNull(key)

    const dims = this._dims
    const f = fixedAxis(this._axis)
    const [ax, up] = freeAxes(this._axis)
    const nF = dims[f]
    const { index, lo, hi, alpha: op } = this

    this._material.colorNode = (Fn as any)(() => {
      const q: any = uv()
      /* THE SAME ARITHMETIC `sliceUVW` IMPLEMENTS AND TESTS, in nodes.
         Free axes stay continuous — a linear sampler is the point on a T1, and
         flooring here would quantise the image to voxels at every zoom. The
         FIXED axis is a texel CENTRE: a slice landing between two planes makes a
         linear sampler return their average, which reads as a slightly thick
         slice and is actually two. */
      const w: any[] = [null, null, null]
      w[ax] = clamp(q.x, float(0), float(1))
      w[up] = clamp(q.y, float(0), float(1))
      w[f] = clamp(index, float(0), float(nF - 1)).add(float(0.5)).div(float(nF))
      /* volumeUVW: a Data3DTexture is indexed (x, y, z) with x fastest and the
         volume is [i, j, k] C-order with k fastest, so the texture's x is the
         volume's k. Reversing is the whole mapping, and this is its second and
         last home — see `volumeTexture.ts`, which owns the CPU one. */
      const coord = vec3(w[2], w[1], w[0])
      const raw: any = (texture3D as any)(this._tex, coord)
      // RedFormat: one channel, and it arrives in .r normalised to 0..1.
      const v255: any = raw.r.mul(float(255))

      if (cat) {
        /* No flat varying and none needed: a slice reads the texture per FRAGMENT
           at a NEAREST-sampled coordinate, so nothing between two labels is ever
           interpolated on the way in. The flat rule binds where a value rides a
           varying across a primitive; here it does not ride one at all. */
        const c: any = categoricalColor(v255, cat)
        return vec4(c.x, c.y, c.z, c.w.mul(op))
      }
      // WINDOW/LEVEL, live: two uniforms, no rebuild. `max(hi-lo, 1)` keeps a
      // collapsed window from painting the plane NaN while a reader drags it
      // through zero width.
      const span: any = hi.sub(lo).max(float(1))
      const t: any = clamp(v255.sub(lo).div(span), float(0), float(1))
      if (row === null) return vec4(t, t, t, op)
      const rgb = createColormapSampler('default').sample(t, row) as any
      return vec4(rgb.r, rgb.g, rgb.b, op)
    })()
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    /* The TEXTURE is not disposed here. It is external (arrangement 1: buffers
       are owned outside the Figure) and three slices of one volume share it —
       freeing it with the first would blank the other two. */
    super.dispose()
  }
}
