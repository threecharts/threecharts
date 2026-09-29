import {
  InstancedMesh, MeshBasicNodeMaterial, SphereGeometry, FrontSide, Matrix4,
  type BufferGeometry,
} from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, vec3, instanceIndex, positionGeometry, uniform, attributeArray } from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds } from './limits'
import { markerGlowHex, hexToRgb, type MarkerRole, type MarkerState } from './selection/markerStates'

/** One marker: which vertex it sits on, and how it is currently reading. */
export interface VertexMarkerSpec {
  vertexId: number
  role?: MarkerRole
  state?: MarkerState
}

export interface VertexMarkersOptions {
  /** Sphere radius as a FRACTION of the mesh's bounding radius, so a marker is the
   *  same apparent size on a cortex in metres and on a unit test sphere. Default
   *  0.012. */
  scale?: number
  /** How many markers this can show before it must be rebuilt. The instance count is
   *  fixed at construction (three sizes the buffers there), so this is a ceiling and
   *  not an allocation — unused instances are parked at zero size. Default 64. */
  capacity?: number
  /** Default role for a marker that does not name one. */
  role?: MarkerRole
}

/**
 * Sphere radius as a fraction of the mesh's bounding radius.
 *
 * On a cortex (bounding radius ≈ 90 mm) this is ≈ 1.8 mm — a couple of pixels at the
 * zoom the chart opens at, which is the smallest thing still findable. The value the
 * original used, 0.012, came from a unit test sphere and lands under a pixel here.
 */
const DEFAULT_SCALE = 0.02
const DEFAULT_CAPACITY = 64
/** A pressed marker shrinks slightly — the 3-D equivalent of a button depressing. */
const PRESSED_SCALE = 0.94
/** Push the sphere out along the vertex normal by this many radii, so it sits ON the
 *  surface. Centred on the vertex it is half-buried, and at a grazing angle on a
 *  folded cortex the visible cap is nothing. */
const NORMAL_OFFSET = 0.9

/**
 * VertexMarkers — the spheres that mark selected vertices, as ONE instanced drawable.
 *
 * One `InstancedMesh` rather than a mesh per marker, because a selection is not
 * bounded by what a person can click: a region grown from a seed is thousands of
 * vertices, and that is a thousand draw calls and a thousand materials the moment the
 * region tools land. The per-marker position, colour and size live in storage buffers
 * the shader indexes by `instanceIndex`; `set()` rewrites them and re-uploads, which
 * is a buffer write and not a shader rebuild.
 *
 * `dataBounds()` is NULL on purpose. Markers are chrome: they must not enter the
 * axes' auto-limit computation, or clicking near the edge of the cortex would
 * re-frame the camera under the pointer.
 */
export class VertexMarkers extends Drawable {
  private readonly _mesh: InstancedMesh
  private readonly _material: MeshBasicNodeMaterial
  private readonly _geometry: BufferGeometry
  private readonly _capacity: number
  private readonly _radius: number
  private readonly _role: MarkerRole
  /** `[capacity × 3]` — marker centre in the host geometry's local frame. */
  private readonly _posArr: Float32Array
  private readonly _posBuf: any
  /** `[capacity × 3]` — the marker's colour. */
  private readonly _colArr: Float32Array
  private readonly _colBuf: any
  /** `[capacity]` — per-marker size multiplier; 0 parks an unused instance. */
  private readonly _sizeArr: Float32Array
  private readonly _sizeBuf: any
  private _markers: VertexMarkerSpec[] = []

  constructor(axes: Axes, geometry: BufferGeometry, opts: VertexMarkersOptions = {}) {
    const capacity = Math.max(1, Math.floor(opts.capacity ?? DEFAULT_CAPACITY))

    geometry.computeBoundingSphere()
    const meshRadius = geometry.boundingSphere?.radius ?? 1
    const radius = meshRadius * (opts.scale ?? DEFAULT_SCALE)

    // UNLIT, and that is a correction rather than a preference. A lit marker takes
    // the role colour through its EMISSIVE, which cannot be per-instance without a
    // node — and a per-instance `colorNode` on a lit material leaves only the dark
    // diffuse, which on this scene's rig renders a near-black sphere on a dark
    // background: drawn, correct, and invisible. Chrome should also read the same
    // brightness whichever way it faces.
    const material = new MeshBasicNodeMaterial({ side: FrontSide })

    const mesh = new InstancedMesh(new SphereGeometry(1, 16, 12), material, capacity)
    mesh.frustumCulled = false
    // The position comes from a buffer the shader reads, so the instance matrices are
    // identity and stay that way — three still requires them to be set.
    const identity = new Matrix4()
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, identity)
    mesh.instanceMatrix.needsUpdate = true
    mesh.renderOrder = 2

