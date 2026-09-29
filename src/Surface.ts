import {
  Mesh, MeshStandardNodeMaterial, MeshBasicNodeMaterial, FrontSide, DoubleSide, Color, Vector2,
  type BufferGeometry, type Texture, type Plane,
} from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import {
  Fn, vec3, float, int, clamp, mix, fwidth, smoothstep, varying, vertexIndex, uniform, Discard,
  vec2, texture,
} from 'three/tsl'

import { Drawable } from './Drawable'
import { withClipping } from './clip'
import type { LegendEntry } from './AxesLegend'
import type { Axes } from './Axes'
import type { Limits, Bounds } from './limits'
import type { UpAxis } from './camera3d'
import { colormapRowOrNull, createColormapSampler } from './colormap-node'
import {
  contourMask, contourResolvability, zeroCrossingMask, bandCenter, resolveContourInterval,
  ZERO_HALF_WIDTH_FRACTION,
} from './contour-node'
import { createVertexMask, type MaskSource, type VertexMask } from './vertex-mask'
import { meshDomain, type MeshDomain } from './domain/meshDomain'
import { resolveField, type FieldSource , type Timepoint } from './field/source'

/** Resolve a colormap NAME → atlas row, or null (→ grayscale). */
/**
 * How the surface responds to light. Three states, because they are the three
 * distinct looks: `unlit` ignores normals, so there is no separate faceted-unlit.
 *
 * - `smooth` — lit, per-vertex normals. The default anatomical cortex.
 * - `flat`   — lit, faceted per-face normals (three derives them per fragment).
 * - `unlit`  — no shading variation at all; colour is the value, which is what
 *              you want when the colour IS the datum and shading would read as
 *              signal. (This is the mode a viewport labels "flat lighting".)
 */
export type SurfaceShading = 'smooth' | 'flat' | 'unlit'

/** Wireframe overlay: `true` for the default colour, or `{ color }`. */
export type SurfaceWireframe = boolean | { color?: string }

const DEFAULT_WIREFRAME_COLOR = '#787880'
const DEFAULT_SURFACE_COLOR = '#c9ccd6'
/** How much of its own colour the surface keeps when it is NOT painting a scalar — see
 *  the `shell` note in `applyNodes`. */
const NEUTRAL_DIM = 0.45
const DEFAULT_CONTOUR_COLOR = '#101018'
const DEFAULT_CONTOUR_WIDTH = 1.5
const DEFAULT_MINOR_RATIO = 5
const DEFAULT_SELECTION_BLEND: SelectionBlend = 'multiply'
const DEFAULT_SELECTION_COLOR = '#05070a'
const DEFAULT_SELECTION_ALPHA = 0.5
const DEFAULT_SELECTION_EDGE = '#7ce7c4'
const DEFAULT_SELECTION_EDGE_WIDTH = 2

/** A secondary contour layer: finer lines between the major ones, faded out when too
 *  dense to resolve. `true` takes every default. */
export type SurfaceMinorContours = boolean | {
  /** Draw them. Default true. Declaring the layer `{ enabled: false }` rather than
   *  omitting it is what keeps a later toggle a uniform write. */
  enabled?: boolean
  /** Minor lines per major interval. Default 5, minimum 2. */
  ratio?: number
  /** Line width in fragments. Default half the major width. */
  width?: number
  /** Line colour. Default the major colour. */
  color?: string
}

/** The zero-level highlight — the one contour a signed field always wants, and the one
 *  that rarely falls on a round multiple of the interval. `true` takes the defaults. */
export type SurfaceZeroCrossing = boolean | {
  /** Draw it. Default true — see `SurfaceMinorContours.enabled`. */
  enabled?: boolean
  /** Line width in fragments. Default 1.5× the major width. */
  width?: number
  /** Line colour. Default `#101018`. */
  color?: string
}

/**
 * Isolines over the surface scalar — antialiased contours drawn in the fragment
 * shader, with no line geometry and no second draw call (see `contour-node.ts`).
 *
 * **Every field here is LIVE**: each one is a uniform, so `setContours` retargets it
 * without recompiling the shader. The only structural facts are whether contours
 * exist at all, and whether the `minor` / `zeroCrossing` layers do — a Surface that
 * never declares them emits none of their instructions.
 */
export interface SurfaceContours {
  /** Draw them. Default true — declaring the option is the opt-in. Live, so an
   *  on/off toggle in the chrome costs a uniform write, not a rebuild. */
  enabled?: boolean
  /** Spacing between major lines, in the SCALAR's units. `'auto'` (the default)
   *  divides the clim into `bands`, and re-derives on `setClim`. */
  interval?: number | 'auto'
  /**
   * How many bands `interval: 'auto'` splits the clim into. Default 10.
   *
   * This, not `interval`, is the knob to put in front of a user: a contour COUNT
   * means the same thing on every field, where an interval in data units is only
   * meaningful once you know the clim — and the clim here can move by three
   * orders of magnitude between ‖J‖ and ∇·J. Live, and it keeps tracking the clim,
   * which a fixed `interval` deliberately does not.
   */
  bands?: number
  /**
   * Draw the MAJOR lines. Default true.
   *
   * Off leaves the `minor` and `zeroCrossing` layers standing, which is the only way
   * to get a zero-crossing-only reading — one line at the sign change and nothing
   * else. A width of 0 would not do it: the AA ramp is floored so `smoothstep` never
   * degenerates, so a zero-width line is a hairline, not an absence.
   */
  major?: boolean
  /** Major line width, in fragments (~1 = a one-pixel line). Default 1.5. */
  width?: number
  /** Major line colour. Default `#101018`. */
  color?: string
  /** Quantize the FILL to the contour bands — a choropleth rather than a continuous
   *  ramp. Free: it snaps the value before the colormap lookup, and the atlas does
   *  the rest. Default false. */
  filled?: boolean
  /** Finer lines between the major ones. Omit for none. */
  minor?: SurfaceMinorContours
  /** Highlight the zero level. Omit for none. */
  zeroCrossing?: SurfaceZeroCrossing
}

/**
 * Paint the colormap only where the scalar passes — elsewhere the surface keeps its
 * own `color`, so the geometry stays readable instead of being hidden under a field
 * that is mostly floor.
 *
 * This is how you isolate one SIDE of a signed field: `{ min: 0 }` leaves the positive
 * part painted and returns the rest to plain surface. It is not a colormap trick —
 * clamping the clim instead would map every excluded value onto one end of the ramp,
 * where a strong negative and a quiet region become the same colour and the map can no
 * longer say which it is showing.
 *
 * Both bounds are in DATA units, both optional, and `null` means "no gate on this
 * side" — distinct from `undefined` in a `setThreshold` patch, which means "leave this
 * side as it is".
 */
export interface SurfaceThreshold {
  /** Paint only where the value is ≥ this. `null` for no lower gate. */
  min?: number | null
  /** Paint only where the value is ≤ this. `null` for no upper gate. */
  max?: number | null
  /**
   * Fade width in DATA units — how far past the bound the colormap reaches full
   * strength. Default 0, which does NOT mean a hard edge: the ramp falls back to one
   * fragment of `fwidth`, so the boundary is antialiased in screen space at any zoom
   * rather than stair-stepping along the triangulation.
   */
  soften?: number
}

