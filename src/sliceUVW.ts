/**
 * sliceUVW.ts — where a point on a slice quad lands in a volume.
 *
 * Pure and `three`-free, in the shape `envelope.ts` and `lineIndex.ts`
 * established: `Slice` implements this in TSL, a shader cannot be unit-tested,
 * so the formula is tested here and the shader is written to match it.
 *
 * THE AXIS NAMES ARE THE VOLUME'S, NOT THE SCREEN'S. A volume is `[ni, nj, nk]`
 * with `i` slowest and `k` fastest, and a slice fixes ONE of them. Which two of
 * the remaining axes go across and up the quad is a rendering choice, and it is
 * made here — once — rather than in three places that can disagree.
 *
 * The convention: the two free axes keep their VOLUME order. Slicing `i` puts
 * `j` across and `k` up; slicing `j` puts `i` across and `k` up; slicing `k`
 * puts `i` across and `j` up. It is arbitrary in the way a convention is
 * arbitrary, and what matters is that a caller placing a crosshair and a shader
 * placing a texel both read it from here.
 */

/** Which volume axis a slice holds fixed. */
export type SliceAxis = 'i' | 'j' | 'k'

/** `[ni, nj, nk]` — `i` slowest, `k` fastest. */
export type VolumeDims = readonly [number, number, number]

/** The two free axes of a slice, in the order (across, up). */
export function freeAxes(axis: SliceAxis): [0 | 1 | 2, 0 | 1 | 2] {
  if (axis === 'i') return [1, 2]
  if (axis === 'j') return [0, 2]
  return [0, 1]
}

/** The index of the axis a slice holds fixed. */
export function fixedAxis(axis: SliceAxis): 0 | 1 | 2 {
  return axis === 'i' ? 0 : axis === 'j' ? 1 : 2
}

/** How many slices this axis has — the range `index` may take. */
export function sliceCount(dims: VolumeDims, axis: SliceAxis): number {
  return dims[fixedAxis(axis)]
}

/** The quad's extent in VOXELS: `[across, up]`. A caller sizing an axes wants
 *  this times the matching voxel sizes, or the slice renders anisotropic. */
export function sliceExtent(dims: VolumeDims, axis: SliceAxis): [number, number] {
  const [a, u] = freeAxes(axis)
  return [dims[a], dims[u]]
}

/**
 * Quad UV (0..1 across, 0..1 up) + a slice index → the voxel it names.
 *
 * `index` is NOT normalised: it is a voxel index along the fixed axis, because
 * that is what a reader scrubs and what a crosshair reports. Normalising it
 * would put the caller in the business of knowing the volume's depth to say
 * "slice 128", which is the one thing this function already knows.
 */
export function sliceVoxel(
  u: number, v: number, index: number, dims: VolumeDims, axis: SliceAxis,
): [number, number, number] {
  const [a, up] = freeAxes(axis)
  const out: [number, number, number] = [0, 0, 0]
  const clampIdx = (x: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(x)))
  out[a] = clampIdx(u * dims[a], dims[a])
  out[up] = clampIdx(v * dims[up], dims[up])
  out[fixedAxis(axis)] = clampIdx(index, dims[fixedAxis(axis)])
  return out
}

/**
 * Quad UV + a slice index → the normalised texture coordinate to SAMPLE.
 *
 * TEXEL CENTRES, not edges: `(voxel + 0.5) / n` on every axis. On the fixed axis
 * this is what stops a slice landing exactly between two planes, where a linear
 * sampler returns their average — a blurred slice that looks like a slightly
 * thick one and is actually two. On the free axes it is the same rule the
 * categorical LUT needs, for the same reason.
 *
 * Returned in the volume's OWN axis order `[i, j, k]`; mapping that to a
 * `Data3DTexture`'s (x, y, z) is the uploader's job, and it does it in one place
 * (`volumeTexture.ts`) so the two cannot disagree.
 */
export function sliceUVW(
  u: number, v: number, index: number, dims: VolumeDims, axis: SliceAxis,
): [number, number, number] {
  const [a, up] = freeAxes(axis)
  const f = fixedAxis(axis)
  const w: [number, number, number] = [0, 0, 0]
  // The free axes stay CONTINUOUS — a linear sampler is the point on a T1, and
  // flooring here would quantise the image to voxels at every zoom.
  w[a] = clamp01(u)
  w[up] = clamp01(v)
  // The fixed axis is a texel CENTRE, because a slice IS one plane of voxels.
  w[f] = (Math.min(dims[f] - 1, Math.max(0, Math.floor(index))) + 0.5) / dims[f]
  return w
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * The inverse of `sliceVoxel`'s free half: a voxel → the quad UV that names it.
 *
 * What a crosshair needs. Returns the voxel's CENTRE, so the crosshair sits in
 * the middle of the voxel it reports rather than on its lower edge — a half-voxel
 * offset is invisible on a 256³ volume and wrong in exactly the place a reader
 * clicks to check it.
 */
export function voxelToSliceUV(
  voxel: readonly [number, number, number], dims: VolumeDims, axis: SliceAxis,
): [number, number] {
  const [a, up] = freeAxes(axis)
  return [(voxel[a] + 0.5) / dims[a], (voxel[up] + 0.5) / dims[up]]
}
