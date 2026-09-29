import { InstancedMesh, MeshBasicNodeMaterial, PlaneGeometry, Color } from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, instanceIndex, positionGeometry, uniform, varying, float, int, vec3, vec4, clamp, uv, texture, smoothstep, fwidth, select, step, modelViewMatrix, cameraProjectionMatrix, attributeArray } from 'three/tsl'

import { Drawable } from './Drawable'
import type { Axes } from './Axes'
import type { Limits, Bounds } from './limits'
import type { LegendEntry } from './AxesLegend'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import { categoricalColor, type CategoricalScheme } from './categorical'
import { asReadOnly } from './storage-access'
import { createVertexMask, type MaskSource, type VertexMask } from './vertex-mask'
import { isMovable, type Domain, type MovableDomain } from './domain/Domain'
import { resolveField, resolveFieldOrNull, type FieldSource, type ResolvedField, type Timepoint } from './field/source'

export type ParticlesMarker = 'circle' | 'ring' | 'square'
function markerIndex(m: ParticlesMarker): number { return m === 'square' ? 2 : m === 'ring' ? 1 : 0 }

export interface ParticlesOptions {
  xExtent?: Limits
  yExtent?: Limits
  /** z-extent for a 3D point cloud (the auto-cube's z range). Only used when `dims: 3`. */
  zExtent?: Limits
  /** Position buffer component count. 2 (default) → `[frames × count] vec2` (z=0, the
   *  2D scatter); 3 → `[frames × count] vec3` read as `.xyz` (a 3D cloud). The glyph is
   *  a CAMERA-FACING billboard either way, so it reads at any orbit angle. */
  dims?: 2 | 3
  /** Global point radius (data units) — a LIVE uniform (`particles.size.value`). Default 1.2. */
  size?: number
  /** Optional `[frames × count] float` per-point size buffer (multiplies the global size)
   *  — bubble/scatter sizing. Omit → every point uses the global size. */
  sizes?: FieldSource
  /** Optional `[frames × count] float` per-point VALUE buffer → the axes colormap
   *  (scatter color-by-value). Omit → the solid `color`. */
  values?: FieldSource
  /** Value range the `values` span, for the colormap normalize (+ colorbar). Default [0,1]. */
  clim?: Limits
  /**
   * Read the value channel as LABEL IDS through a categorical scheme instead of as
   * quantities through a ramp — a class-coloured point cloud. This is what the app's sensor MONTAGE wants: a
   * channel's group is an id, not a position on a ramp, and encoding it as
   * `t = (group + 0.5) / groupCount` against a categorical colormap row is a
   * workaround for the scheme that did not exist. Requires `values`.
   *
   * `clim` does not apply and is ignored; a label addresses its texel directly. The
   * scheme's ALPHA is respected, so label 0 (or any gap) is drawn invisible rather
   * than black.
   */
  categorical?: CategoricalScheme
  /** Solid color when `values` is omitted. */
  color?: string
  /** Marker shape (procedural, anti-aliased in the fragment). Default 'circle'. Live
   *  via `particles.setMarker(...)` / `particles.markerType`. */
  marker?: ParticlesMarker
  /** Optional sprite TEXTURE — its alpha channel is the marker shape (custom glyphs);
   *  overrides `marker`. The color still comes from `values`/`color`. */
  texture?: unknown
  /** Depth-test the points (default false — the flat-scatter default). Set true when
   *  the points sit on a 3D SURFACE so far-side points are hidden behind it. */
  depthTest?: boolean
  /** STATIC anchors: read positions at `instanceIndex` (a `[count × 3]` buffer, no
   *  frame index) while `values`/`sizes` still animate at `frame·count + i`. For points
   *  pinned to fixed vertices whose COLOR/SIZE is driven by time (the app's point model). */
  positionsStatic?: boolean
  /**
   * The DOMAIN these points sit on — a `Surface`'s mesh, a point set. Implies
   * `positionsStatic`: a domain describes fixed addresses, so the points are read
   * at `instanceIndex` with no frame index while `values`/`sizes` still animate.
   *
   * Preferred over passing positions as `buffer`, and it supplies what that cannot:
   * the EXTENT (so the cloud contributes to auto-limits rather than nothing) and a
   * SHARED buffer, so one `setPositions` moves the surface and every glyph layer on
   * it together instead of three copies kept in step by hand.
   */
  domain?: Domain
  /**
   * Read `values`/`sizes` out of a CHANNEL-MAJOR buffer instead of a frame-major one:
   * point `i` reads `rowMap[i] · totalSamples + frame`.
   *
   * This is `Line`'s seam, and it exists for the same reason — so a second drawable
   * can animate from the resident recording page WITHOUT a copy. The page is
   * `[channels × totalSamples]`, one row per channel; a frame-major read would need
   * that transposed into `[frames × count]`, which is a buffer and a compute pass per
   * timepoint to produce something the page already contains. With a row map, sensor
   * positions drawn as points and sensor traces drawn as lines are two views of ONE
   * buffer, at zero extra cost.
   *
   * Both must be supplied together; omit them for the frame-major default.
   */
  rowMap?: unknown
  /** Row stride of the channel-major buffer `rowMap` indexes — see `rowMap`. */
  totalSamples?: number
  /**
   * Read `values` at `instanceIndex` — one value per point, never animated — while
   * `sizes` still follows the frame.
   *
   * That split is what lets COLOUR carry identity and SIZE carry activity. A point
   * cloud whose colour animates over a scientific colormap is busy: every dot changes
   * hue every frame and the eye has nothing stable to hold. Static colour (which
   * sensor, which lobe) with animated size reads as a field pulsing over a fixed
   * array.
   */
  valuesStatic?: boolean
  /**
   * How `sizes` maps to a radius — and, with it, what every signal-driven channel
   * means, since all of them read the same normalized activation.
   *
   *   `multiply`  (default) size = sizes[i] · size. The raw multiplier.
   *   `magnitude` activation = clamp(|v| / hi, 0, 1). Rest is 0; both signs grow.
   *   `signed`    activation = clamp(1 + v / hi, 0, 2). Rest is 1; negative shrinks
   *               toward 0, positive grows toward 2.
   *
   * `multiply` is wrong for data that swings about zero — a negative radius mirrors
   * the quad rather than shrinking it, so the dot looks the same size and the sign is
   * silently lost. The other two are both correct and answer different questions:
   *
   *   `magnitude` asks HOW MUCH is happening. A dipole's two lobes look identical,
   *               which for a field with a + and a − side loses the pattern itself.
   *   `signed`    asks WHICH WAY. The neutral state is a definite, visible baseline
   *               and the two lobes separate — the diverging convention a topographic
   *               map uses, moved onto size and light.
   *
   * The channels are NOT symmetric under `signed`, and cannot be: light does not go
   * negative. Size and brightness swing both ways about their neutral (smaller/dimmer
   * for one sign, larger/brighter for the other); the CORONA only emits above
   * neutral, because a negative halo is not a thing you can draw. That asymmetry is
   * the honest reading — the corona marks one polarity rather than misreporting both.
   */
  sizeMode?: 'multiply' | 'magnitude' | 'signed'
  /** Range `sizes` spans under `sizeMode: 'magnitude'`. Default [0, 1]. */
  sizeDomain?: Limits
  /**
   * HOW MUCH activation modulates the radius under `sizeMode: 'magnitude'` — 1
   * (default) the full ramp, 0 every point at the flat `size`. Live via
   * `particles.sizeGain`.
   *
   * A uniform rather than a mode, so "does size animate?" is a control and not a
   * rebuild: the signal is still read (the corona and the brightness need it), only
   * the radius stops listening.
   */
  sizeGain?: number
  /**
   * A CORONA around each point whose strength follows the signal — 0 (default) off,
   * 1 a strong halo. Live via `particles.glow`.
   *
   * This is glow WITHOUT a bloom pass, and the distinction is the whole point: real
   * bloom is a post-processing chain (extra full-resolution render targets, a mip
   * chain, several full-screen passes) that would apply to the ENTIRE figure — the
   * cortex would bloom too. This is a radial falloff in the same fragment shader,
   * over the radial distance the marker already computes, so it costs a few ALU ops
   * and some overdraw and nothing else.
   *
   * The quad is enlarged at CONSTRUCTION to make room for the corona (`glow` sets how
   * much), so changing the uniform later modulates the halo's intensity within that
   * room rather than its reach. Needs `sizes` + `sizeDomain` — the corona follows the
   * signal, and without a clim there is no "how active is this".
   */
  glow?: number
  /**
   * Brighten each point toward white as the signal grows — 0 (default) off, 1 doubles
   * it at full activation. Live via `particles.luminance`.
   *
   * Free (one multiply on a colour already in a register), and it composes with a
   * STATIC colour: hue keeps saying which sensor this is while brightness says how
   * active it is. Note there is no tone mapping in this renderer, so values above 1
   * clip — the ramp desaturates toward white rather than blooming.
   */
  luminance?: number
  /** ADVECTION along tracks (`dims:3`): `buffer` is the resident TRACKS — a `[nVerts] vec3`
   *  (e.g. the Fibers points) — and each particle GATHERS its position from it, driven by
   *  the clock with NO per-frame compute (the geometry IS the velocity field). Solid
   *  `color` + uniform `size` (values/sizes ignored). Two steppings:
   *
   *  • `'index'` (default) — PARAMETER stepping: position at
   *    `fiberId·nPoints + (pSeed + frame) mod nPoints`, one segment per frame. Uniform
   *    RULE but NOT uniform physical speed (segment lengths differ), and stepwise.
   *
   *  • `'arclength'` — CONSTANT PHYSICAL SPEED + smooth interpolation. Requires tracks
   *    RESAMPLED arc-uniformly within each fiber, so arc → index is linear and no shader
   *    search is needed: `s = (sSeed + speed·time) mod total[f]`, `pf = s/total·(nPoints−1)`,
   *    then lerp between `floor(pf)` and the next point. Driven by the clock's CONTINUOUS
   *    `timeUniform`. Particles on long fibers take proportionally longer to arrive
   *    (conduction delay), instead of all arriving together.
   *
   *  `fiberId`/`pSeed`/`sSeed` are `[count]` float buffers; `total` is `[nFibers]`. */
  advect?: {
    fiberId: unknown
    nPoints: number
    mode?: 'index' | 'arclength'
    /** index mode: per-particle START point index. */
    pSeed?: unknown
    /** arclength mode: per-fiber TOTAL arc length `[nFibers]`. */
    total?: unknown
    /** arclength mode: per-particle START arc length (same units as the points). */
    sSeed?: unknown
    /** arclength mode: arc length per clock unit — live via `particles.speed`. */
    speed?: number
  }
  /** What the colorbar says about this cloud — see `Particles.legend`. Omit for none. */
  legend?: { title?: string; unit?: string }
  /**
   * Per-point visibility, `[count]` — 1 draws, 0 does not. The app's hemisphere hide.
   *
   * Applied by collapsing the point's quad to zero area rather than by discarding in
   * the fragment: the mask is a per-INSTANCE value, so a branch on it would be
   * divergent inside the workgroup for one multiply's worth of work — the same shape
   * and the same reason as `Quiver`'s mask.
   */
  mask?: MaskSource
  /** Override the frame uniform (defaults to the Figure clock's shared uniform). */
  timepoint?: Timepoint
}

