import type { Texture } from 'three/webgpu'
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { texture, vec2, float, clamp } from 'three/tsl'
import { buildCategoricalLut } from './categoricalLut'
import { colormapRowOrNull, colormapSampleCPU } from './colormap-node'

/**
 * categorical.ts — a fixed table of LABEL colours, and the one place a label becomes
 * one.
 *
 * The categorical counterpart of a colormap row: where a colormap answers "what colour
 * is 0.42", a scheme answers "what colour is label 12" — a LOOKUP, not a sample, so
 * nothing is interpolated at either end.
 *
 * WHY THIS EXISTS AT ALL. Three drawables independently reached the same workaround
 * before it did: `Line.colorIndex` (a `t` per channel into a categorical colormap row,
 * plus `setColorGain` to darken the result for a light theme), `AnatomyChart`'s sensor
 * montage (the same `t`, through `Particles.values`), and `Surface`, which got a real
 * per-label LUT but privately, as an option of its own. A label forced through a
 * continuous ramp is wrong in the same three ways every time: 256 texels split into N
 * bands do not align, so labels sample their neighbour's colour; there is no alpha, so
 * "unassigned" cannot be said; and there is no darker variant, so a palette tuned for
 * one theme has to be corrected downstream.
 *
 * A scheme is structurally a `SurfaceCategorical` — `lut` + `width` — so it is
 * accepted by `Surface` unchanged.
 */
export interface CategoricalScheme {
  /** Stable id, for a legend and for a host comparing two schemes. */
  id: string
  /** Colour per label, RGBA 0..1, indexed BY LABEL: `colors[i]` is label `i`. */
  colors: ReadonlyArray<readonly [number, number, number, number]>
  /** Display names, `names[i]` for label `i`. A legend draws these; nothing here
   *  interprets them. */
  names?: readonly string[]
  /** The GPU table: a 1-row RGBA texture, `NearestFilter`, one texel per label. */
  readonly lut: Texture
  /** Texel count. Label `id` addresses `(id + 0.5) / width` — the texel centre. */
  readonly width: number
  dispose(): void
}

/**
 * Build a scheme from RGBA colours in 0..1, indexed by label.
 *
 * Every property `buildCategoricalLut` argues for is inherited and none of it is
 * restated here: exact width rather than 256, `NearestFilter` with no mipmaps,
 * `NoColorSpace`, transparent for slot 0 and any gap, and padding rather than
 * rejection for a short list. Read that file before changing any of it.
 */
export function createCategoricalScheme(spec: {
  id: string
  colors: ReadonlyArray<readonly [number, number, number, number]>
  names?: readonly string[]
  /** Texels. Defaults to the colour count; pass a larger one to leave room for ids
   *  beyond the colours supplied (they render transparent). */
  width?: number
}): CategoricalScheme {
  const built = buildCategoricalLut(spec.colors, spec.width ?? spec.colors.length)
  return {
    id: spec.id,
    colors: spec.colors,
    ...(spec.names ? { names: spec.names } : {}),
    lut: built.texture,
    width: built.width,
    dispose: built.dispose,
  }
}

/**
 * Build a scheme by resampling a CATEGORICAL colormap row at `count` band centres.
 *
 * The shared atlas bakes `tab10` as 256 texels of 10 bands; this recovers the 10. It
 * is what a host should reach for instead of computing `t = (group + 0.5) / groupCount`
 * and hoping the bands line up — which they do not for any `count` that does not
 * divide 256, and which leaves the picker sampling one array while the shader samples
 * another.
 *
 * Returns null for an unknown colormap, so a caller can fall back rather than render a
 * scheme of black.
 *
 * ALPHA IS 1 for every entry. A baked ramp has no notion of "unassigned"; a caller who
 * needs one supplies its colours directly.
 */
export function schemeFromColormap(name: string, count: number): CategoricalScheme | null {
  const row = colormapRowOrNull(name)
  if (row === null || count < 1) return null
  const colors: [number, number, number, number][] = []
  for (let i = 0; i < count; i++) {
    const [r, g, b] = colormapSampleCPU((i + 0.5) / count, row)
    colors.push([r, g, b, 1])
  }
  return createCategoricalScheme({ id: `${name}:${count}`, colors })
}

/**
 * A two-entry scheme: `on` for label 1, transparent (or `off`) for label 0.
 *
 * A mask, a significance map, a hemisphere flag. It is an ordinary categorical scheme
 * — the constructor exists for the DEFAULT, which is the whole ergonomic win: a binary
 * layer almost always wants its zero to disappear rather than to be a colour.
 */
export function binaryScheme(
  on: readonly [number, number, number, number],
  off: readonly [number, number, number, number] = [0, 0, 0, 0],
  id = 'binary',
): CategoricalScheme {
  return createCategoricalScheme({ id, colors: [off, on] })
}

/** Nearest-sampling U for the texel centre of label `id`. */
export function schemeU(id: number, width: number): number {
  return (id + 0.5) / width
}

/**
 * label node → RGBA node. The one place a label becomes a colour.
 *
 * NO DOMAIN NORMALISATION — there is nothing continuous to normalise. `(id + 0.5)/width`
 * is the centre of texel `id` and `NearestFilter` does the rest. Routing a label through
 * a [lo, hi] clim is what puts every label on a band EDGE, where rounding hands ~7% of
 * them their neighbour's colour.
 *
 * RETURNS RGBA, and the alpha is LOAD-BEARING: it is how a label says "nothing here".
 * A caller that takes `.xyz` renders unassigned as SOLID BLACK (alpha 0 ⇒ rgb 0,0,0) —
 * which is exactly what shipped on 2026-08-19 and had to be found by looking at a
 * screenshot, because every binding assertion passed. Blend against whatever is
 * underneath instead.
 *
 * THIS IS HALF THE RULE. On a drawable that INTERPOLATES a value across a primitive —
 * a surface face, an image cell, a line segment — the label must ALSO arrive flat, via
 * `setInterpolation('flat')` on its varying. Nearest sampling fixes the lookup and does
 * nothing about a label that was already interpolated on the way in: a segment spanning
 * labels 12 and 30 walks through 13…29, painting regions that do not exist, before the
 * sampler is ever consulted. Either half alone still bleeds.
 */
export function categoricalColor(label: any, scheme: { lut: Texture; width: number }): any {
  const u = clamp(label.add(float(0.5)).div(float(scheme.width)), float(0), float(1))
  return (texture as any)(scheme.lut, vec2(u, float(0.5)))
}
