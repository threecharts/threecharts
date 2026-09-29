/**
 * SignMarkers — camera-facing `+` / `−` glyphs at arbitrary points.
 *
 * For marking the sign of something AT a place: sources and sinks on a flow map, poles,
 * anything where the reader needs "which way" and not "how much". A `Quiver` answers
 * direction and a colormap answers magnitude; neither answers sign at a glance on a
 * folded surface, where a red patch and a blue patch look equally like "a patch".
 *
 * **The glyph is DRAWN, not sampled.** A `+` is two bars and a `−` is one, evaluated
 * from the quad's own uv in the fragment shader — so it is resolution-independent, needs
 * no texture atlas to load and cannot arrive late the way the colormap atlas famously
 * can (a Figure whose atlas never loaded renders every colormapped drawable in silent
 * greyscale; a glyph baked into the shader has no such failure mode).
 *
 * **Colour carries the sign too, redundantly.** At the size these sit on a cortex the
 * bar of a `−` is a couple of pixels, and a reader should not have to resolve it to know
 * what they are looking at. Two encodings of one fact is the right kind of redundancy:
 * the glyph is exact, the colour is legible.
 *
 * CAMERA-FACING, like `Particles`: offset in VIEW space after the model-view transform,
 * so the quad always squarely faces the orbit camera. A decal lying in the surface's
 * tangent plane was the alternative and it foreshortens to a line exactly where a
 * cortex is most interesting — inside a sulcus, viewed side-on.
 */
import {
  InstancedMesh, MeshBasicNodeMaterial, PlaneGeometry, DoubleSide, Matrix4,
  type BufferGeometry,
} from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import {
  Fn, vec3, vec4, float, int, instanceIndex, positionGeometry, uniform, uv,
  attributeArray, modelViewMatrix, cameraProjectionMatrix, abs, step, max, min,
  smoothstep, fwidth,
} from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds } from './limits'

export interface SignMarker {
  /** World position. */
  position: [number, number, number]
  /** `+1` draws a plus, `−1` a minus. */
  sign: 1 | -1
}

export interface SignMarkersOptions {
  /** Glyph half-size as a FRACTION of the axes' bounding radius, so a marker is the
   *  same apparent size on a cortex in metres and on a unit test sphere. Default 0.02. */
  scale?: number
  /**
   * How many glyphs this can show before it must be rebuilt.
   *
   * A CEILING, not an allocation: the instance count is fixed at construction because
   * that is what sizes the buffers, and unused instances are parked at zero size rather
   * than reallocated. Default 256.
   */
  capacity?: number
  /** `[positive, negative]` as CSS colours. Defaults read as warm/cool. */
  colors?: [string, string]
  /**
   * Draw each glyph on a filled DISC in the sign's colour, with the bars knocked out
   * dark. Default true.
   *
   * The bare bars are a couple of pixels wide at the size these sit on a cortex, and
   * they float against whatever is behind them — a folded, colourmapped surface, which
   * is the worst possible backdrop for a thin line. On a disc the marker reads as a
   * coloured DOT at any size (sign by colour, the redundancy this header already argues
   * for) and resolves into `⊕` / `⊖` as you zoom, so one glyph serves both distances.
   *
   * Round rather than square, and camera-facing, so it presents the same silhouette at
   * every orbit angle — the shape carries no information and so should not vary.
   */
  badge?: boolean
  /** The bars' colour on a badge — the knocked-out ink. Default near-black. */
  inkColor?: string
}

const DEFAULT_COLORS: [string, string] = ['#ff9d5c', '#5cb8ff']

/** Bar half-thickness and half-length in the quad's own [-1,1] space. */
const BAR_T = 0.16, BAR_L = 0.62
/** The badge's radius in that same space. Under 1 so the disc's antialiased edge has
 *  room inside the quad instead of being clipped by it. */
const DISC_R = 0.92
/** The rim's width, inside `DISC_R`. */
const RIM_W = 0.16
const DEFAULT_INK = '#0b0d14'

export class SignMarkers extends Drawable {
  private readonly _mesh: InstancedMesh
  private readonly _pos: any
  private readonly _sign: any
  private readonly _capacity: number
  private readonly _size: any
  private _count = 0