/**
 * Particles — a point cloud drawn from a `[frames × count] vec2` position buffer in
 * an EXTERNAL GPU storage buffer (arrangement 1). One instanced disc per particle;
 * the VERTEX shader reads the buffer (read-only) at the shared Clock's frame for the
 * particle's position, and offsets the base disc to it. `timepoint` is a live uniform
 * → advancing it moves every particle to its next stored position, zero re-upload.
 */
export class Particles extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _mesh: InstancedMesh
  private readonly _xExtent: Limits
  private readonly _yExtent: Limits
  private readonly _zExtent: Limits | null
  /** The domain these points sit on, when there is one. */
  private readonly _domain: Domain | null
  private readonly _boundsUnknown: boolean
  /** Read `values` as labels through this scheme, or null → a continuous ramp. */
  private _categorical: CategoricalScheme | null
  /** Set only when this drawable owns its position buffer — see the constructor. */
  private readonly _field: ResolvedField
  private readonly _mask: VertexMask | null
  private readonly _values: unknown
  private readonly _vValue: any        // per-point value varied to the fragment (colormap)
  private readonly _alpha: any         // marker-shape alpha node (procedural or texture)
  private readonly _vAct: any          // per-point activation varied to the fragment, or null
  private readonly _lumFactor: (a: any) => any   // activation → brightness multiplier
  private _lastColormap = ''
  /** Live global point-size uniform — set `.value` to scale every point (zero re-upload). */
  readonly size: any
  /** Live marker-shape uniform (0 circle · 1 ring · 2 square). Use `setMarker(...)`. */
  readonly markerType: any
  /** Live size-ramp depth (see `ParticlesOptions.sizeGain`) — 0 freezes the radius at
   *  `size` while the corona and brightness keep animating. */
  readonly sizeGain: any
  /** Live corona strength (see `ParticlesOptions.glow`). The quad's ROOM for the halo is
   *  fixed at construction, so this modulates intensity within it, not reach. */
  readonly glow: any
  /** Live brightness ramp (see `ParticlesOptions.luminance`). */
  readonly luminance: any
  /** Live arc-length ADVECTION speed uniform (arc length per clock unit) — only meaningful
   *  with `advect.mode: 'arclength'`; set `.value` to change the physical speed live. */
  readonly speed: any

  constructor(axes: Axes, positions: FieldSource, count: number, opts: ParticlesOptions = {}) {
    const xExtent = opts.xExtent ?? [0, 1]
    const yExtent = opts.yExtent ?? [0, 1]
    const P = count
    const tp: any = opts.timepoint ?? axes.figure.clock.frameUniform
    /*
     * A **Float32Array** position buffer is copied into a buffer this drawable OWNS,
     * and `setPositions` can then rewrite it — which is what lets a cloud follow a
     * surface being smoothed or inflated, since a point left at the folded vertex would
     * float off the moved cortex. Anything else is an external storage node, read only,
     * and `setPositions` throws: the same two-source contract `Quiver`'s anchors and
     * `VertexMask` use, for the same reason — a caller who did not hand over a buffer
     * cannot be handed write access to one.
     */
    /* `vec3`, matching the shader's per-instance read. Note this is the ONE place
       the flat-float layout `pointsDomain` uses is not applied — a positions buffer
       reached through a domain gets that safer path, and this legacy entry keeps the
       element type its callers already upload. */
    const field = resolveField(positions, 'vec3')
    const buf: any = field.node
    const sizesBuf: any = resolveFieldOrNull(opts.sizes)?.node ?? null
    const valuesBuf: any = resolveFieldOrNull(opts.values)?.node ?? null
    const idxOf = (p: any) => int(tp).mul(int(P)).add(p)   // frame slice + instance
    // Channel-major alternative: point i reads row `rowMap[i]` of a `[channels × total]`
    // buffer at the current frame. See `ParticlesOptions.rowMap`.
    const rowMapBuf: any = opts.rowMap ? asReadOnly(opts.rowMap) : null
    const totalSamples = opts.totalSamples ?? 0
    // The SIGNAL index — channel-major through the row map, else frame-major.
    const sigIdx = rowMapBuf && totalSamples > 0
      ? (p: any) => int(rowMapBuf.element(p)).mul(int(totalSamples)).add(int(tp))
      : idxOf
    // Values may be pinned per point while sizes animate — see `valuesStatic`.
    const valIdx = opts.valuesStatic ? (p: any) => p : sigIdx

    /** `sizes[idx]` → a radius, per `sizeMode`. */
    const signedSize = opts.sizeMode === 'signed'
    const magnitudeSize = opts.sizeMode === 'magnitude' || signedSize
    const sd = opts.sizeDomain ?? [0, 1]
    const sizeHi = Math.max(Math.abs(sd[0]), Math.abs(sd[1])) || 1
    /** Where the signal sits on the channels' scale: 0 at rest under `magnitude`, 1 at
     *  rest under `signed`. ONE fetch feeds every channel that follows the signal
     *  (radius, corona, brightness), which is why adding a channel is free — arithmetic
     *  on a value already in a register, not a second read. */
    const NEUTRAL = signedSize ? 1 : 0
    const activation = (p: any): any | null => {
      if (!sizesBuf) return null
      const v: any = sizesBuf.element(sigIdx(p))
      return signedSize
        ? clamp(float(1).add(v.div(float(sizeHi))), float(0), float(2))
        : clamp(v.abs().div(float(sizeHi)), float(0), float(1))
    }
    // Idle points keep a floor: a sensor array whose quiet channels vanish reads as a
    // broken array rather than a quiet one.
    const SIZE_FLOOR = 0.18
    const radius = (sBuf: any, p: any) => {
      if (!sBuf) return sizeU
      if (!magnitudeSize) return sBuf.element(sigIdx(p)).mul(sizeU)
      const a: any = activation(p)
      // Under `signed` the activation IS the factor (1 at rest, 2 at the positive end),
      // floored so the negative extreme shrinks to a visible dot rather than to nothing.
      const ramp: any = signedSize
        ? a.max(float(SIZE_FLOOR))
        : float(SIZE_FLOOR).add(a.mul(float(1 - SIZE_FLOOR)))
      // mix(1, ramp, gain): at gain 0 the radius is exactly the flat `size`, so turning
      // the channel off leaves the dots the size the slider says — not the floor.
      return sizeU.mul(float(1).add(ramp.sub(float(1)).mul(sizeGainU)))
    }
    /** The QUAD's half-extent: the dot's radius plus the corona's room. */
    const quadHalf = (sBuf: any, p: any) => {
      const r = radius(sBuf, p)
      return glowAmt > 0 ? r.mul(float(quadK)) : r
    }

    const material = new MeshBasicNodeMaterial()
    material.depthTest = opts.depthTest ?? false; material.depthWrite = false
    material.transparent = true   // soft, anti-aliased marker edges (alpha)

    const glowAmt = Math.max(0, Math.min(1, opts.glow ?? 0))
    // ROOM for the corona. The quad IS the dot today, so a halo needs the quad enlarged
    // and the core drawn smaller inside it — the same constant on both sides, which is
    // why this one is baked rather than live. `size` keeps meaning the DOT's radius: the
    // expansion is applied to the quad, not to the uniform, so the live setter is
    // unchanged and a caller never has to know the halo exists.
    const quadK = 1 + 1.2 * glowAmt
    const sizeU = (uniform as any)(opts.size ?? 1.2)
    const glowU = (uniform as any)(glowAmt)
    const sizeGainU = (uniform as any)(opts.sizeGain ?? 1)
    const lumU = (uniform as any)(Math.max(0, opts.luminance ?? 0))
    const speedU = (uniform as any)(opts.advect?.speed ?? 0)
    const dims = opts.dims ?? 2
    // A domain describes FIXED addresses, so it implies static positions.
    const posStatic = opts.domain != null || (opts.positionsStatic ?? false)
    /* Declared before the vertex nodes, which close over it. */
    const maskNode: VertexMask | null = opts.mask != null ? createVertexMask(opts.mask, P) : null

    if (dims === 3 && opts.advect) {
      // 3D ADVECTION along tracks — the position is GATHERED from the resident tracks
      // (buf, [nVerts] vec3); only the arc→vertex indexing differs by mode. Shared
      // camera-facing billboard tail (same as the plain dims:3 path below).
      const { fiberId, pSeed, nPoints: nP, total, sSeed } = opts.advect
      const fidBuf: any = asReadOnly(fiberId)
      const billboard = (c: any): any => {
        const v: any = positionGeometry
        const mv: any = modelViewMatrix.mul(vec4(c.x, c.y, c.z, float(1)))
        const s: any = glowAmt > 0 ? sizeU.mul(float(quadK)) : sizeU
        return cameraProjectionMatrix.mul(vec4(mv.x.add(v.x.mul(s)), mv.y.add(v.y.mul(s)), mv.z, mv.w))
      }
      if ((opts.advect.mode ?? 'index') === 'arclength') {
        // ARC-LENGTH stepping: advance a physical arc `s` at ONE speed for every particle,
        // then map arc → fractional index. That map is linear ONLY because the tracks are
        // resampled arc-uniformly within each fiber — which is what buys us a plain divide
        // instead of a per-particle binary search. Lerping the two bracketing points makes
        // the motion continuous, so this reads from the clock's CONTINUOUS timeUniform.
        const totBuf: any = asReadOnly(total), ssBuf: any = asReadOnly(sSeed)
        const tCont: any = opts.timepoint ?? axes.figure.clock.timeUniform
        material.vertexNode = (Fn as any)(() => {
          const i: any = instanceIndex
          const fid: any = int(fidBuf.element(i))
          const base: any = fid.mul(int(nP))
          const L: any = totBuf.element(fid).max(float(1e-9))                 // guard 0-length fibers
          const s: any = ssBuf.element(i).add(speedU.mul(tCont)).mod(L)
          const pf: any = s.div(L).mul(float(nP - 1))                         // arc → fractional index
          const p0: any = int(pf)
          const u: any = pf.sub(float(p0))
          const a: any = buf.element(base.add(p0))
          const b: any = buf.element(base.add(p0.add(int(1)).min(int(nP - 1))))  // clamp at the last point
          return billboard(a.add(b.sub(a).mul(u)))                            // lerp → smooth
        })()
      } else {
        // INDEX (parameter) stepping: one segment per frame at
        // fiberId·nPoints + (pSeed + frame) mod nPoints. Uniform rule, non-uniform speed.
        const psBuf: any = asReadOnly(pSeed)
        material.vertexNode = (Fn as any)(() => {
          const i: any = instanceIndex
          const fid: any = int(fidBuf.element(i))
          const ps: any = int(psBuf.element(i))
          const p: any = ps.add(int(tp)).mod(int(nP))                         // parameter step, wrap
          return billboard(buf.element(fid.mul(int(nP)).add(p)))
        })()
      }
    } else if (dims === 3) {
      // 3D — CAMERA-FACING BILLBOARD: read the particle's world center from the buffer
      // at frame t, transform it to view space, then add the quad corner (±1 · size) in
      // VIEW space and project. This keeps the disc square-on to the camera at any orbit
      // angle. `vertexNode` fully replaces the transform (needed to offset in view space).
      material.vertexNode = (Fn as any)(() => {
        // A domain answers "where is address i" the same way for every drawable on
        // it; without one, the position comes from this drawable's own buffer.
        const raw: any = opts.domain
          ? opts.domain.positionAt(instanceIndex)
          : buf.element(posStatic ? instanceIndex : idxOf(instanceIndex))
        // Masked ⇒ a zero-area quad, which produces no fragments. See `mask`.
        const s0: any = quadHalf(sizesBuf, instanceIndex)
        const s: any = maskNode
          ? s0.mul(step(float(0.5), maskNode.node.element(instanceIndex)))
          : s0
        const v: any = positionGeometry                                      // quad corner ∈ [-1,1]
        const mv: any = modelViewMatrix.mul(vec4(raw.x, raw.y, raw.z, float(1)))
        const billboarded: any = vec4(mv.x.add(v.x.mul(s)), mv.y.add(v.y.mul(s)), mv.z, mv.w)
        return cameraProjectionMatrix.mul(billboarded)
      })()
    } else {
      // 2D — unchanged: offset the quad in world x/y on the z=0 plane; three applies the
      // ortho MVP + the axes clip box. (The top-down camera makes this a billboard too.)
      material.positionNode = (Fn as any)(() => {
        const idx = sigIdx(instanceIndex)
        const pos: any = buf.element(idx)  // vec2 position at frame t
        const s: any = quadHalf(sizesBuf, instanceIndex)
        const v: any = positionGeometry
        return vec3(pos.x.add(v.x.mul(s)), pos.y.add(v.y.mul(s)), float(0))
      })()
    }

    // Marker-shape alpha node. Procedural shapes are all computed, then SELECTED by a
    // live `markerType` uniform → the dropdown swaps shape with zero re-upload. A sprite
    // texture (if given) overrides them with its own alpha.
    const tex: any = opts.texture ?? null
    const markerU = (uniform as any)(markerIndex(opts.marker ?? 'circle'))
    // How active this point is, carried to the fragment. ONE interpolator, and only when
    // something downstream actually needs it.
    const vAct: any = (glowAmt > 0 || (opts.luminance ?? 0) > 0) && sizesBuf
      ? (varying as any)(activation(instanceIndex))
      : null
    const alpha: any = (() => {
      const u: any = uv()
      if (tex) return (texture as any)(tex, u).a                            // sprite texture → shape
      const d: any = u.sub(0.5).length().mul(2)                             // 0 centre → 1 at inscribed edge
      const w: any = fwidth(d).max(float(0.001))                           // screen-space AA width
      // With a corona the quad is `quadK` times the dot, so the CORE's edge is no longer
      // the quad's — it sits at 1/quadK, and every threshold scales with it.
      const core: any = d.mul(float(quadK))
      const disc: any = float(1).sub(smoothstep(float(1).sub(w), float(1), core))
      const inner = float(0.55)
      const innerDisc: any = float(1).sub(smoothstep(inner.sub(w), inner, core))
      const ring: any = disc.sub(innerDisc).max(float(0))
      const square: any = float(1)
      const shape: any = select(markerU.greaterThan(float(1.5)), square, select(markerU.greaterThan(float(0.5)), ring, disc))
      if (!vAct || glowAmt <= 0) return shape
      // The CORONA: a soft radial falloff over the room the quad was given, scaled by
      // activation. Squared twice — a linear falloff reads as a flat grey wash, and what
      // makes this look like light is that it drops off fast and reaches far.
      const fall: any = float(1).sub(clamp(d, float(0), float(1)))
      // Above NEUTRAL only. Under `signed` that is the positive lobe: a corona is light
      // being added, and there is no way to add a negative amount of it.
      const emit: any = NEUTRAL === 0 ? vAct : vAct.sub(float(NEUTRAL)).max(float(0))
      const halo: any = fall.mul(fall).mul(fall).mul(emit).mul(glowU)
      return clamp(shape.add(halo), float(0), float(1))
    })()

    /** Brightness as a multiplier: 1 at the neutral point, so `signed` DIMS below it
     *  and brightens above while `magnitude` only ever brightens. Floored at 0 — a
     *  negative multiplier would wrap the colour rather than darken it. */
    const lumFactor = (a: any): any =>
      float(1).add(a.sub(float(NEUTRAL)).mul(lumU)).max(float(0))

    // Solid color → set the colorNode once (RGB from `color`, alpha from the marker).
    if (!valuesBuf) {
      const c = new Color(opts.color ?? '#ffd27f')
      const rgb: any = vec3(float(c.r), float(c.g), float(c.b))
      material.colorNode = vec4(vAct ? rgb.mul(lumFactor(vAct)) : rgb, alpha)
    }

    // Per-point value → colormap: read in the vertex, vary to the fragment (constant
    // per instance since every glyph vertex shares the instanceIndex).
    const vValue = valuesBuf ? (varying as any)(valuesBuf.element(valIdx(instanceIndex))) : null

    const geo = new PlaneGeometry(2, 2)
    const mesh = new InstancedMesh(geo, material, P)
    mesh.frustumCulled = false
    super(axes, mesh)
    this._material = material
    this._mesh = mesh
    this._xExtent = xExtent
    this._yExtent = yExtent
    this._zExtent = dims === 3 ? (opts.zExtent ?? [-1, 1]) : null
    // Vertex-anchored 3D points (no explicit extents) can't know their spread from a
    // GPU buffer handle → contribute no auto-bounds (defer to the Surface they sit on).
    this._domain = opts.domain ?? null
    // Unknowable only without a domain AND without extents: a buffer handle the
    // host never described cannot be measured from here.
    this._boundsUnknown = !opts.domain && dims === 3 && !(opts.xExtent && opts.yExtent && opts.zExtent)
    this._clim = opts.clim ?? [0, 1]
    this._categorical = opts.categorical ?? null
    this._field = field
    this._mask = maskNode
    this.legend = opts.legend ? { title: opts.legend.title ?? '', unit: opts.legend.unit ?? '' } : null
    this._values = valuesBuf
    this._vValue = vValue
    this._alpha = alpha
    this._vAct = vAct
    this._lumFactor = lumFactor
    this.size = sizeU
    this.markerType = markerU
    this.speed = speedU
    this.glow = glowU
    this.luminance = lumU
    this.sizeGain = sizeGainU
    this.invalidate()
  }

  /** Swap the marker shape live (zero re-upload — flips the `markerType` uniform).
   *  No effect when a sprite `texture` was supplied (the texture is the shape). */
  setMarker(m: ParticlesMarker): void { this.markerType.value = markerIndex(m) }

  /**
   * What this cloud states in the legend, or null for nothing. Set by the host, like
   * `Surface.legend` — the drawable knows a buffer and a clim, never a quantity.
   */

  /** The legend entry, or null while hidden or colour-free. A cloud with a SOLID colour
   *  encodes nothing by colour and states nothing, exactly as `Quiver` does. */
  legendEntry(): LegendEntry | null {
    if (!this.legend || !this.visible || !this._vValue) return null
    /* A categorical cloud keys a swatch list, not a ramp — the fill comes from a
       lookup the bar does not sample, over ids with no order to put on an axis. */
    if (this._categorical) return null
    return {
      title: this.legend.title,
      unit: this.legend.unit,
      clim: this.clim(),
      colormap: this.colormap || this.axes.colormap,
    }
  }

  /**
   * Move every point — for a cloud pinned to a surface that is being inflated.
   *
   * Only when this drawable OWNS its positions (a `Float32Array` was handed to the
   * constructor). It rewrites the buffer in place and flags it: the buffer is not
   * reallocated, so every node already bound to it stays valid — the same mechanism
   * and the same reason as `Quiver.setAnchors`.
   */
  setPositions(p: Float32Array): void {
    /* A domain owns the positions when there is one, and writing THROUGH it is the
       point: the surface and every other glyph layer sharing that domain move in the
       same call. Three private copies kept in step by hand is what this replaces, and
       a layer left behind floats off the moved surface. */
    if (this._domain) {
      if (!isMovable(this._domain)) {
        throw new Error('Particles: the domain does not own its positions and cannot be moved')
      }
      ;(this._domain as MovableDomain).setPositions(p)
      this.invalidate()
      return
    }
    this._field.set(p)
    this.invalidate()
  }

  /** Whether the positions can be moved, and so whether `setPositions` will work. */
  get ownsPositions(): boolean {
    return this._domain ? isMovable(this._domain) : this._field.owned
  }

  /** The domain these points sit on, when there is one. */
  get domain(): Domain | null { return this._domain }

  /** Rewrite the per-point visibility mask. Values only — nothing rebuilds. */
  setMask(m: Uint8Array | Float32Array): void {
    this._mask?.set(m)
    this.invalidate()
  }

  /** The value range the colormap maps (for a colorbar), when color-by-value. */

  /**
   * Retarget the value→colormap range. Live, like `Quiver.setClim`.
   *
   * The clim is CAPTURED in the colour node, so this forces `onUpdate` past its
   * unchanged-colormap guard rather than writing a uniform — the same mechanism the
   * colormap swap uses, and the reason that guard is a field and not a `===` on the
   * options. A cloud whose clim never moved would render a correct field at the wrong
   * contrast the moment the scalar or the mode changed.
   */
  /** BAKED into the colour node — see `Drawable.onClimChanged`. */
  protected onClimChanged(): void { this._lastColormap = '' }
  dataBounds(): Bounds | null {
    if (this._domain) return this._domain.bounds()
    if (this._boundsUnknown) return null
    return this._zExtent
      ? { xlim: this._xExtent, ylim: this._yExtent, zlim: this._zExtent }
      : { xlim: this._xExtent, ylim: this._yExtent }
  }

  protected onUpdate(): void {
    if (!this._values) return   // solid color → no colorNode rebuild
    const cat = this._categorical
    // The scheme, not the colormap, is what a categorical cloud's node depends on.
    const key = cat ? `__cat:${cat.id}:${cat.width}` : this.effectiveColormap()
    if (key === this._lastColormap) return
    this._lastColormap = key
    const row = colormapRowOrNull(key)
    const [d0, d1] = this._clim
    const vv = this._vValue
    const a = this._alpha
    const act = this._vAct
    const lumF = this._lumFactor
    if (cat) {
      /* NO FLAT VARYING HERE, and that is not an omission. A point's value is
         per-INSTANCE: every vertex of the glyph carries the same label, so there is
         nothing between two labels for the rasteriser to interpolate through. The flat
         rule binds only where a value is interpolated ACROSS a primitive — a surface
         face, an image cell, a line segment. */
      this._material.colorNode = (Fn as any)(() => {
        const c: any = categoricalColor(vv, cat)
        const rgb: any = vec3(c.x, c.y, c.z)
        // The marker's own alpha (its anti-aliased edge) times the label's — an
        // unassigned point disappears instead of drawing a black dot.
        return vec4(act ? rgb.mul(lumF(act)) : rgb, a.mul(c.w))
      })()
      this._material.needsUpdate = true
      return
    }
    this._material.colorNode = (Fn as any)(() => {
      const vn = clamp(vv.sub(d0).div(d1 - d0), float(0), float(1))   // normalize to [0,1]
      const rgb: any = row === null
        ? vec3(vn, vn, vn)
        : (() => { const c = createColormapSampler('default').sample(vn, row) as any; return vec3(c.r, c.g, c.b) })()
      // Brightness follows the SIGNAL while hue keeps saying which point this is — the
      // two channels stay separable because one is a multiply on the other's output.
      return vec4(act ? rgb.mul(lumF(act)) : rgb, a)
    })()
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    super.dispose()
  }
}
