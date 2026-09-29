import {
  InstancedMesh, MeshStandardNodeMaterial, Group, Color, Vector3, Quaternion, Matrix4,
  DoubleSide, BufferGeometry, BufferAttribute,
} from 'three/webgpu'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Bounds } from './limits'

/** One directed link — e.g. a track's consecutive detection pair. Both ends are
 *  world-space positions; this drawable knows nothing about a mesh or a vertex
 *  normal, so a caller wanting the link to float off a surface (as the track
 *  effect does) offsets `from`/`to` itself before handing them over. */
export interface ArrowSegment {
  from: readonly [number, number, number]
  to: readonly [number, number, number]
}

export interface ArrowsOptions {
  /**
   * Shaft radius as a FRACTION of `meshRadius` (the constructor's second
   * argument) — the same mesh-relative idiom `SignMarkers.setScale` uses, so
   * the tube reads the same size on a cortex in metres and on a unit test
   * sphere. Live via `setRadius`.
   *
   * Default 0.008 (~0.64 mm on Subject01's ~80 mm bounding radius). HALVED
   * from an earlier 0.016 (~1.3 mm) — that value was tuned only against
   * visibility-vs-nothing (a clean pixel diff against an unlinked control
   * frame) and overcorrected: at 0.016 the tubes read as opaque smudges that
   * buried the `SignMarkers` glyphs they connect, which are the actual datum.
   * A track LINK is context; the marker is what a reader needs legible.
   * `Quiver`'s own default (`extent·0.025/clim[1]`, a robust-max-relative
   * length) is deliberately NOT the reference here — the app's own notes
   * record anchor-mode arrows at that default as sub-pixel on real data.
   */
  radius?: number
  /**
   * Fixed solid colour, live via `setColor`. Default a near-white.
   *
   * NOT a colormap, and deliberately not one of the diverging schemes already
   * in play here: the SIGN a track connects is already carried by the
   * `SignMarkers` glyphs at each end (orange/blue), and the cortex scalar
   * itself is drawn through `balance`/`curl` (blue↔white↔red-ish diverging
   * maps). A second diverging colour on the link would compete with both for
   * the same visual channel; a fixed neutral tone instead reads as
   * structure — "a track exists here" — leaving sign and magnitude to the
   * glyphs and the surface respectively.
   */
  color?: string
  /** Cross-section sides. Default 8 — enough to read as round at this radius
   *  without paying for it (the cost is in the SHARED geometry, not per
   *  instance — raising this does not scale with segment count). */
  sides?: number
  /**
   * How many segments this can show before the tail is dropped.
   *
   * A CEILING, not an allocation — the same idiom `SignMarkers.capacity` uses,
   * and for the same reason: BOTH instanced meshes (head + shaft-only, see the
   * class doc) are sized to this many instances ONCE, at construction, because
   * `InstancedMesh` cannot grow past its own instance-matrix buffer. Defaults
   * to the length of the segments passed to the constructor, so a one-shot
   * caller (build once, never call `setSegments`) needs nothing extra.
   *
   * A caller that will PUSH via `setSegments` on a hot cadence must pass this
   * explicitly, sized for the steady state — a caller measured at a ~100 ms
   * detection tick (critical-point tracking, ~10/s) saw 200–900+ segments per
   * run with its per-tick point count itself capped at 256. `TRACK_HISTORY_CAP`
   * (64) × 256 tracks is a 16,128 theoretical ceiling per sign, never
   * approached in practice — real per-tick totals stayed in the low hundreds.
   * The caller's own capacity constant sits well above the measured peak and
   * well below the theoretical one; this default merely covers the simple
   * one-shot case.
   */
  capacity?: number
}

const DEFAULT_RADIUS_FRACTION = 0.008
/**
 * Default fixed colour — near-white, used only when a caller passes no
 * `color`. The track-link caller always overrides this per sign; nothing
 * else builds an `Arrows` today.
 */