  constructor(axes: Axes, geometry: BufferGeometry, opts: SignMarkersOptions = {}) {
    const capacity = Math.max(1, Math.floor(opts.capacity ?? 256))

    /* Sized against the HOST MESH, like `VertexMarkers` — the same fraction is a
       couple of millimetres on a cortex and a fiftieth of a unit sphere, so a caller
       never has to know the scene's units. */
    geometry.computeBoundingSphere()
    const meshRadius = geometry.boundingSphere?.radius ?? 1

    const posData = new Float32Array(capacity * 3)
    const signData = new Float32Array(capacity)   // 0 = parked
    const posBuf = (attributeArray as any)(posData, 'vec3')
    const signBuf = (attributeArray as any)(signData, 'float')
    const size = (uniform as any)(meshRadius * (opts.scale ?? 0.02))


    const [posHex, negHex] = opts.colors ?? DEFAULT_COLORS
    const cPos = hexToVec3(posHex)
    const cNeg = hexToVec3(negHex)
    const badge = opts.badge ?? true
    const inkC = hexToVec3(opts.inkColor ?? DEFAULT_INK)

    const material = new MeshBasicNodeMaterial()
    material.side = DoubleSide
    material.transparent = true
    material.depthWrite = false

    const s = signBuf
    const p = posBuf

    material.vertexNode = (Fn as any)(() => {
      const i = int(instanceIndex)
      const sign = s.element(i)
      // A parked instance collapses to a point — cheaper and safer than culling, and
      // it keeps the instance count constant so nothing has to be rebuilt.
      const scale = size.mul(min(abs(sign), float(1)))
      const centre: any = modelViewMatrix.mul(vec4(p.element(i), float(1)))
      const local = positionGeometry
      const offset = vec4(local.x.mul(scale), local.y.mul(scale), float(0), float(0))
      return cameraProjectionMatrix.mul(centre.add(offset))
    })()

    material.fragmentNode = (Fn as any)(() => {
      const i = int(instanceIndex)
      const sign = s.element(i)
      // uv is [0,1]; work in [-1,1] so the glyph is symmetric about the centre.
      const q = uv().mul(float(2)).sub(float(1))
      const horiz = step(abs(q.y), float(BAR_T)).mul(step(abs(q.x), float(BAR_L)))
      const vert = step(abs(q.x), float(BAR_T)).mul(step(abs(q.y), float(BAR_L)))
      // A minus is the horizontal bar; a plus adds the vertical one.
      const isPlus = step(float(0), sign)
      const ink = max(horiz, vert.mul(isPlus))
      const signRgb = vec3(
        float(cNeg[0]).add(float(cPos[0] - cNeg[0]).mul(isPlus)),
        float(cNeg[1]).add(float(cPos[1] - cNeg[1]).mul(isPlus)),
        float(cNeg[2]).add(float(cPos[2] - cNeg[2]).mul(isPlus)),
      )
      if (!badge) return vec4(signRgb, ink)

      /*
       * THE BADGE. A disc in the sign's colour with the bars knocked out dark, so the
       * marker is a coloured dot when it is small and a `⊕`/`⊖` when it is not.
       *
       * The disc edge is ANTIALIASED and the bars are not, deliberately. The circle is
       * the silhouette — a hard `step` on it stair-steps visibly at the ~10 px these
       * sit at — while the bars are interior contrast, where a hard edge reads as
       * crispness rather than as aliasing. `fwidth` puts the ramp one fragment wide in
       * SCREEN space, so it holds at any zoom instead of scaling with the quad.
       */
      const r = q.length()
      const fw = max(fwidth(r), float(1e-5))
      /* RISING edge then inverted, NOT `smoothstep(hi, lo, x)`. Reversed edges are
         undefined in WGSL — written that way the disc came out empty and the marker
         rendered as the bare bars it was supposed to sit on. */
      const disc = smoothstep(float(DISC_R).sub(fw), float(DISC_R).add(fw), r).oneMinus()
      /* A DARK RIM, because the fill alone is not enough. The disc is drawn in the
         sign's colour and the cortex under it is a diverging colormap — so a warm
         marker on a warm patch is exactly the case where the badge disappears, which is
         the case the reader most needs it. A rim is background-independent: it
         separates the glyph from whatever it lands on. */
      const rim = smoothstep(float(DISC_R - RIM_W).sub(fw), float(DISC_R - RIM_W).add(fw), r)
      const dark = vec3(inkC[0], inkC[1], inkC[2])
      const edged = signRgb.mul(rim.oneMinus()).add(dark.mul(rim))
      const rgb = edged.mul(ink.oneMinus()).add(dark.mul(ink))
      return vec4(rgb, disc)
    })()

    const mesh = new InstancedMesh(new PlaneGeometry(2, 2), material, capacity)
    mesh.frustumCulled = false
    // The vertex node places every instance, so the matrices stay identity — three
    // still requires them to be set, or the mesh is culled before the shader runs.
    const id = new Matrix4()
    for (let k = 0; k < capacity; k++) mesh.setMatrixAt(k, id)
    mesh.instanceMatrix.needsUpdate = true
    mesh.renderOrder = 3

    super(axes, mesh)
    this._mesh = mesh
    this._capacity = capacity
    this._pos = posBuf
    this._sign = signBuf
    this._size = size
  }

  /** How many are currently shown. */
  get count(): number { return this._count }
  get capacity(): number { return this._capacity }

  /** Replace the marker set. Beyond `capacity` the tail is dropped — the caller ranks. */
  setMarkers(markers: readonly SignMarker[]): void {
    const posArr = this._pos.value.array as Float32Array
    const sgnArr = this._sign.value.array as Float32Array
    const n = Math.min(markers.length, this._capacity)
    for (let k = 0; k < n; k++) {
      const m = markers[k]
      posArr[k * 3] = m.position[0]
      posArr[k * 3 + 1] = m.position[1]
      posArr[k * 3 + 2] = m.position[2]
      sgnArr[k] = m.sign
    }
    // Park the rest. Without this a shrinking set leaves stale glyphs on screen, which
    // reads as detections that are simply wrong rather than as a stale buffer.
    for (let k = n; k < this._capacity; k++) sgnArr[k] = 0
    this._pos.value.needsUpdate = true
    this._sign.value.needsUpdate = true
    this._count = n
    this.axes.invalidate()
  }

  /** Glyph half-size, as a fraction of the axes' bounding radius. */
  setScale(fraction: number, meshRadius: number): void {
    this._size.value = fraction * (meshRadius || 1)
    this.axes.invalidate()
  }

  /** NULL on purpose. Markers are chrome: they must not enter the axes' auto-limits,
   *  or one stray detection at the edge of the mesh would re-frame the whole cortex —
   *  the same reason `VertexMarkers` returns null. */
  dataBounds(): Bounds | null { return null }

  dispose(): void {
    this._mesh.geometry.dispose()
    ;(this._mesh.material as any).dispose?.()
    this.node.remove(this._mesh)
    super.dispose?.()
  }
}

function hexToVec3(css: string): [number, number, number] {
  const h = css.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
