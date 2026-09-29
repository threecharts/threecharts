import { DataTexture, RGBAFormat, UnsignedByteType, NearestFilter, NoColorSpace } from 'three/webgpu'

/**
 * A categorical lookup table: one texel per label, sampled NEAREST.
 *
 * Ported from `nxr-design-system`'s `manifold-viewport/src/atlas/categoricalColormap.ts`,
 * which had solved this and was retired with that package.
 *
 * WHY A BESPOKE TEXTURE rather than a row of the shared colormap atlas. The shared
 * atlas is a fixed 256 texels wide, so a parcellation with 149 labels gets 1.7 texels
 * each — bands do not align, and ~7% of labels sample their neighbour's colour. Sizing
 * the texture to the label count makes it exact by construction, at a cost of a few
 * hundred bytes. (The shared row also quantises on the CPU side: `colormapSampleCPU`
 * downsamples any width into a 256-entry palette, so widening the bake alone would fix
 * the GPU and leave a legend that disagrees with it.)
 *
 * `NearestFilter` + no mipmaps because a parcellation must NOT interpolate between
 * region colours. That is half the story — the label varying must also be flat, or the
 * LABEL interpolates before the colour ever does. `Surface`'s `categorical` option
 * does both together, deliberately: either alone still bleeds.
 *
 * Slot 0 and any gap between non-contiguous ids default to FULLY TRANSPARENT, so
 * unassigned cortex shows the anatomy underneath rather than a flat patch.
 *
 * `NoColorSpace`, so the stored bytes are the source colours unmodified — these are
 * Brainstorm scout colours, and for the aparc-derived atlases the FreeSurfer LUT
 * values. A colour-space conversion here would silently shift every region.
 */
export interface CategoricalLut {
  texture: DataTexture
  /** Texel count. A label `id` samples at `(id + 0.5) / width` — the texel centre. */
  width: number
  dispose(): void
}

/** Nearest-sampling U for the texel centre of label `id`. */
export function categoricalLutU(id: number, width: number): number {
  return (id + 0.5) / width
}

const to8 = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 255)))

/**
 * Build a LUT from RGBA colours in 0..1, indexed BY LABEL — `colors[i]` is label `i`.
 *
 * A short list is padded with transparent rather than rejected: a store that carries
 * fewer colours than labels is a store to render honestly, not to refuse.
 */
export function buildCategoricalLut(
  colors: ReadonlyArray<readonly [number, number, number, number]>,
  width = colors.length,
): CategoricalLut {
  const w = Math.max(1, width)
  const data = new Uint8Array(w * 4)   // zero-filled = transparent, which is the default
  for (let i = 0; i < Math.min(w, colors.length); i++) {
    const c = colors[i]
    const o = i * 4
    data[o] = to8(c[0]); data[o + 1] = to8(c[1]); data[o + 2] = to8(c[2]); data[o + 3] = to8(c[3])
  }
  const tex = new DataTexture(data, w, 1, RGBAFormat, UnsignedByteType)
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = NoColorSpace
  tex.needsUpdate = true
  return { texture: tex, width: w, dispose: () => tex.dispose() }
}
