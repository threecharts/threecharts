import { Mesh, MeshBasicNodeMaterial, BufferGeometry, BufferAttribute, Color, DoubleSide } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, attribute, uniform, vec3, vec4, float, int, clamp } from 'three/tsl'
import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds, Limits } from './limits'
import { isParametric, type Domain, type ParametricDomain } from './domain/Domain'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { resolveField, resolveFieldOrNull, type FieldSource, type Timepoint } from './field/source'
import type { GlyphLayout } from './Glyphs'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BandOptions {
  /** The lower boundary — a field, or a constant. Default 0. */
  lower?: FieldSource | number
  /**
   * The range the boundary values span, mapped onto the domain's second
   * parameter. Default `[0, 1]` — i.e. values are already normalised.
   *
   * It does NOT default to the domain's y extent, which was the first attempt and
   * was wrong: `positionAtUV` takes NORMALISED parameters, and "the second
   * parameter" is only the y axis on a Cartesian domain. On a polar domain it is
   * the RADIUS, whose relation to the bounding box's y extent is nothing — a full
   * disc of radius 1 has `ylim [-1, 1]`, so a boundary of 0 mapped to the middle
   * of that range and the rose came out with a hole punched through it. Guessing
   * the mapping from the bounding box only works for the one domain shape that
   * needs no guess.
   */
  valueRange?: Limits
  /** Fill colour. Omit for the axes colormap keyed to the band's own height. */
  color?: string | number
  clim?: Limits
  opacity?: number
  timepoint?: Timepoint
  frames?: number
  layout?: GlyphLayout
}

/**
 * Band — the region between two boundary fields over a domain.
 *
 * One primitive behind four charts: an AREA is a band from a baseline to a curve,
 * a RIDGELINE FILL is one per channel, a STREAMGRAPH is a stack of them with
 * moving baselines, a VIOLIN is a band between ±density. What they share is the
 * only thing that matters — a region bounded by two functions of one parameter.
 *
 * **Fixed topology, placed by fields — not a derived domain.** R10 files "a region
 * whose boundary the data chooses" under derived domains, the expensive case where
 * a mesh must be recomputed from values. A band is not that. It is a triangle
 * strip of `2N` vertices whose CONNECTIVITY never changes; only the positions
 * depend on the data. So it is an ordinary `place` drawable (§1.4): built once,
 * animated by moving `timepoint`, never re-meshed. Contours and isosurfaces still
 * need R10's machinery, because there the topology genuinely depends on the
 * values; areas never did.
 *
 * **It asks the DOMAIN where its boundaries sit**, which is why the same primitive
 * on a polar domain is a filled radar chart or a rose diagram rather than new
 * code. That requires continuous placement, so the domain must be parametric —
 * a mesh is rejected at construction rather than silently mis-drawn.
 */
export class Band extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _domain: ParametricDomain
  /** Live slice being read — set `.value` to animate without a rebuild. */
  readonly timepoint: any

  constructor(axes: Axes, domain: Domain, upper: FieldSource, opts: BandOptions = {}) {
    if (!isParametric(domain)) {
      throw new Error(
        'Band: this domain cannot be addressed between its samples, so a boundary ' +
        'has nowhere to sit. Lattice and polar domains can; a mesh cannot.',
      )
    }
    const N = domain.count
    if (N < 2) throw new Error(`Band: needs at least 2 samples, got ${N}`)

    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    const opacity = opts.opacity ?? 1
    if (opacity < 1) { material.transparent = true; material.depthWrite = false }
    material.depthTest = false; material.depthWrite = false

    super(axes, new Mesh(buildStrip(N), material))
    this._material = material
    this._domain = domain
    this._clim = opts.clim ?? [0, 1]

    const frames = Math.max(1, opts.frames ?? 1)
    const tp: any = typeof opts.timepoint === 'number'
      ? (uniform as any)(opts.timepoint)
      : (opts.timepoint ?? axes.figure.clock.frameUniform)
    this.timepoint = tp

    const at = opts.layout === 'row-major'
      ? (i: any) => int(i).mul(int(frames)).add(int(tp))
      : (i: any) => int(tp).mul(int(N)).add(int(i))

    const upperF = resolveField(upper, 'float')
    const lowerF = typeof opts.lower === 'number' || opts.lower == null
      ? null
      : resolveFieldOrNull(opts.lower, 'float')
    const lowerConst = float(typeof opts.lower === 'number' ? opts.lower : 0)

    // Map a boundary VALUE onto the domain's second parameter, normalised.
    const [r0, r1] = opts.valueRange ?? [0, 1]
    const rSpan = r1 - r0 || 1

    material.positionNode = (Fn as any)(() => {
      const vid: any = attribute('aIdx', 'float')
      const sample: any = vid.mul(0.5).floor()          // 2 vertices per sample
      const side: any = vid.sub(sample.mul(2))          // 0 = lower, 1 = upper
      const i: any = int(sample)
      const u: any = sample.div(float(N - 1))
      const lo: any = lowerF ? float((lowerF.node as any).element(at(i))) : lowerConst
      const hi: any = float((upperF.node as any).element(at(i)))
      const value: any = lo.add(hi.sub(lo).mul(side))   // side picks the boundary
      const v: any = value.sub(float(r0)).div(float(rSpan))
      return this._domain.positionAtUV(u, v)
    })()

    const solid = opts.color != null ? new Color(opts.color as any) : null
    const [c0, c1] = this._clim
    const cSpan = c1 - c0 || 1

    material.colorNode = (Fn as any)(() => {
      if (solid) return vec4(vec3(solid.r, solid.g, solid.b), float(opacity))
      const vid: any = attribute('aIdx', 'float')
      const i: any = int(vid.mul(0.5).floor())
      // Keyed to the band's OWN height, so a stacked set reads as a heat ramp
      // rather than as one flat colour per layer.
      const hv: any = float((upperF.node as any).element(at(i)))
      const n: any = clamp(hv.sub(float(c0)).div(float(cSpan)), float(0), float(1))
      const row = colormapRowOrNull(this.effectiveColormap())
      const rgb: any = row === null
        ? vec3(n)
        : (() => { const c = createColormapSampler('default').sample(n, row) as any; return vec3(c.r, c.g, c.b) })()
      return vec4(rgb, float(opacity))
    })()

    this.invalidate()
  }

  dataBounds(): Bounds { return this._domain.bounds() }

  get domain(): ParametricDomain { return this._domain }

  protected onClimChanged(): void { /* baked into the colour node */ }

  dispose(): void {
    this._material.dispose()
    ;((this.node as Mesh).geometry as { dispose(): void }).dispose()
    super.dispose()
  }
}

/**
 * `2N` vertices as a strip: vertex `2i` is sample `i`'s LOWER boundary, `2i+1` its
 * upper. Connectivity is fixed forever — only the `positionNode` moves — which is
 * what makes a band animate for the price of a uniform.
 */
function buildStrip(n: number): BufferGeometry {
  const verts = n * 2
  const idx = new Float32Array(verts)
  for (let i = 0; i < verts; i++) idx[i] = i
  const tri = new Uint32Array((n - 1) * 6)
  for (let s = 0, k = 0; s < n - 1; s++) {
    const a = s * 2
    tri[k++] = a; tri[k++] = a + 1; tri[k++] = a + 2
    tri[k++] = a + 1; tri[k++] = a + 3; tri[k++] = a + 2
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3)) // overridden
  g.setAttribute('aIdx', new BufferAttribute(idx, 1))
  g.setIndex(new BufferAttribute(tri, 1))
  return g
}