const DEFAULT_COLOR = '#f2f4f8'
const DEFAULT_SIDES = 8
/** Where the cone's base sits, as a fraction of the segment's own length. */
const HEAD_START = 0.62
/** Cone base radius = shaft radius × this. */
const HEAD_RADIUS_FACTOR = 2.4
/**
 * The TAIL rim's radius, as a fraction of the shaft's own (local, `1`)
 * radius — baked into the UNIT geometry itself, not a per-instance
 * parameter. Every arrow therefore tapers from THIN at its own `from` (the
 * OLDER end of a track step) to FULL WIDTH at its `to` (the NEWER one, where
 * the head sits, or the plain tip when a segment is too short for one) —
 * encoding time direction on every single segment, including a one-hop
 * track too short to ever carry a head. A taper reads under any orbit angle,
 * including edge-on, where a foreshortened arrowhead reads as a disc and
 * gives up its direction entirely.
 *
 * Because the taper's SHAPE is fixed in local space, it costs nothing beyond
 * the existing per-instance transform — no new instance attribute, no extra
 * shader read; only the shared geometry the constructor already builds once.
 * 0.35 keeps the thin end visibly thinner than the thick one without
 * shrinking to a hairline at the halved default radius.
 */
const TAIL_RADIUS_FRACTION = 0.35
/**
 * A segment shorter than this many shaft-radii gets a plain capped, tapered
 * frustum instead of a head. Derived, not eyeballed: the cone's own world-space
 * length is `(1 − HEAD_START) · segmentLength`, and for it to read as a
 * POINT rather than a squashed disc its length should exceed its own base
 * diameter by a margin — `1.2 ×` here. Solving that for `segmentLength` in
 * units of the (world) shaft radius gives this factor.
 */
const MIN_HEAD_LENGTH_FACTOR = (HEAD_RADIUS_FACTOR * 1.2) / (1 - HEAD_START)

type Vec3 = [number, number, number]

/**
 * Local UNIT geometry: tail at x=0, tip (or far cap, shaft-only) at x=1,
 * shaft radius 1 — scaled per-instance by the real radius/length via the
 * transform matrix `writeMatrices` builds. Non-indexed: three explicit
 * vertices per triangle, the same idiom `arrowShape.ts` uses, because a
 * cone's apex needs a DIFFERENT normal per fan wedge and an indexed single
 * tip vertex cannot carry more than one.
 */
function buildArrowGeometry(withHead: boolean, sides: number): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const push = (p: Vec3, n: Vec3): void => {
    positions.push(p[0], p[1], p[2]); normals.push(n[0], n[1], n[2])
  }
  const tri = (a: Vec3, an: Vec3, b: Vec3, bn: Vec3, c: Vec3, cn: Vec3): void => {
    push(a, an); push(b, bn); push(c, cn)
  }
  const ring = (x: number, r: number): Vec3[] =>
    Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2
      return [x, r * Math.cos(a), r * Math.sin(a)] as Vec3
    })

  const shaftEndX = withHead ? HEAD_START : 1
  // Tail rim at `TAIL_RADIUS_FRACTION`, not the shaft's full radius — see that
  // constant's doc. Every arrow tapers thin→thick along its own from→to.
  const r0 = ring(0, TAIL_RADIUS_FRACTION)  // tail rim
  const r1 = ring(shaftEndX, 1)             // shaft-end rim (= tip rim when there is no head)
  const tail: Vec3 = [0, 0, 0]
  const tailN: Vec3 = [-1, 0, 0]

  // Tail cap — a flat disc, one uniform backward normal (a true flat disc has
  // exactly one normal; no faceting to approximate).
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    tri(tail, tailN, r0[i], tailN, r0[j], tailN)
  }
  /*
   * Shaft side — a FRUSTUM wall (tail rim `TAIL_RADIUS_FRACTION`, shaft-end rim `1`),
   * not a true cylinder, so the wall's outward normal tilts by the taper's own slant
   * rather than staying purely radial. Same derivation the head cone's
   * `coneNormalAt` uses below: for a frustum of axial run `L` and radius change
   * `dR = r1 − r0`, the outward normal at azimuth θ is
   * `normalize(dR, L·cosθ, L·sinθ)` — `dR = 0` (a plain cylinder) recovers the old
   * purely-radial formula, so this is the general case rather than a different one.
   * Constant along each generator (independent of which ring a vertex sits on), so
   * — like the existing cylinder code — one normal per azimuth is reused for both
   * the r0 and r1 vertices at that angle, which is exact here, not an approximation.
   */
  const shaftDr = 1 - TAIL_RADIUS_FRACTION
  const frustumNormalAt = (angle: number): Vec3 => {
    const n: Vec3 = [shaftDr, shaftEndX * Math.cos(angle), shaftEndX * Math.sin(angle)]
    const len = Math.hypot(n[0], n[1], n[2])
    return [n[0] / len, n[1] / len, n[2] / len]
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    const ai = (i / sides) * Math.PI * 2
    const aj = (j / sides) * Math.PI * 2
    const nI = frustumNormalAt(ai), nJ = frustumNormalAt(aj)
    tri(r0[i], nI, r1[i], nI, r1[j], nJ)
    tri(r0[i], nI, r1[j], nJ, r0[j], nJ)
  }

  if (withHead) {
    const rHead = ring(HEAD_START, HEAD_RADIUS_FACTOR)
    const tip: Vec3 = [1, 0, 0]
    const shoulderN: Vec3 = [-1, 0, 0]
    // Flare shoulder — the flat, backward-facing step from the shaft's rim
    // out to the head's wider base. Same x on both rings, so this triangle
    // pair is what CLOSES the gap a naive shaft+cone pairing would leave
    // open when viewed end-on from behind.
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides
      tri(r1[i], shoulderN, rHead[i], shoulderN, rHead[j], shoulderN)
      tri(r1[i], shoulderN, rHead[j], shoulderN, r1[j], shoulderN)
    }
    /*
     * Cone side. The outward normal at a point on a cone's lateral surface is
     * perpendicular to the SLANT (base radius R, axial run L = 1 − HEAD_START):
     * rotate the slant tangent (L, −R) by 90° and keep the branch that tilts
     * back toward the BASE, away from the apex (the familiar ice-cream-cone
     * silhouette — a normal that leaned toward the tip would be inward-facing).
     * That gives, per azimuth θ: normalize(−R, L·cosθ, L·sinθ).
     *
     * Each fan wedge gets its OWN apex-vertex normal — the midpoint azimuth's —
     * which is the reason this geometry is non-indexed rather than sharing one
     * tip vertex across all `sides` triangles.
     */
    const L = 1 - HEAD_START
    const coneNormalAt = (angle: number): Vec3 => {
      const n: Vec3 = [-HEAD_RADIUS_FACTOR, L * Math.cos(angle), L * Math.sin(angle)]
      const len = Math.hypot(n[0], n[1], n[2])
      return [n[0] / len, n[1] / len, n[2] / len]
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides
      const ai = (i / sides) * Math.PI * 2
      const aj = (j / sides) * Math.PI * 2
      const aMid = ((i + 0.5) / sides) * Math.PI * 2
      tri(rHead[i], coneNormalAt(ai), rHead[j], coneNormalAt(aj), tip, coneNormalAt(aMid))
    }
  } else {
    // No head: cap the far end too, so a plain shaft reads as a solid rod
    // rather than an open tube.
    const tipCenter: Vec3 = [1, 0, 0]
    const tipN: Vec3 = [1, 0, 0]
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides
      tri(tipCenter, tipN, r1[j], tipN, r1[i], tipN)
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  return geo
}

