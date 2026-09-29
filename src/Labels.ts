import { InstancedMesh, MeshBasicNodeMaterial, BufferGeometry, BufferAttribute, DoubleSide } from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import {
  Fn, instanceIndex, positionGeometry, uniform, uv, texture, vec2, vec3, vec4, float, int,
  attributeArray, modelViewMatrix, cameraProjectionMatrix, viewportSize, varying,
} from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds } from './limits'
import { asReadOnly } from './storage-access'
import { buildTextAtlas, type TextAtlas, type TextAtlasOptions } from './textAtlas'

export interface LabelsOptions extends TextAtlasOptions {
  /** Opacity of the whole set. Default 1. */
  opacity?: number
  /** Push each label this many CSS pixels up from its anchor, so text sits ABOVE
   *  the thing it names instead of on top of it. Default 10. */
  offsetPx?: number
  /** A hard cap on how many labels draw. See `Labels`' note on fill rate. */
  max?: number
}

/** A `[4 × 2]` unit quad centred on the origin, with uv — the billboard. */
function quad(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/**
 * Labels — short text pinned to points in 3D, always facing the camera.
 *
 * ONE instanced draw and one atlas texture, not one object per label. `Sprite`
 * would be an `Object3D` each: at MEG channel counts that is ~272 draw calls
 * against this one. The billboard itself is the idiom `Particles` and `Quiver`
 * already use — the anchor goes to VIEW space, the quad's corner offset is added
 * THERE (where x and y are screen-aligned), and the result is projected. No
 * rotation, no lookAt.
 *
 * SIZED IN PIXELS, unlike every other drawable here. The corner offset is applied
 * in CLIP space scaled by `viewportSize`, so a label is the same size on screen
 * at any zoom or orbit — which is what text must do and is the one place this
 * package deliberately leaves data space. Multiplying by `clip.w` is what makes
 * it survive the perspective divide, so the same expression is correct under the
 * orthographic camera these axes use and under a perspective one.
 *
 * THE COST IS FILL, NOT GEOMETRY. 272 labels is 544 triangles — 1.3 % of the
 * cortex mesh already on screen. But 272 labels at ~120×28 px is ~0.9 M
 * fragments a frame, roughly half a 1080p screen of overdraw, and they are
 * transparent so they cannot depth-write. Decluttering is therefore a
 * PERFORMANCE lever and not only a readability one: ten labels is 34 K
 * fragments. `max` and a filtered `texts` list are how a host spends that.
 */
export class Labels extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _mesh: InstancedMesh
  private _atlas: TextAtlas | null
  private readonly _anchors: Float32Array
  private readonly _count: number
  private readonly _bounds: Bounds
  /** Live opacity uniform — set `.value` to fade the whole set. */
  readonly opacity: any

  constructor(
    axes: Axes,
    /** `[count × 3]`, in the axes' own data coordinates. */
    anchors: Float32Array,
    texts: readonly string[],
    opts: LabelsOptions = {},
  ) {
    const n = Math.min(texts.length, Math.floor(anchors.length / 3), opts.max ?? Infinity)
    const atlas = buildTextAtlas(texts.slice(0, n), opts)

    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    material.transparent = true
    /* NO DEPTH WRITE, and depth TEST off: a label is chrome about a point, so it
       should be legible even when the point is behind a surface. Occlusion is the
       host's call — it knows which sensors are on the far side of the head — and
       expressing it by hiding the label is clearer than letting the depth buffer
       eat half a word. */
    material.depthWrite = false
    material.depthTest = false
    const mesh = new InstancedMesh(quad(), material, Math.max(1, n))
    mesh.frustumCulled = false
    super(axes, mesh)

    this._material = material
    this._mesh = mesh
    this._atlas = atlas
    this._anchors = anchors
    this._count = n
    this.opacity = (uniform as any)(opts.opacity ?? 1)

    const b = { xlim: [0, 0] as [number, number], ylim: [0, 0] as [number, number] }
    this._bounds = b
    if (n > 0) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const v = anchors[i * 3 + k]
          if (v < lo[k]) lo[k] = v
          if (v > hi[k]) hi[k] = v
        }
      }
      b.xlim = [lo[0], hi[0]]; b.ylim = [lo[1], hi[1]]
      ;(b as Bounds).zlim = [lo[2], hi[2]]
    }

    if (!atlas || n === 0) {
      /* No canvas (a test environment) or nothing to say. The drawable still
         exists so a host need not branch, and it draws nothing. */
      mesh.visible = false
      this.invalidate()
      return
    }

    /* FLAT float buffers, indexed 3v/3v+1/3v+2 rather than a `vec3` storage
       buffer — the shape `Quiver.setAnchors` records as the one PROVEN to survive
       on this path. These are never rewritten, but paying three scalar reads to
       stay on a known-good path is the right trade against a buffer that breaks
       the moment anything touches it. */
    const posBuf: any = asReadOnly(
      (attributeArray as (d: unknown, t: string) => any)(Float32Array.from(anchors.subarray(0, n * 3)), 'float'))
    /* Per label: u0, v0, u1, v1, widthPx, heightPx — six floats, one stride. */
    const meta = new Float32Array(n * 6)
    atlas.rects.forEach((r, i) => {
      meta[i * 6] = r.uv[0]; meta[i * 6 + 1] = r.uv[1]
      meta[i * 6 + 2] = r.uv[2]; meta[i * 6 + 3] = r.uv[3]
      meta[i * 6 + 4] = r.widthPx; meta[i * 6 + 5] = r.heightPx
    })
    const metaBuf: any = asReadOnly(
      (attributeArray as (d: unknown, t: string) => any)(meta, 'float'))

    const offPx = opts.offsetPx ?? 10
    const atlasTex: any = atlas.texture

    material.positionNode = (Fn as any)(() => {
      const i: any = instanceIndex
      const i3: any = i.mul(int(3))
      const anchor: any = vec3(
        posBuf.element(i3), posBuf.element(i3.add(int(1))), posBuf.element(i3.add(int(2))))
      const i6: any = i.mul(int(6))
      const wPx: any = metaBuf.element(i6.add(int(4)))
      const hPx: any = metaBuf.element(i6.add(int(5)))

      const clip: any = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(anchor, float(1))))
      /* CLIP-SPACE offsetting, scaled by the viewport: `2 / viewportSize` is NDC
         per pixel, and the `clip.w` factor survives the perspective divide. A
         view-space offset would be constant in DATA units and would therefore
         grow and shrink with zoom, which is the one thing text must not do. */
      const px: any = vec2(float(2).div(viewportSize.x), float(2).div(viewportSize.y))
      const v: any = positionGeometry
      const dx: any = v.x.mul(wPx).mul(px.x).mul(clip.w)
      /* The label rides ABOVE its anchor: half its own height plus the offset, so
         the text clears the glyph it names rather than sitting on it. */
      const dy: any = v.y.mul(hPx).add(float(offPx).add(hPx.mul(0.5))).mul(px.y).mul(clip.w)
      return vec4(clip.x.add(dx), clip.y.add(dy), clip.z, clip.w)
    })()

    const vUv: any = (varying as any)(vec4(
      metaBuf.element(instanceIndex.mul(int(6))),
      metaBuf.element(instanceIndex.mul(int(6)).add(int(1))),
      metaBuf.element(instanceIndex.mul(int(6)).add(int(2))),
      metaBuf.element(instanceIndex.mul(int(6)).add(int(3))),
    ))
    const op = this.opacity
    material.colorNode = (Fn as any)(() => {
      const q: any = uv()
      /* The quad's uv walks the label's own CELL of the atlas. v is flipped
         because the canvas grows DOWNWARD and the quad's v grows up. */
      const u: any = vUv.x.add(vUv.z.sub(vUv.x).mul(q.x))
      const vv: any = vUv.w.sub(vUv.w.sub(vUv.y).mul(q.y))
      const t: any = (texture as any)(atlasTex, vec2(u, vv))
      return vec4(t.r, t.g, t.b, t.a.mul(op))
    })()
    material.needsUpdate = true
    this.invalidate()
  }

  /** How many labels are actually drawn (after `max` and the shorter of the two
   *  input lists). */
  get count(): number { return this._count }

  /** Anchors, in data coordinates — what a host needs to decide which to show. */
  get anchors(): Float32Array { return this._anchors }

  dataBounds(): Bounds | null { return this._count > 0 ? this._bounds : null }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    /* The ATLAS is this drawable's own — built in its constructor, so freed here.
       That is the opposite of `Slice`'s texture, which is external and shared. */
    this._atlas?.dispose()
    this._atlas = null
    super.dispose()
  }
}
