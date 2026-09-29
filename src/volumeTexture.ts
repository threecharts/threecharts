import {
  Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, NearestFilter,
  ClampToEdgeWrapping, NoColorSpace, type Texture,
} from 'three/webgpu'
import type { VolumeDims } from './sliceUVW'

/**
 * volumeTexture.ts — a `[ni, nj, nk] uint8` volume as a `Data3DTexture`.
 *
 * WHY A TEXTURE AND NOT A STORAGE BUFFER, which is what `Volume` (the raymarch)
 * uses. Three reasons, and the third is the one that decides it:
 *
 *   · SIZE. A 256³ volume is 16.7 MB as uint8 and 67.1 MB as the float32 a
 *     storage buffer would hold — 4× the VRAM for data that has 256 levels.
 *   · FILTERING. Trilinear interpolation is free in hardware here and is eight
 *     reads plus hand-rolled lerps in a buffer.
 *   · AND THE FILTER IS PER-TEXTURE, which is what an atlas needs. A label
 *     interpolated between 3 and 4 is region 3.5, which does not exist; an
 *     anatomical volume between two intensities is exactly right. Same texture
 *     type, one flag apart. In a storage buffer the sampling rule is written
 *     into the shader, so the two would be two shaders.
 *
 * THE AXIS MAPPING LIVES HERE AND NOWHERE ELSE. A `Data3DTexture` is indexed
 * (x, y, z) with x fastest, and the volume is `[i, j, k]` C-order with k fastest
 * — so the texture's x is the volume's k. `sliceUVW` returns coordinates in the
 * VOLUME's order and `volumeUVW` converts; nothing else may.
 */

/** RGBA-free single-channel: an MRI is one number per voxel. */
export function createVolumeTexture(
  cube: Uint8Array,
  dims: VolumeDims,
  kind: 'anatomical' | 'atlas',
): Data3DTexture {
  const [ni, nj, nk] = dims
  if (cube.length !== ni * nj * nk) {
    throw new Error(`volume is ${cube.length} voxels, dims say ${ni}×${nj}×${nk}`)
  }
  /* The array is handed over AS IS. C-order `[i][j][k]` with k fastest is
     already the memory order a Data3DTexture wants for (x=k, y=j, z=i) — see
     `volumeUVW`, which is the only place that correspondence is written down. */
  const tex = new Data3DTexture(cube, nk, nj, ni)
  tex.format = RedFormat
  tex.type = UnsignedByteType
  /* ATLAS ⇒ NEAREST, and it is not a preference. Interpolating labels invents
     regions between them — the same defect the categorical flat-varying rule
     exists to prevent on a surface, one dimension up. */
  const filter = kind === 'atlas' ? NearestFilter : LinearFilter
  tex.magFilter = filter
  tex.minFilter = filter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.wrapR = ClampToEdgeWrapping
  tex.generateMipmaps = false
  /* NoColorSpace: these are measured intensities and label ids, not colours
     authored for a display. A conversion here would shift every voxel. */
  tex.colorSpace = NoColorSpace
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

/**
 * Volume-order `[i, j, k]` normalised coordinates → the texture's `(x, y, z)`.
 *
 * One line, and it is the only place the correspondence exists. Getting it wrong
 * transposes the volume, which renders a brain-shaped object that is wrong in a
 * way no colour scale or window level can reveal.
 */
export function volumeUVW(w: readonly [number, number, number]): [number, number, number] {
  return [w[2], w[1], w[0]]
}

/** Free the GPU copy. A volume is 16.7 MB; two subjects' worth is not nothing. */
export function disposeVolumeTexture(tex: Texture | null): void {
  tex?.dispose()
}