function segmentLength(s: ArrowSegment): number {
  return Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2])
}

const UNIT_X = new Vector3(1, 0, 0)

/** Fill an `InstancedMesh`'s transform matrices from a segment list and set its
 *  final `.count` to however many were actually written (a segment shorter
 *  than `1e-9` is skipped rather than producing a NaN quaternion). */
function writeMatrices(mesh: InstancedMesh, segs: readonly ArrowSegment[], radius: number): void {
  const from = new Vector3(); const to = new Vector3(); const dir = new Vector3()
  const scale = new Vector3(); const q = new Quaternion(); const m = new Matrix4()
  let w = 0
  for (const s of segs) {
    from.set(s.from[0], s.from[1], s.from[2])
    to.set(s.to[0], s.to[1], s.to[2])
    dir.subVectors(to, from)
    const len = dir.length()
    if (len < 1e-9) continue
    dir.divideScalar(len)
    q.setFromUnitVectors(UNIT_X, dir)
    scale.set(len, radius, radius)
    m.compose(from, q, scale)
    mesh.setMatrixAt(w++, m)
  }
  mesh.count = w
  mesh.instanceMatrix.needsUpdate = true
}

/**
 * Arrows — oriented 3-D arrow segments (shaft + arrowhead), one instance per
 * `{from, to}` pair. The real-geometry answer to `Fibers`' 1px `LineSegments`:
 * GPU line rasterisation ignores `linewidth` on every platform that matters,
 * so width has to come from actual triangles instead.
 *
 * Positioned via a CPU-computed per-instance transform (`InstancedMesh.
 * setMatrixAt`) rather than a TSL vertex shader reading a GPU-resident
 * buffer — unlike `Quiver`'s per-frame-animated vector field, a segment list
 * here is a periodic CPU push (a few dozen segments per detection tick), so
 * there is no continuous animation to buy back by staying on the GPU. The
 * payoff: a plain instance matrix gets its NORMAL transform for free from
 * three's own `InstanceNode` (`transformNormal`, the inverse-scale-corrected
 * math a hand-written TSL normal node would otherwise have to reimplement) —
 * which is what makes the arrowhead's CONE actually shade like a cone rather
 * than a smeared blob under a non-uniform (length ≠ radius) scale.
 *
 * Lit (`MeshStandardNodeMaterial`, like `Surface`) rather than unlit like
 * `Quiver`: a camera-facing flat glyph (Quiver's own shape) always faces the
 * viewer and never varies with the 3D axes' key/fill rig, so it cannot read
 * as sitting IN the folds of a surface the way a genuinely lit solid can.
 * `DoubleSide`, like `Quiver`/`SignMarkers` — not `Surface`'s `FrontSide` —
 * because every normal here is assigned explicitly rather than implied by
 * winding, so there is no correctness reason to cull a face, only a
 * robustness one: a segment can be viewed from any orbit angle.
 *
 * TOO SHORT for a readable head (`MIN_HEAD_LENGTH_FACTOR`) falls back to a
 * plain capped, tapered frustum, drawn by a SECOND `InstancedMesh` sharing
 * the same material — a cone squeezed shorter than its own base radius reads
 * as a squashed blob, not a point, which is a worse arrow than none at all.
 * The taper (`TAIL_RADIUS_FRACTION`) still applies to this fallback, so even
 * a one-hop track too short for a head reads its own direction.
 *
 * The constructor's segment list is the initial content, not the only one:
 * `setSegments` (below) rewrites both meshes' instance matrices IN PLACE,
 * mirroring `SignMarkers.setMarkers` — pre-allocated buffers, a fixed
 * `capacity` ceiling, no dispose, no rebuild. A caller that updates on a hot
 * cadence (a track's segment set changing on every detection tick, for
 * instance) MUST construct with an explicit `capacity` and push through
 * `setSegments` from then on; disposing and reconstructing on every update —
 * the one-shot shape this class started with — destroys and reallocates GPU
 * buffers at that cadence, which is its own bug class (a renderer can submit
 * an already-encoded frame against a buffer that was just freed).
 */