/**
 * A SELECTION overlay — a per-vertex `0..1` buffer tinted over the surface.
 *
 * Distinct from `mask`, and the distinction matters: a mask DISCARDS, so using one to
 * show a selection would hide everything that is not selected. This darkens what IS,
 * leaving the rest of the cortex legible — which is the only way to judge a selection
 * against the anatomy around it.
 *
 * Dark by default rather than tinted with a role colour, because the surface
 * underneath is colormapped: the bright end of `inferno` is brighter than any UI
 * colour, so a bright wash vanishes into it while a dark one reads everywhere.
 *
 * The buffer is per-VERTEX and interpolated across triangles, so a boundary that cuts
 * through a triangle comes out smooth — and a soft `0..1` selection (which is what
 * growing a region from a band-limited eigenbasis produces) renders as the feathered
 * edge it actually is, rather than being rounded to a staircase.
 */
export interface SurfaceSelection {
  /**
   * HOW the fill combines with the colour already there.
   *
   * `normal` replaces — a wash, and the reason a selection over a colormap reads
   * badly: it competes with whatever the field put there, so it disappears wherever
   * the two happen to agree. The others MODULATE, which is what a mask does:
   *
   *   `multiply`   base × colour — the darkroom mask. Preserves hue, scales
   *                luminance. Invisible where the base is already black.
   *   `screen`     the mirror: brightens. Invisible where the base is white.
   *   `overlay`    darkens the darks and brightens the lights, so it moves at BOTH
   *                ends — the widest-reading of the luminance blends, at the cost of
   *                reading a little like a lighting change.
   *   `desaturate` pulls toward luminance, leaving structure and removing colour.
   *                Independent of brightness, so it survives where multiply and
   *                screen each fail — but it fades out at a colormap's unsaturated
   *                ends (inferno is near-black and near-white at its extremes).
   *   `anatomy`    not a blend — a SUBSTITUTION. Drops the field and shows the
   *                surface's own `color`, so the selection is a window onto the plain
   *                cortex. The only one that reads at EVERY colormap value, because
   *                it composites with none of them.
   *
   * None of the true blends reads everywhere; that is a property of compositing
   * against an arbitrary colormap, not of the choice. `anatomy` escapes it by not
   * compositing, and the BORDER (`edgeColor`) covers the rest. Default `multiply`.
   */
  blend?: SelectionBlend
  /**
   * Threshold the mask at 0.5 before using it — a BINARY selection with a clean edge
   * rather than the soft ramp the buffer holds.
   *
   * The hardening is antialiased in screen space (one fragment of `fwidth`), so the
   * boundary is crisp without being jagged. Worth turning on with `anatomy`, where a
   * feathered cutout reads as a smudge rather than as a window; worth leaving off for
   * the tinting blends, where the softness is information — a region grown from a
   * band-limited basis genuinely has a gradient at its edge. Default false.
   */
  hard?: boolean
  /**
   * Apply the fill to everything EXCEPT the selection — the focused view.
   *
   * With `anatomy` that isolates: the selected region keeps the field and the rest of
   * the cortex drops to plain surface, so one region is read without the rest of the
   * data competing for attention. The BORDER does not move — it is drawn at the mask's
   * half-crossing either way, which is the same curve.
   *
   * A uniform, not a rebuild, because it is a view toggle. The host must not turn it
   * on with an EMPTY selection: inverting nothing selects everything, and the whole
   * cortex would go blank — `attachVertexSelect` gates on the count for that reason.
   */
  invert?: boolean
  /** Fill colour — the blend's second operand. Default `#05070a`. */
  color?: string
  /** Fill strength where the value is 1. Default 0.5. */
  alpha?: number
  /**
   * BOUNDARY colour — a bright line at the selection's edge. Default `#7ce7c4`.
   *
   * The border is what actually makes a selection legible, and the fill alone is not:
   * a wash has to compete with whatever colour the field already put there, and over
   * a colormap there is no tint that stands out everywhere — darken and it vanishes
   * in the shadows, brighten and it vanishes in the highlights. A line does not
   * compete, because it is a shape rather than a shade.
   */
  edgeColor?: string
  /** Boundary width in FRAGMENTS, so it stays the same on screen at any zoom. 0 for
   *  no border. Default 2. */
  edgeWidth?: number
  /** Initial per-vertex values — a `Float32Array`/`Uint8Array` of length V, or an
   *  external storage node. Omit for none selected. */
  values?: MaskSource
}

/** How the selection fill combines with what is underneath — see `SurfaceSelection`. */
export type SelectionBlend =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'desaturate' | 'anatomy'

/** Rec. 709 luma — for `desaturate`, so the grey it pulls toward is the one the eye
 *  reads as the same brightness rather than a flat channel average. */
const LUMA = [0.2126, 0.7152, 0.0722] as const

/**
 * The blend, as a node. Branchless throughout: `overlay` picks per channel with a
 * hard `smoothstep` rather than a `select`, because the condition is per-CHANNEL on a
 * vec3 and a branch there would be three branches.
 */
function blendNode(blend: SelectionBlend, base: any, color: any, solid: any): any {
  switch (blend) {
    case 'anatomy':
      // Not a blend at all — a SUBSTITUTION. The field is removed and the surface's
      // own colour put back, so the selection is a window onto the plain cortex.
      // Nothing has to compete with the colormap because nothing is composited with
      // it; a region with no field in it cannot be mistaken for a region with one,
      // whatever the colormap was doing there.
      return solid
    case 'multiply':
      return base.mul(color)
    case 'screen':
      return base.oneMinus().mul(color.oneMinus()).oneMinus()
    case 'overlay': {
      const lo = base.mul(color).mul(float(2))
      const hi = base.oneMinus().mul(color.oneMinus()).mul(float(2)).oneMinus()
      return mix(lo, hi, smoothstep(float(0.4995), float(0.5005), base))
    }
    case 'desaturate': {
      const y = base.x.mul(LUMA[0]).add(base.y.mul(LUMA[1])).add(base.z.mul(LUMA[2]))
      return vec3(y, y, y)
    }
    default:
      return color
  }
}

/** The TSL uniforms backing one Surface's selection overlay. */
interface SelectionNodes {
  mask: VertexMask
  /** Mutable: `setSelectionStyle` swaps it and rebuilds. */
  blend: SelectionBlend
  /** Mutable, and structural for the same reason `blend` is. */
  hard: boolean
  /** LIVE — a view toggle, so a uniform rather than a rebuild. */
  invert: any
  color: any
  alpha: any
  edgeColor: any
  edgeWidth: any
}

/** The TSL uniforms backing one Surface's threshold. */
interface ThresholdNodes {
  minOn: any
  min: any
  maxOn: any
  max: any
  soften: any
}

/** The TSL uniforms backing one Surface's contours — built once, written thereafter. */
interface ContourNodes {
  enabled: any
  majorOn: any
  interval: any
  width: any
  color: any
  filled: any
  /** Each optional layer carries its OWN on/off. A width of 0 is not the same thing:
   *  the AA ramp is floored so `smoothstep` never degenerates, so a zero width leaves
   *  a hairline exactly on each level — invisible in principle, speckle in practice. */
  minor: { on: any; ratio: any; width: any; color: any } | null
  zero: { on: any; width: any; color: any } | null
}

const layerSpec = <T extends object>(v: boolean | T | undefined): T | null =>
  v == null || v === false ? null : (v === true ? ({} as T) : v)

/** Build the threshold uniforms. A bound that is off keeps its last VALUE, so turning
 *  it back on does not need one supplied again. */
function buildThreshold(spec: SurfaceThreshold): ThresholdNodes {
  const u = (x: number) => (uniform as any)(x)
  return {
    minOn: u(typeof spec.min === 'number' ? 1 : 0),
    min: u(typeof spec.min === 'number' ? spec.min : 0),
    maxOn: u(typeof spec.max === 'number' ? 1 : 0),
    max: u(typeof spec.max === 'number' ? spec.max : 0),
    soften: u(Math.max(0, spec.soften ?? 0)),
  }
}