    super(axes, mesh)

    this._mesh = mesh
    this._material = material
    this._geometry = geometry
    this._capacity = capacity
    this._radius = radius
    this._role = opts.role ?? 'primary'

    this._posArr = new Float32Array(capacity * 3)
    this._colArr = new Float32Array(capacity * 3)
    this._sizeArr = new Float32Array(capacity)   // all zero → nothing drawn
    this._posBuf = (attributeArray as any)(this._posArr, 'vec3')
    this._colBuf = (attributeArray as any)(this._colArr, 'vec3')
    this._sizeBuf = (attributeArray as any)(this._sizeArr, 'float')

    const uRadius = (uniform as any)(radius)
    material.positionNode = (Fn as any)(() =>
      positionGeometry
        .mul(uRadius.mul(this._sizeBuf.element(instanceIndex)))
        .add(this._posBuf.element(instanceIndex)),
    )()
    material.colorNode = (Fn as any)(() => this._colBuf.element(instanceIndex))()

    this.invalidate()
  }

  /** The markers currently shown. */
  get markers(): readonly VertexMarkerSpec[] { return this._markers }

  /** How many markers this can show. */
  get capacity(): number { return this._capacity }

  /**
   * Replace the marker set. Buffer writes only — no rebuild, no reallocation.
   *
   * Silently TRUNCATES past `capacity` rather than growing: growing would mean a new
   * `InstancedMesh` and a new material, which drops the node graph mid-gesture. A
   * host that needs more should say so at construction.
   */
  set(markers: readonly VertexMarkerSpec[]): void {
    const pos = this._geometry.attributes.position
    const nrm = this._geometry.attributes.normal
    const n = Math.min(markers.length, this._capacity)
    this._markers = markers.slice(0, n)
    const off = this._radius * NORMAL_OFFSET

    for (let i = 0; i < n; i++) {
      const m = this._markers[i]
      const v = m.vertexId
      // Pushed OUT along the vertex normal — see NORMAL_OFFSET. Without a normal
      // attribute the marker simply sits at the vertex, half-buried but drawn.
      this._posArr[3 * i] = pos.getX(v) + (nrm ? nrm.getX(v) * off : 0)
      this._posArr[3 * i + 1] = pos.getY(v) + (nrm ? nrm.getY(v) * off : 0)
      this._posArr[3 * i + 2] = pos.getZ(v) + (nrm ? nrm.getZ(v) * off : 0)

      const role = m.role ?? this._role
      const state = m.state ?? 'rest'
      // The GLOW channel, not the base: unlit, the marker's one colour has to be the
      // one that reads, and the base is a dark well meant to sit under an emissive.
      const [r, g, b] = hexToRgb(markerGlowHex(role, state))
      this._colArr[3 * i] = r
      this._colArr[3 * i + 1] = g
      this._colArr[3 * i + 2] = b

      this._sizeArr[i] = state === 'pressed' ? PRESSED_SCALE : 1
    }
    // Park the rest at zero size — the instance still runs, and collapsing it to a
    // point is cheaper than re-sizing the mesh.
    for (let i = n; i < this._capacity; i++) this._sizeArr[i] = 0

    this._posBuf.value.needsUpdate = true
    this._colBuf.value.needsUpdate = true
    this._sizeBuf.value.needsUpdate = true
  }

  /** Drop every marker. */
  clear(): void { this.set([]) }

  /** Markers are CHROME — see the class docstring. */
  dataBounds(): Bounds | null { return null }

  protected onUpdate(): void { /* everything is a live buffer or uniform */ }

  dispose(): void {
    this._mesh.geometry.dispose()
    this._material.dispose()
    super.dispose()   // the host geometry is the caller's; the sphere above is ours
  }
}