export class Arrows extends Drawable {
  private readonly _group: Group
  private readonly _material: MeshStandardNodeMaterial
  private readonly _withHead: InstancedMesh
  private readonly _shaftOnly: InstancedMesh
  /** The CURRENT segment list — mutable now that `setSegments` can replace it
   *  in place; never longer than `_capacity` (the tail is dropped on entry). */
  private _segments: readonly ArrowSegment[]
  private readonly _capacity: number
  private readonly _meshRadius: number
  private _radius: number
  private _color: Color

  constructor(axes: Axes, segments: readonly ArrowSegment[], meshRadius: number, opts: ArrowsOptions = {}) {
    const sides = Math.max(3, Math.floor(opts.sides ?? DEFAULT_SIDES))
    const radius = (opts.radius ?? DEFAULT_RADIUS_FRACTION) * (meshRadius || 1)
    const color = new Color(opts.color ?? DEFAULT_COLOR)

    const material = new MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0, side: DoubleSide })
    material.color = color
    // A PURELY diffuse tube goes near-black wherever it faces away from the
    // key/fill rig — measured: on the real cortex, most of a track's short
    // segments sit at exactly the grazing angle that produces this, and the
    // fix (Part 1's surface offset, Part 2's real geometry) would still read
    // as a scatter of dark flecks rather than a visible link. A modest
    // EMISSIVE component (its own colour, unlit) keeps every segment legible
    // regardless of orientation while the diffuse term still gives it
    // shading contrast against neighbouring facets — "lit like Surface" and
    // "actually visible from any angle" are both requirements, and a pure
    // `MeshStandardNodeMaterial` cannot do both on geometry this thin.
    material.emissive = color
    material.emissiveIntensity = 0.6

    // Capacity is the TOTAL segment count for BOTH instanced meshes, not the
    // count each bucket happens to get at construction — `setRadius` can move
    // a segment between the "head" and "shaft-only" bucket (the threshold is
    // radius-relative), and a mesh's instance buffer cannot grow past the
    // capacity it was built with. Slightly over-allocating the bucket that
    // starts smaller costs a few unused instances (hidden via `.count`, never
    // drawn), which is cheaper than rebuilding geometry on every `setRadius`
    // — or, now, on every `setSegments`. See `ArrowsOptions.capacity`'s own
    // doc for how a hot-cadence caller should size it.
    const capacity = Math.max(1, Math.floor(opts.capacity ?? segments.length))
    const meshHead = new InstancedMesh(buildArrowGeometry(true, sides), material, capacity)
    meshHead.frustumCulled = false
    const meshShaft = new InstancedMesh(buildArrowGeometry(false, sides), material, capacity)
    meshShaft.frustumCulled = false

    const group = new Group()
    group.add(meshHead); group.add(meshShaft)
    super(axes, group)

    this._group = group
    this._material = material
    this._withHead = meshHead
    this._shaftOnly = meshShaft
    this._capacity = capacity
    // Drop the tail here too — a constructor call over capacity (an explicit,
    // undersized `capacity` opt) must not size the meshes at `capacity` and
    // then hand `_layout` a longer list than either buffer can hold.
    this._segments = segments.length > capacity ? segments.slice(0, capacity) : segments
    this._meshRadius = meshRadius || 1
    this._radius = radius
    this._color = color
    this._layout(radius)
    this.invalidate()
  }

  /** Partition `_segments` by the head/shaft threshold at `radius` and fill both
   *  instanced meshes' matrices. Shared by the constructor and `setRadius`. */
  private _layout(radius: number): void {
    const headSegs: ArrowSegment[] = []
    const shaftSegs: ArrowSegment[] = []
    const minHeadLen = radius * MIN_HEAD_LENGTH_FACTOR
    for (const s of this._segments) {
      ;(segmentLength(s) >= minHeadLen ? headSegs : shaftSegs).push(s)
    }
    writeMatrices(this._withHead, headSegs, radius)
    writeMatrices(this._shaftOnly, shaftSegs, radius)
  }

  /** Shaft radius as a fraction of the `meshRadius` passed to the constructor —
   *  live, like `SignMarkers.setScale`: re-partitions head/shaft and rewrites
   *  both meshes' instance matrices, but rebuilds no geometry. */
  setRadius(fraction: number): void {
    this._radius = fraction * this._meshRadius
    this._layout(this._radius)
    this.invalidate()
  }

  /** The shaft radius in force, in DATA units (not the fraction). */
  get radius(): number { return this._radius }

  /**
   * Replace the segment set IN PLACE — the live-update counterpart to the
   * constructor's initial list, and the method a hot-cadence caller (see
   * `ArrowsOptions.capacity`) is expected to use instead of disposing and
   * reconstructing. Re-partitions head/shaft at the CURRENT radius and
   * rewrites both meshes' instance matrices; rebuilds no geometry, disposes
   * nothing.
   *
   * Beyond `capacity` the tail is dropped — the caller ranks, exactly like
   * `SignMarkers.setMarkers`. Dropping silently (not throwing, not warning) is
   * a deliberate choice shared with that class: a caller feeding this on every
   * detection tick should not have its render loop's error path double as its
   * capacity-tuning signal.
   */
  setSegments(segments: readonly ArrowSegment[]): void {
    this._segments = segments.length > this._capacity ? segments.slice(0, this._capacity) : segments
    this._layout(this._radius)
    this.invalidate()
  }

  /** How many segments are currently drawn (after any tail-drop). */
  get count(): number { return this._segments.length }

  /** The ceiling passed at construction (or inferred from the initial list). */
  get capacity(): number { return this._capacity }

  /** Fixed link colour (both the diffuse base and the emissive tint — see the
   *  class doc for why there are two). Live — one material write, no rebuild. */
  setColor(color: string): void {
    this._color = new Color(color)
    this._material.color = this._color
    this._material.emissive = this._color
    this._material.needsUpdate = true
    this.invalidate()
  }

  /** The colour in force. */
  get color(): string { return `#${this._color.getHexString()}` }

  /**
   * NULL on purpose. These segments lie ON the cortex (the caller already
   * offset them off its surface along the vertex normal), so they must not
   * enter the axes' `auto` limits the way `Fibers`' points extent does — one
   * detection near the mesh's edge would re-frame the whole cortex around a
   * stray link. Same reasoning `SignMarkers.dataBounds` and `Quiver`'s anchor
   * mode already use for the same class of glyph.
   */
  dataBounds(): Bounds | null { return null }

  dispose(): void {
    this._material.dispose()
    this._withHead.geometry.dispose()
    this._shaftOnly.geometry.dispose()
    this._group.remove(this._withHead, this._shaftOnly)
    super.dispose()
  }
}