/**
 * A CATEGORICAL lookup table: one texel per label, `NearestFilter`, no mipmaps.
 *
 * Set this and the scalar stops being a continuous quantity normalised through
 * `clim` and becomes a LABEL that addresses `lut` texel `id` directly. Two things
 * change together, and BOTH are required — either alone still bleeds:
 *
 *   • the scalar varying is flat-interpolated, so a triangle spanning labels 12 and
 *     30 does not walk through 13…29 painting regions that are not there;
 *   • the LUT is sampled NEAREST, so no colour is mixed between two slots.
 *
 * Flat interpolation takes the PROVOKING vertex's label (the triangle's first), so a
 * boundary face adopts one of its regions rather than the majority of its three. The
 * boundary can therefore sit one face from where a majority vote would put it — which
 * is the price of not unwelding the geometry, and invisible beside the fringe it
 * replaces.
 */
export interface SurfaceCategorical {
  /* A `CategoricalScheme` (`categorical.ts`) satisfies this shape exactly, and is what
     a caller should build — it carries the same texture plus the id, colours and names
     a legend needs, and it is the same object `Line`, `Particles` and `Quiver` take. */
  /** 1-row RGBA texture, `NearestFilter`, width = label count. */
  lut: Texture
  /** Texel count — the scalar `id` samples at `(id + 0.5) / width`, the texel centre. */
  width: number
}

export interface SurfaceOptions {
  /**
   * Share an EXISTING domain rather than making one from `geometry`.
   *
   * Pass the same domain to the glyph layers that sit on this surface and they all
   * read one set of vertices: `domain.setPositions` then moves the surface and its
   * glyphs in a single call. Omit and the surface builds its own from the geometry,
   * which is still shareable through `surface.domain`.
   */
  domain?: MeshDomain
  /**
   * Clip this surface with its own planes, leaving its siblings whole.
   *
   * The scalp cut open while the MRI planes inside it stay entire — which is only
   * expressible per-drawable, and is why this is here rather than on the axes.
   * Declare `[]` to make a later cut a plane MUTATION rather than a rebuild; see
   * `clip.ts`.
   */
  clip?: readonly Plane[] | null
  /** UNION (default) or INTERSECTION of `clip` — see `Drawable.setClip`. Live
   *  afterwards; declared here so the first render is already right. */
  clipIntersection?: boolean
  /**
   * Render BOTH faces of every triangle. `false` (the default) culls back faces,
   * which is what the canonical outward winding is for and is right for a closed
   * surface you look at from outside.
   *
   * Turn it on when the surface is CUT. A clip plane removes the near wall and
   * leaves the far wall facing away from the camera, so a front-face-only mesh
   * opens into nothing — the cut reads as a hole rather than as a section, and
   * the "look inside" the cut was made for is exactly what it fails to show.
   * three.js's own `webgl_clipping_intersection` sets `DoubleSide` for this
   * reason and no other.
   *
   * It does NOT touch the winding contract: normals still come from the canonical
   * faces, and three flips them per-fragment for a back face, so the interior
   * lights correctly rather than appearing flat.
   */
  doubleSided?: boolean
  /** Draw the scalar as discrete LABELS through a nearest LUT — see
   *  `SurfaceCategorical`. Omit for the ordinary continuous colormap. */
  categorical?: SurfaceCategorical
  /** Per-vertex scalar `[frames × V] float` in an external GPU storage buffer → the
   *  axes colormap on the surface. Read at `timepoint*V + vertexIndex` (the Image
   *  pattern, indexed by vertex). Omit → a solid matte `color`. */
  /** Per-vertex values — a `Float32Array`, or a GPU storage node when they came
   *  out of a compute pass. See `FieldSource`. */
  scalar?: FieldSource
  /** Value range the scalar spans (colormap normalize + colorbar). Default [0,1]. */
  clim?: Limits
  /** Solid surface color when `scalar` is omitted. */
  color?: string
  /** PBR roughness (0 glossy … 1 matte). Default 0.7 — a matte anatomical look. */
  roughness?: number
  /** Surface opacity — a LIVE uniform (`surface.opacity.value`). Default 1. At 0 the mesh
   *  is invisible but the geometry is still present, so it can be RAYCAST for picking while
   *  hidden. Below 1 the surface is transparent and does not write depth (so overlaid
   *  glyphs behind it stay visible). */
  opacity?: number
  /** Which scalar slice to read. Defaults to the Figure clock's frame uniform;
   *  pass a NUMBER when the buffer holds ONE timepoint (the host re-solves it per
   *  frame) or is static. */
  timepoint?: Timepoint
  /** Lighting/normals mode. Default `'smooth'`. */
  shading?: SurfaceShading
  /** Draw the triangle edges over the surface. Default false. */
  wireframe?: SurfaceWireframe
  /** Per-vertex visibility — a `Uint8Array`/`Float32Array` of length V (0 hides), or an
   *  external storage node. Masked fragments are discarded, so ANY subset works: one
   *  hemisphere, a middle component, an ROI, a thresholded statistic. Static per vertex
   *  (no frame slice) — it is a visibility choice, not a per-timepoint datum. */
  mask?: MaskSource
  /**
   * Which world axis of THIS MESH is "up" — the frame its vertices are already in.
   *
   * A surface is the axes' COORDINATE SYSTEM (its extent frames the cube), so it is
   * the one drawable that knows which way is up, and it is the right place to say
   * so: the fact belongs to the geometry, not to whoever happens to construct the
   * axes. Declaring it here means a mesh carries its own frame to every call site
   * instead of each one having to remember.
   *
   * `'y'` (default) is generic three.js. `'z'` is the neuroimaging convention —
   * Brainstorm SCS, +X anterior, +Y left, +Z superior, which is how a
   * `nxr.subject@1.0` cortex is stored. The axes ADOPTS it and orbits its camera
   * about that pole; **the vertices are never rotated**. That is deliberate: a
   * mesh's normals, and anything derived from them (surface divergence, glyph
   * directions), are expressed in this frame, so turning the data to suit the
   * viewer would silently reinterpret them.
   */
  upAxis?: UpAxis
  /**
   * Describe this layer in the axes LEGEND — a colour ramp with the scalar's name and
   * the clim's ends. Omit and the surface contributes no entry.
   *
   * On the drawable for the same reason `upAxis` is: only this object knows what its
   * colours mean, and the axes should not have to be told a second time. The entry is
   * rebuilt from the LIVE `colormap` and `clim()`, so retargeting either — which
   * is what switching scalar does — relabels the legend in the same frame.
   */
  legend?: SurfaceLegendSpec
  /**
   * Draw ISOLINES of the scalar over the surface. Omit for none — and a surface
   * without them emits no contour instructions at all, so this costs nothing to
   * leave off. See `SurfaceContours`; everything in it is live afterwards
   * (`setContours`).
   */
  contours?: SurfaceContours
  /**
   * Paint the colormap only where the scalar passes — see `SurfaceThreshold`. Omit for
   * none, and the surface emits no gate instructions. Declare it (even fully open) to
   * keep later changes uniform writes.
   */
  threshold?: SurfaceThreshold
  /**
   * Tint the surface where a per-vertex selection is set — see `SurfaceSelection`.
   * Declare it (even empty) to keep `setSelection` a buffer write.
   */
  selection?: SurfaceSelection
}

/** What a surface calls itself in the legend. `unit` is shown once beside the title;
 *  `''` means undeclared, and the clim's numbers still give the mapping. */
export interface SurfaceLegendSpec {
  title?: string
  unit?: string
}

/**
 * Surface — a lit triangulated MESH (the cortical surface) as a drawable, colored by a
 * per-vertex scalar read from an EXTERNAL GPU storage buffer (arrangement 1): the 3D
 * "Image on a manifold". The vertex shader reads the scalar at `timepoint*V +
 * vertexIndex`, varies it to the fragment, and colormaps it as the albedo of a lit
 * `MeshStandardNodeMaterial` (lit by the 3D axes' key/fill rig). `timepoint` is a live
 * uniform → advancing the clock recolors the surface with ZERO re-upload. Omit the
 * scalar for a plain matte cortex. Drop it in a `projection:'3d'` (orbit) axes — the
 * mesh's own vertices are the coordinate system (its extent frames the cube).
 *
 * `shading`, `wireframe` and `mask` are all live (`setShading`/`setWireframe`/`setMask`)
 * — the display properties a viewport drives from its own chrome.
 *
 * The caller owns the `BufferGeometry` (positions + indices + normals — e.g. from the
 * subject Zarr); Surface does not dispose it. The wireframe shares that same geometry,
 * so it costs no extra vertex memory and cannot drift out of sync with the surface.
 */
export class Surface extends Drawable {
  private readonly _lit: MeshStandardNodeMaterial
  private _unlit: MeshBasicNodeMaterial | null = null
  private readonly _mesh: Mesh
  private readonly _geometry: BufferGeometry
  private readonly _V: number
  /**
   * The mesh this surface is drawn on, as a domain.
   *
   * Public because it is the handle a glyph layer needs: `ax.quiver(v, { domain:
   * surface.domain })` puts arrows on exactly these vertices, framed by exactly this
   * extent, moving with exactly this mesh.
   */
  readonly domain: MeshDomain
  /**
   * Whether this drawable MADE its domain, and so whether it may free it.
   *
   * The same rule the geometry already follows — "geometry is the caller's". A
   * domain handed in is shared, by construction: the whole reason to pass one is
   * that a surface and its glyph layers read the same vertices, so freeing it on
   * this drawable's disposal would pull the buffer out from under the others.
   */
  private readonly _ownsDomain: boolean
  /** The clim as a LIVE uniform. `setClim` writes it, so retargeting the colormap
   *  range — which an auto-clim does every time the time cursor moves — is a buffer
   *  write and not a shader rebuild. */
  private readonly _climU: any
  /** The colormap's atlas ROW as a live uniform: every named map in a loaded library
   *  is one texture, so swapping between them is a coordinate change, not new code. */
  private readonly _rowU: any
  private readonly _scalar: any                 // read-only node, or null
  private readonly _tp: any
  private readonly _solidColor: Color
  private _shading: SurfaceShading
  private _mask: VertexMask | null = null
  /** A categorical LUT, or null for the ordinary continuous colormap. */
  private readonly _categorical: SurfaceCategorical | null
  private _wire: Mesh | null = null
  private _wireMat: MeshBasicNodeMaterial | null = null
  private _wireColor: string = DEFAULT_WIREFRAME_COLOR
  /** Which material the node graph was last built against — a material swap drops the
   *  graph, so it must be rebuilt. */
  private _nodesFor: object | null = null
  /** Did the last graph include the colormap SAMPLER? Only gaining or losing the atlas
   *  is structural; picking a different map inside it is `_rowU`. */
  private _builtWithAtlas = false
  /** The declared contour config, retained so a later `setContours` patch merges into
   *  it rather than replacing it. */
  private _contourSpec: SurfaceContours | null = null
  private _contours: ContourNodes | null = null
  private _threshold: ThresholdNodes | null = null
  private _selection: SelectionNodes | null = null
  /** Live opacity uniform — set `.value` (0 = invisible-but-pickable … 1 = opaque). */
  readonly opacity: any
  /**
   * 1 = the fill IS the scalar through the colormap; 0 = plain anatomy in the surface's
   * own colour. A LIVE uniform — see `setPaintScalar`.
   */
  private readonly _paintU: any
  /** The frame this mesh's vertices are in — see `SurfaceOptions.upAxis`. The axes
   *  reads it when the surface is added and points its camera pole accordingly. */
  readonly upAxis: UpAxis
  /** How this layer describes itself, or null for no legend entry. MUTABLE: the host
   *  retitles it when the scalar changes, which is the same event that retargets the
   *  clim and swaps the colormap. */
  legend: Required<SurfaceLegendSpec> | null

  constructor(axes: Axes, geometry: BufferGeometry, opts: SurfaceOptions = {}) {
    const V = geometry.attributes.position.count
    const side = opts.doubleSided ? DoubleSide : FrontSide
    const material = new MeshStandardNodeMaterial({ roughness: opts.roughness ?? 0.7, metalness: 0, side })
    const op = opts.opacity ?? 1
    const opacityU = (uniform as any)(op)
    if (op < 1) { material.transparent = true; material.depthWrite = false }
    material.opacityNode = opacityU

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    /* The clip GROUP becomes this drawable's scene node when planes are declared;
       `_mesh` stays the mesh, which is what every method below reaches for. */
    super(axes, withClipping(mesh, opts.clip, opts.clipIntersection))

    this._ownsDomain = opts.domain == null
    this.domain = opts.domain ?? meshDomain(geometry)
    this.upAxis = opts.upAxis ?? 'y'
    this.legend = opts.legend ? { title: opts.legend.title ?? '', unit: opts.legend.unit ?? '' } : null
    this._lit = material
    this._mesh = mesh
    this._geometry = geometry
    this._V = V
    this._clim = opts.clim ?? [0, 1]
    this._climU = (uniform as any)(new Vector2(this._clim[0], this._clim[1]))
    this._rowU = (uniform as any)(0)
    this._scalar = opts.scalar == null ? null : resolveField(opts.scalar, 'float').node
    this._tp = typeof opts.timepoint === 'number'
      ? (uniform as any)(opts.timepoint)          // one-slice buffer, off the clock
      : (opts.timepoint ?? axes.figure.clock.frameUniform)
    this._solidColor = new Color(opts.color ?? DEFAULT_SURFACE_COLOR)
    this._paintU = (uniform as any)(1)
    this._shading = opts.shading ?? 'smooth'
    /* Read once at construction: the colour node consults it, and a LUT that could
       change would mean rebuilding that node anyway. */
    this._categorical = opts.categorical ?? null
    this.opacity = opacityU

    if (opts.mask != null) this._mask = createVertexMask(opts.mask, V)
    if (opts.contours) {
      this._contourSpec = opts.contours
      this._contours = this.buildContours(opts.contours)
    }
    if (opts.threshold) this._threshold = buildThreshold(opts.threshold)
    if (opts.selection) {
      this._selection = {
        // An empty selection still needs its BUFFER, or the first `setSelection`
        // would be a structural change and rebuild the shader mid-gesture.
        mask: createVertexMask(opts.selection.values ?? new Float32Array(V), V),
        blend: opts.selection.blend ?? DEFAULT_SELECTION_BLEND,
        hard: opts.selection.hard ?? false,
        invert: (uniform as any)(opts.selection.invert ? 1 : 0),
        color: (uniform as any)(new Color(opts.selection.color ?? DEFAULT_SELECTION_COLOR)),
        alpha: (uniform as any)(opts.selection.alpha ?? DEFAULT_SELECTION_ALPHA),
        edgeColor: (uniform as any)(new Color(opts.selection.edgeColor ?? DEFAULT_SELECTION_EDGE)),
        edgeWidth: (uniform as any)(opts.selection.edgeWidth ?? DEFAULT_SELECTION_EDGE_WIDTH),
      }
    }
    // Apply the initial shading. `unlit` is a different MATERIAL, so it must be
    // attached here: `setShading('unlit')` would no-op (the state already says
    // 'unlit') and the mesh would keep rendering the lit material — which has no
    // color node, so a scalar-colored surface would come out flat white.
    if (this._shading === 'flat') this._lit.flatShading = true
    if (this._shading === 'unlit') this._mesh.material = this.activeMaterial()
    if (opts.wireframe) {
      if (typeof opts.wireframe === 'object' && opts.wireframe.color) this._wireColor = opts.wireframe.color
      this.ensureWire()
    }
    this.invalidate()
  }

  /** The rendered mesh — exposed for host-side PICKING (raycast against it to map a
   *  pointer to a vertex). Its world matrix is live, so a `Raycaster` set from the axes
   *  camera hits it correctly at any orbit angle. Raycast it non-recursively: the
   *  wireframe is a child, and picking should not hit it. */
  get mesh(): Mesh { return this._mesh }

  /** The FULL geometry extent, masked or not — hiding a hemisphere deliberately does not
   *  re-frame the axes, since a camera that jumps on a visibility toggle is worse than
   *  one that holds still. */
  /** The mesh's extent — the domain's, so a surface and the glyphs anchored on it
   *  always frame identically instead of each measuring the mesh separately. */
  dataBounds(): Bounds { return this.domain.bounds() }

  /**
   * Move the rendered vertices — a DISPLAY transform (mesh smoothing / inflation).
   *
   * Positions and NORMALS together, never positions alone: a lit surface shades from
   * its normals, so moving vertices without recomputing them lights the new shape
   * with the old shape's folds — which on a cortex is a smoothed surface still
   * showing every sulcus in shadow, and reads as the smoothing having half worked.
   *
   * **The geometry passed to this drawable is the one it will edit**, so give it a
   * copy if anything else reads that mesh. Here, the cortex's real geometry is what
   * the divergence operator, the eigenbasis and the mass matrix are all built on;
   * inflating it in place would silently redefine every one of them. That separation
   * is the app's rule, not this drawable's — see the repo's "display-only morphs stay
   * display-only" decision — but this is the method that can break it.
   *
   * The EXTENT is deliberately not re-derived. The axes framed the folded mesh, and a
   * smoothing slider that re-framed the camera on every tick would make the surface
   * appear to breathe rather than to inflate.
   */
  setPositions(p: Float32Array): void {
    /* The DOMAIN owns the vertices, so this one call also moves every glyph layer
       sharing it — which is what stops arrows being left behind at the folded
       position. Normals and the bounding sphere stay here: they are this drawable's
       rendering concerns, and a point cloud on the same domain has no normals. */
    this.domain.setPositions(p)
    this._geometry.computeVertexNormals()
    const n = this._geometry.attributes.normal
    if (n) n.needsUpdate = true
    // Frustum culling is off on this mesh, but the sphere is what raycast picking
    // broad-phases against, so a stale one drops hits on the moved surface.
    this._geometry.computeBoundingSphere()
    this.invalidate()
  }

  // ── Live display properties ───────────────────────────────────────────────

  get shading(): SurfaceShading { return this._shading }

  /**
   * Retarget the colormap range. Live — used for an auto-clim that tracks the data
   * as the time cursor moves, which is why it is a UNIFORM write: baking the clim
   * into the node graph made every retarget recompile the shader, once per frame for
   * a clim that follows the cursor.
   *
   * `invalidate()` still fires, because the LEGEND and colorbar read `clim()`
   * and have to be redrawn — but `onUpdate` now finds nothing structural changed and
   * leaves the graph alone.
   */
  /** A LIVE uniform — a write, never a rebuild, which is what lets an auto-clim
   *  follow the time cursor without recompiling the shader every frame. */
  protected onClimChanged(): void {
    this._climU.value.set(this._clim[0], this._clim[1])
    this.syncAutoInterval()
  }

  /**
   * Retarget the isolines — a PATCH, merged into whatever was declared.
   *
   * Values are uniform writes, so dragging an interval or a width slider never
   * recompiles. Two things are structural and rebuild once: adding contours to a
   * surface that had none, and adding the `minor` or `zeroCrossing` layer to one that
   * did not declare it. Declare a layer up front (even switched off) to keep its
   * toggle free thereafter.
   */
  /**
   * Scale every PIXEL-specified width — the contour lines — for a capture.
   *
   * Their widths are in FRAGMENTS (`fwidth`-based, so constant on screen at any zoom),
   * which is right for a live view and wrong the moment the device resolution changes
   * under them: at a 4× capture a 2-fragment line is still 2 fragments, so it comes out
   * a quarter as thick relative to the image. The isolines thin to hairlines and the
   * "higher resolution" picture looks worse than the one it replaced.
   *
   * Multiplicative and idempotent — it re-derives from the DECLARED widths each time
   * rather than compounding, so `setPixelScale(4)` then `setPixelScale(1)` is exactly
   * the original and not a rounding of it.
   */
  /** The contour width uniform in force — for a gate that must tell a re-render at k×
   *  from a merely larger output. */
  contourWidth(): number | null {
    return this._contours ? (this._contours.width as { value: number }).value : null
  }

  setPixelScale(k: number): void {
    const c = this._contours
    const spec = this._contourSpec
    if (!c || !spec) return
    const base = spec.width ?? DEFAULT_CONTOUR_WIDTH
    const s = Math.max(0.01, k)
    const layerWidth = (layer: unknown, fallback: number): number => {
      const l = layer as { width?: number } | boolean | undefined
      return typeof l === 'object' && l !== null && typeof l.width === 'number' ? l.width : fallback
    }
    c.width.value = Math.max(0.1, base) * s
    if (c.minor) c.minor.width.value = Math.max(0.1, layerWidth(spec.minor, base * 0.5)) * s
    if (c.zero) c.zero.width.value = Math.max(0.1, layerWidth(spec.zeroCrossing, base * 1.5)) * s
    this.invalidate()
  }

  setContours(v: SurfaceContours | false): void {
    if (v === false) {
      if (this._contours) this._contours.enabled.value = 0
      return
    }
    const spec: SurfaceContours = { ...(this._contourSpec ?? {}), ...v }
    const con = this._contours
    const structural = !con
      || (layerSpec(spec.minor) !== null && !con.minor)
      || (layerSpec(spec.zeroCrossing) !== null && !con.zero)
    this._contourSpec = spec
    if (structural) {
      this._contours = this.buildContours(spec)
      this._nodesFor = null       // the graph gained contour nodes → rebuild
      this.invalidate()
      return
    }
    // Values only.
    if (v.enabled !== undefined) con!.enabled.value = v.enabled ? 1 : 0
    if (v.major !== undefined) con!.majorOn.value = v.major ? 1 : 0
    if (v.filled !== undefined) con!.filled.value = v.filled ? 1 : 0
    if (v.interval !== undefined || v.bands !== undefined) this.syncAutoInterval()
    if (v.width !== undefined) con!.width.value = Math.max(0.1, v.width)
    if (v.color !== undefined) con!.color.value.set(v.color)
    const minor = layerSpec(v.minor)
    if (v.minor !== undefined && con!.minor) {
      con!.minor.on.value = minor && minor.enabled !== false ? 1 : 0
    }
    if (minor && con!.minor) {
      if (minor.ratio !== undefined) con!.minor.ratio.value = Math.max(2, Math.floor(minor.ratio))
      if (minor.width !== undefined) con!.minor.width.value = Math.max(0.1, minor.width)
      if (minor.color !== undefined) con!.minor.color.value.set(minor.color)
    }
    const zero = layerSpec(v.zeroCrossing)
    if (v.zeroCrossing !== undefined && con!.zero) {
      con!.zero.on.value = zero && zero.enabled !== false ? 1 : 0
    }
    if (zero && con!.zero) {
      if (zero.width !== undefined) con!.zero.width.value = Math.max(0.1, zero.width)
      if (zero.color !== undefined) con!.zero.color.value.set(zero.color)
    }
  }

  /**
   * Retarget the value gate — a PATCH, so `{ min: 0 }` leaves the upper bound alone.
   * `null` on a side clears that side; `false` clears both.
   *
   * Uniform writes, so flipping which side of a signed field is painted costs nothing
   * — provided the threshold was DECLARED at construction. Adding one to a surface
   * that had none rebuilds the graph, once.
   */
  setThreshold(v: SurfaceThreshold | false): void {
    const spec: SurfaceThreshold = v === false ? { min: null, max: null } : v
    const t = this._threshold
    if (!t) {
      // Nothing to do: a surface with no gate asked to have no gate.
      if (spec.min == null && spec.max == null && !spec.soften) return
      this._threshold = buildThreshold(spec)
      this._nodesFor = null       // the graph gained the gate → rebuild
      this.invalidate()
      return
    }
    if (spec.min !== undefined) {
      t.minOn.value = typeof spec.min === 'number' ? 1 : 0
      if (typeof spec.min === 'number') t.min.value = spec.min
    }
    if (spec.max !== undefined) {
      t.maxOn.value = typeof spec.max === 'number' ? 1 : 0
      if (typeof spec.max === 'number') t.max.value = spec.max
    }
    if (spec.soften !== undefined) t.soften.value = Math.max(0, spec.soften)
  }

  /** Whether the isolines are currently drawn. */
  get contours(): boolean { return (this._contours?.enabled.value ?? 0) > 0 }

  /** The major contour interval in scalar units, resolved (`'auto'` → a number). */
  contourInterval(): number { return this._contours?.interval.value ?? 0 }

  /** Swap lighting/normals mode. `unlit` swaps the material class (which drops the node
   *  graph, so it is rebuilt); `smooth`/`flat` only flip `flatShading` on the lit one. */
  setShading(s: SurfaceShading): void {
    if (s === this._shading) return
    this._shading = s
    if (s !== 'unlit') {
      this._lit.flatShading = s === 'flat'
      this._lit.needsUpdate = true
    }
    this._mesh.material = this.activeMaterial()
    this.invalidate()
  }

  /**
   * Set the surface opacity. The value itself is a live uniform, but `transparent`
   * and `depthWrite` are MATERIAL flags — writing `opacity.value` alone leaves an
   * opaque material that ignores the alpha, so a surface constructed at 1 could
   * never be faded. Route runtime changes through here: it flips the flags on both
   * the lit and unlit materials (either may be the active one).
   */
  /**
   * The legend entry, or null when the surface is not showing.
   *
   * OPACITY counts, not just `visible`: the app hides the cortex by fading it to 0
   * (the glyphs sit on it and are depth-tested against it, so removing it changes what
   * you can see of THEM). A key for a faded-out surface describes a picture that is
   * not on screen.
   */
  legendEntry(): LegendEntry | null {
    if (!this.legend || !this.visible || this.opacity.value <= 0) return null
    /* Not painting the scalar ⇒ nothing to key. The colorbar belongs to whichever
       drawable is actually encoding the field, and two identical bars — one from a
       surface showing plain anatomy — is a legend that overstates what it explains. */
    if (!this.paintsScalar) return null
    /* A CATEGORICAL surface has no colorbar. The bar states "this ramp, over this
       clim", and neither half is true here: the fill comes from a bespoke LUT the
       bar does not sample, and the numbers are label ids, which have no order to put
       on an axis. A parcellation's key is a list of swatches and region names — the
       atlas tool's job, not the colorbar's. */
    if (this._categorical) return null
    return {
      title: this.legend.title,
      unit: this.legend.unit,
      clim: this.clim(),
      colormap: this.colormap || this.axes.colormap,
    }
  }

  /**
   * Paint the scalar, or show plain anatomy.
   *
   * Off, the fill is the surface's own colour and the field is left to some OTHER
   * drawable to show — the app's case is a point cloud over the same vertices, where
   * having both would be one datum in two encodings competing for the same pixels.
   * It is not the same as hiding the surface: the anatomy still occludes, which is
   * what makes a cloud on a folded cortex readable at all instead of showing every
   * far-side point through the near side.
   *
   * A LIVE uniform, so this is one write — no rebuild, and therefore no lost camera.
   * Everything downstream still reads the true scalar: the isolines, the polarity gate
   * and the selection are unaffected, which is deliberate. Contours over plain anatomy
   * are a legitimate way to read a field, and a threshold that stopped gating because
   * the fill changed would be a surprise.
   */
  setPaintScalar(on: boolean): void {
    const v = on ? 1 : 0
    if (this._paintU.value === v) return
    this._paintU.value = v
    this.invalidate()
  }

  /** Whether the fill is the scalar (true) or plain anatomy (false). */
  get paintsScalar(): boolean { return this._paintU.value === 1 }

  setOpacity(v: number): void {
    this.opacity.value = v
    const transparent = v < 1
    for (const m of [this._lit, this._unlit]) {
      if (!m) continue
      if (m.transparent === transparent) continue
      m.transparent = transparent
      m.depthWrite = !transparent
      m.needsUpdate = true
    }
  }

  get wireframe(): boolean { return this._wire !== null && this._wire.visible }

  /** Show/hide the edge overlay (built on first use), or restyle it. */
  setWireframe(v: SurfaceWireframe): void {
    const on = v !== false
    if (typeof v === 'object' && v.color) this._wireColor = v.color
    if (!on) {
      if (this._wire) this._wire.visible = false
      this.setDepthBias(false)
      return
    }
    this.ensureWire().visible = true
    this.invalidate()
  }

  /**
   * Replace the per-vertex visibility mask; `null` shows everything. Values only —
   * the buffer is reused, so this does not rebuild the shader (unless the mask is
   * being added or removed, which does change the graph).
   */
  setMask(m: MaskSource | null): void {
    if (this._mask?.values && (m instanceof Uint8Array || m instanceof Float32Array)) {
      this._mask.set(m)          // same buffer, just new values → no rebuild
      return
    }
    this._mask = m == null ? null : createVertexMask(m, this._V)
    this._nodesFor = null        // the graph gained or lost its discard → rebuild
    this.invalidate()
  }

  /**
   * Whether vertex `v` is hidden by the mask — for host PICKING. A discarded fragment
   * is still a raycast hit (three knows nothing about the shader), so a picker must
   * reject masked vertices itself or it will select an invisible hemisphere. Returns
   * false for a GPU-owned mask, whose values the CPU cannot see.
   */
  maskedOut(v: number): boolean {
    const vals = this._mask?.values
    return vals ? vals[v] < 0.5 : false
  }

  /**
   * Replace the per-vertex SELECTION values — a buffer write, so a gesture repaints
   * without touching the shader. Requires `selection` to have been declared at
   * construction; on a surface that has none this is a no-op rather than a rebuild,
   * because a selection appearing mid-drag would recompile in the middle of a gesture.
   */
  setSelection(values: Uint8Array | Float32Array | null): void {
    if (!this._selection) return
    this._selection.mask.set(values ?? new Float32Array(this._V))
  }

  /**
   * Restyle the selection overlay. Colours and widths are uniform writes; `blend`
   * is the one STRUCTURAL field — each mode is different arithmetic, so changing it
   * re-emits the shader. That is the right trade: a blend is chosen once while
   * deciding how the chart should look, not dragged.
   */
  setSelectionStyle(style: {
    blend?: SelectionBlend; hard?: boolean; invert?: boolean
    color?: string; alpha?: number; edgeColor?: string; edgeWidth?: number
  }): void {
    const s = this._selection
    if (!s) return
    if (style.color !== undefined) s.color.value.set(style.color)
    if (style.alpha !== undefined) s.alpha.value = Math.max(0, style.alpha)
    if (style.edgeColor !== undefined) s.edgeColor.value.set(style.edgeColor)
    if (style.edgeWidth !== undefined) s.edgeWidth.value = Math.max(0, style.edgeWidth)
    if (style.invert !== undefined) s.invert.value = style.invert ? 1 : 0
    const structural = (style.blend !== undefined && style.blend !== s.blend)
      || (style.hard !== undefined && style.hard !== s.hard)
    if (style.blend !== undefined) s.blend = style.blend
    if (style.hard !== undefined) s.hard = style.hard
    if (structural) {
      this._nodesFor = null      // different arithmetic → rebuild
      this.invalidate()
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Build the contour uniforms from a spec. Called once per STRUCTURAL change only —
   *  every value these hold is writable afterwards. */
  private buildContours(spec: SurfaceContours): ContourNodes {
    const u = (x: number) => (uniform as any)(x)
    const uc = (css: string) => (uniform as any)(new Color(css))
    const width = spec.width ?? DEFAULT_CONTOUR_WIDTH
    const color = spec.color ?? DEFAULT_CONTOUR_COLOR
    const minor = layerSpec(spec.minor)
    const zero = layerSpec(spec.zeroCrossing)
    return {
      enabled: u(spec.enabled === false ? 0 : 1),
      majorOn: u(spec.major === false ? 0 : 1),
      interval: u(resolveContourInterval(spec.interval, this._clim, spec.bands)),
      width: u(Math.max(0.1, width)),
      color: uc(color),
      filled: u(spec.filled ? 1 : 0),
      minor: minor && {
        on: u(minor.enabled === false ? 0 : 1),
        ratio: u(Math.max(2, Math.floor(minor.ratio ?? DEFAULT_MINOR_RATIO))),
        width: u(Math.max(0.1, minor.width ?? width * 0.5)),
        color: uc(minor.color ?? color),
      },
      zero: zero && {
        on: u(zero.enabled === false ? 0 : 1),
        width: u(Math.max(0.1, zero.width ?? width * 1.5)),
        color: uc(zero.color ?? DEFAULT_CONTOUR_COLOR),
      },
    }
  }

  /** Re-derive the interval when it tracks the clim. A uniform write — this is the
   *  reason an auto-clim can move every frame without touching the shader. */
  private syncAutoInterval(): void {
    if (!this._contours) return
    this._contours.interval.value = resolveContourInterval(
      this._contourSpec?.interval, this._clim, this._contourSpec?.bands,
    )
  }

  private activeMaterial(): MeshStandardNodeMaterial | MeshBasicNodeMaterial {
    if (this._shading !== 'unlit') return this._lit
    if (!this._unlit) {
      /* THE SAME SIDE AS THE LIT MATERIAL. They are two renderings of one surface,
         so a shading switch that also changed which faces are drawn would look
         like the cut had healed itself. */
      const m = new MeshBasicNodeMaterial({ side: this._lit.side })
      m.transparent = this._lit.transparent
      m.depthWrite = this._lit.depthWrite
      m.polygonOffset = this._lit.polygonOffset
      m.polygonOffsetFactor = this._lit.polygonOffsetFactor
      m.polygonOffsetUnits = this._lit.polygonOffsetUnits
      this._unlit = m
    }
    return this._unlit
  }

  /** Push the surface back a hair in depth so coincident wireframe edges read cleanly
   *  instead of z-fighting. Only while the wireframe is on. */
  private setDepthBias(on: boolean): void {
    for (const m of [this._lit, this._unlit]) {
      if (!m) continue
      m.polygonOffset = on
      m.polygonOffsetFactor = on ? 1 : 0
      m.polygonOffsetUnits = on ? 1 : 0
      m.needsUpdate = true
    }
  }

  private ensureWire(): Mesh {
    if (this._wire) return this._wire
    const mat = new MeshBasicNodeMaterial({ side: FrontSide })
    mat.wireframe = true                       // three builds the line index itself
    const wire = new Mesh(this._geometry, mat) // SAME geometry — no second copy to keep in sync
    wire.frustumCulled = false
    wire.renderOrder = 1
    this._mesh.add(wire)
    this._wire = wire
    this._wireMat = mat
    this.setDepthBias(true)
    this.applyWireNodes()
    return wire
  }

  /** The mask varying for one material's graph. Varyings belong to the graph they are
   *  built in, so each material builds its own. */
  private maskVarying(): any {
    return this._mask ? (varying as any)(this._mask.node.element(vertexIndex)) : null
  }

  private applyWireNodes(): void {
    const mat = this._wireMat
    if (!mat) return
    const vMask = this.maskVarying()
    const c = new Color(this._wireColor)
    mat.colorNode = (Fn as any)(() => {
      if (vMask) Discard(vMask.lessThan(float(0.5)))
      return vec3(c.r, c.g, c.b)
    })()
    mat.needsUpdate = true
  }

  private applyNodes(material: MeshStandardNodeMaterial | MeshBasicNodeMaterial): void {
    const useAtlas = this._builtWithAtlas
    const scalar = this._scalar
    const solid = this._solidColor
    const dom = this._climU
    const row = this._rowU
    const con = this._contours
    const thr = this._threshold
    const sel = this._selection
    const vMask = this.maskVarying()
    // Varyings belong to the graph they are built in, so this is built here beside
    // the mask's rather than held on the nodes object.
    const vSel = sel ? (varying as any)(sel.mask.node.element(vertexIndex)) : null
    /* FLAT when the scalar is a LABEL. An interpolated varying spanning labels 12 and
       30 walks through every value between them, and the colormap dutifully paints
       regions that do not exist — a rainbow fringe along every boundary that no
       choice of colormap can fix, because the error happens before the colormap.
       `setInterpolation('flat')` takes the provoking vertex's value, so the label is
       constant across the face. */
    const vScalar = scalar
      ? (() => {
          const v = (varying as any)(scalar.element(int(this._tp).mul(this._V).add(vertexIndex)))
          /* UNGUARDED on purpose. A `typeof v.setInterpolation === 'function'` check
             here would turn a renamed or removed three API into silently bleeding
             regions — the exact defect this line exists to prevent, and one no test
             and no type error can see. Better it throws on the first categorical
             draw. */
          if (this._categorical) v.setInterpolation('flat')
          return v
        })()
      : null

    /**
     * The selection, applied LAST to whatever the field produced — it is chrome about
     * the session, so nothing the data says should paint over it.
     *
     * Fill, then BORDER. The border is `zeroCrossingMask` on `s − 0.5`, which is the
     * contour machinery pointed at the selection buffer instead of at the scalar: the
     * mask is interpolated across triangles, so its half-crossing is exactly the
     * boundary, and `fwidth` keeps the line the same width on screen at any zoom.
     */
    const tinted = (c: any): any => {
      if (!sel) return c
      const fwSel = fwidth(vSel)
      // HARD thresholds at 0.5, antialiased across one fragment — binary without
      // being jagged, where a raw step would stair-step along the triangulation.
      const m0 = sel.hard
        ? smoothstep(float(0.5).sub(fwSel), float(0.5).add(fwSel), vSel)
        : vSel
      // INVERTED, as a lerp on a uniform: the focused view is a toggle, and a toggle
      // that recompiled would hitch the first time it was used.
      const m: any = mix(m0, m0.oneMinus(), sel.invert)
      // The mask scales the blend's STRENGTH, so a soft 0..1 selection fades the
      // effect rather than the colour — which is what makes a feathered edge look
      // feathered instead of merely translucent.
      const solidNode = vec3(solid.r, solid.g, solid.b)
      const filled = mix(c, blendNode(sel.blend, c, sel.color, solidNode), m.mul(sel.alpha))
      // The AA ramp is floored so `smoothstep` cannot degenerate, so a zero width
      // would leave a hairline exactly on the crossing rather than nothing — the same
      // trap the contour layers carry their own on/off for. One multiply fixes it.
      const on = smoothstep(float(0), float(0.01), sel.edgeWidth)
      const edge = zeroCrossingMask(vSel.sub(float(0.5)), fwSel, sel.edgeWidth)
      return mix(filled, sel.edgeColor, edge.mul(on))
    }

    material.colorNode = (Fn as any)(() => {
      if (vMask) Discard(vMask.lessThan(float(0.5)))
      if (!vScalar) return tinted(vec3(solid.r, solid.g, solid.b))

      // ONE derivative, shared by every contour layer AND by the threshold's edge.
      // `Discard` above does not invalidate it: WGSL demotes a discarded invocation to
      // a helper, which still participates in the quad's derivatives.
      const fw = con || thr ? fwidth(vScalar) : null
      // What the COLORMAP sees. `filled` snaps it to the band centre, so the fill
      // quantizes to exactly the intervals the lines are drawn at — the atlas does
      // the work, and the mode stays a uniform instead of a second shader.
      const cv = con
        ? mix(vScalar, bandCenter(vScalar, con.interval), con.filled)
        : vScalar

      const cat = this._categorical
      /* A LABEL ADDRESSES ITS TEXEL DIRECTLY — no `clim` normalisation, because
         there is nothing continuous to normalise: `(id + 0.5)/width` is the centre of
         texel `id`, and NearestFilter does the rest. Routing a label through
         [clim.x, clim.y] is what put every label on a band EDGE, where rounding
         handed ~7% of them their neighbour's colour. */
      const sn = cat
        ? clamp(cv.add(float(0.5)).div(float(cat.width)), float(0), float(1))
        : clamp(cv.sub(dom.x).div(dom.y.sub(dom.x)), float(0), float(1))
      /* THE LUT IS RGBA AND THE ALPHA IS LOAD-BEARING — it is how a label says "no
         region here". Taking `.xyz` and dropping it renders unassigned cortex as
         SOLID BLACK (alpha 0 ⇒ rgb 0,0,0), which is what a partial parcellation like
         Brodmann looked like: a brain-shaped silhouette with a few coloured patches
         on it. Blending against the anatomy `shell` instead is what makes "unlabelled"
         read as plain cortex. Declared before `shell` is, so it is applied below. */
      const catTex = cat ? ((texture as any)(cat.lut, vec2(sn, float(0.5))) as any) : null
      const ramp = catTex
        ? catTex.xyz
        : useAtlas
          ? (createColormapSampler('default').sample(sn, row) as any).xyz
          : vec3(sn)
      /* THE FILL, which may not be the scalar at all — see `setPaintScalar`. A uniform
         mix to the surface's own colour rather than a second shader or a rebuild, and
         it lands HERE so everything downstream (the gate, the contours, the selection)
         keeps reading the true scalar: turning the paint off changes what the surface
         is COLOURED by, not what it knows. */
      /*
       * DIMMED when it is not painting, and only then.
       *
       * `DEFAULT_SURFACE_COLOR` is a light grey chosen for a surface that is ABOUT to be
       * covered by a colormap — as plain anatomy behind a point cloud it renders as a
       * near-white sheet that the cloud's own colours cannot compete with, especially
       * unlit (this chart's default), where there is no shading to break it up.
       *
       * Applied HERE and not to `solid` itself, so the polarity gate's "excluded returns
       * to anatomy" keeps the colour it has always had. Two uses of one colour that want
       * two brightnesses is exactly why this is a mix and not a different constant.
       */
      const shell = vec3(solid.r, solid.g, solid.b).mul(float(NEUTRAL_DIM))
      /* A categorical label with alpha 0 is UNASSIGNED — show the anatomy, not the
         region colour. `mix` on the LUT's own alpha does both ends at once: opaque
         labels are unaffected, and a store that gives a region partial alpha gets a
         tint rather than a special case. */
      const region = catTex ? mix(shell, ramp, catTex.w) : ramp
      const painted = mix(shell, region, this._paintU)

      // THE GATE. Where the value fails, the surface returns to its own colour rather
      // than to an end of the ramp — so "excluded" reads as anatomy and cannot be
      // mistaken for "extreme". The edge width falls back to one fragment of `fwidth`,
      // which antialiases it in screen space at any zoom instead of stair-stepping
      // along the triangulation; `soften` overrides that with a fade in data units.
      let gate: any = null
      let base: any = painted
      if (thr) {
        const edge = thr.soften.max(fw)
        const gMin = mix(float(1), smoothstep(thr.min, thr.min.add(edge), vScalar), thr.minOn)
        const gMax = mix(float(1), smoothstep(thr.max, thr.max.sub(edge), vScalar), thr.maxOn)
        gate = gMin.mul(gMax)
        base = mix(vec3(solid.r, solid.g, solid.b), painted, gate)
      }
      if (!con) return tinted(base)

      // The LINES read the raw scalar, never the banded one — a filled plot still
      // draws its contours at the true levels. Painted minor → major → zero, so the
      // more meaningful line always wins the pixel.
      //
      // The gate folds into `on`, so lines stop at the edge of the painted region
      // instead of continuing across bare anatomy — levels outside the shown range are
      // not a reading, they are noise. It costs nothing: `on` is already multiplied
      // into every mask.
      const on = gate ? con.enabled.mul(gate) : con.enabled
      let color: any = base
      if (con.minor) {
        const period = con.interval.div(con.minor.ratio)
        const m = contourMask(vScalar, fw, period, con.minor.width)
          .mul(contourResolvability(fw, period))
        color = mix(color, con.minor.color, m.mul(on).mul(con.minor.on))
      }
      const maj = contourMask(vScalar, fw, con.interval, con.width)
      color = mix(color, con.color, maj.mul(on).mul(con.majorOn))
      if (con.zero) {
        // The floor is a fraction of the PERIOD, which tracks the clim — the scalar
        // here is in data units, so a constant would be a guess at the field's size.
        const z = zeroCrossingMask(
          vScalar, fw, con.zero.width, con.interval.mul(float(ZERO_HALF_WIDTH_FRACTION)),
        )
        color = mix(color, con.zero.color, z.mul(on).mul(con.zero.on))
      }
      return tinted(color)
    })()
    material.opacityNode = this.opacity
    material.needsUpdate = true
  }

  /**
   * Rebuild the node graph only when its STRUCTURE changed.
   *
   * A colormap swap is not structural: every map in a loaded library is a row of one
   * atlas texture, so it is a uniform write. What is structural is the material (a
   * swap drops the graph), the mask (it adds or removes a `Discard`), the contour
   * layers, and whether the atlas is loaded at all — with no library there is no
   * sampler to build, so the graph falls back to grayscale and must be rebuilt once
   * when the atlas arrives.
   */
  protected onUpdate(): void {
    const mat = this.activeMaterial()
    const row = colormapRowOrNull(this.effectiveColormap())
    if (row !== null) this._rowU.value = row
    const hasAtlas = row !== null
    if (mat === this._nodesFor && hasAtlas === this._builtWithAtlas) return
    this._nodesFor = mat
    this._builtWithAtlas = hasAtlas
    this.applyNodes(mat)
    this.applyWireNodes()
  }

  dispose(): void {
    if (this._wire) { this._mesh.remove(this._wire); this._wireMat?.dispose() }
    this._lit.dispose()
    this._unlit?.dispose()
    if (this._ownsDomain) this.domain.dispose()
    super.dispose()   // geometry is the caller's; so is a domain it handed us
  }
}
