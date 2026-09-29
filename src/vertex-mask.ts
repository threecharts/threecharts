/**
 * `VertexMask` — per-vertex visibility for a mesh drawable.
 *
 * A mask is one float per vertex: >= 0.5 draws, < 0.5 is discarded in the
 * fragment stage. Because it is a *buffer* and not a draw range, it expresses
 * any subset at all — an arbitrary set of hemispheres/components, a cortical
 * ROI, or a thresholded statistic — where a draw range can only express one
 * contiguous span of the index buffer.
 *
 * Interpolation is the useful behaviour here: on a mesh whose components are
 * disconnected (two cortical hemispheres), no triangle spans the boundary, so
 * component masking is exact. On a mask that *does* cut through a triangle (an
 * ROI edge), the 0.5 crossing lands inside the triangle and the boundary comes
 * out smooth rather than stair-stepped.
 *
 * Two sources, one node:
 *   - a typed array — this owns a small GPU buffer and re-uploads on `set()`
 *   - an external storage node — a GPU pass produces the mask; `set()` throws
 *
 * Lives apart from `Surface` on purpose: the glyph drawables (`Quiver`,
 * `Particles`) need the same masking when a viewport hides a hemisphere, and
 * they should share this rather than each growing their own.
 */

// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray } from 'three/tsl'
import { asReadOnly } from './storage-access'

/** What a drawable accepts as a mask: per-vertex values, or an external node. */
export type MaskSource = Uint8Array | Float32Array | unknown

export interface VertexMask {
  /** Read-only storage node — index it with `vertexIndex` in a shader. */
  readonly node: any // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The CPU-side values when this mask owns its buffer, else `null` (the mask
   *  lives only on the GPU). Hosts read this to keep picking consistent with
   *  what is drawn — a discarded fragment is still a raycast hit. */
  readonly values: Float32Array | null
  /** Replace the mask values. Throws if the buffer is externally owned. */
  set(m: Uint8Array | Float32Array): void
}

function isTypedMask(v: unknown): v is Uint8Array | Float32Array {
  return v instanceof Uint8Array || v instanceof Float32Array
}

/**
 * Wrap a mask source for a mesh of `count` vertices. Typed arrays are copied
 * into a GPU buffer this owns; anything else is treated as an external storage
 * node and only read.
 */
export function createVertexMask(source: MaskSource, count: number): VertexMask {
  if (isTypedMask(source)) {
    if (source.length !== count) {
      throw new Error(`vertex mask: length ${source.length} != vertex count ${count}`)
    }
    const values = Float32Array.from(source)
    const owned = (attributeArray as (d: unknown, t: string) => any)(values, 'float')
    const node = asReadOnly(owned)
    return {
      node,
      values,
      set(m) {
        if (m.length !== count) {
          throw new Error(`vertex mask: length ${m.length} != vertex count ${count}`)
        }
        values.set(m)
        // `attributeArray` keeps its StorageBufferAttribute on `.value`; flagging
        // it re-uploads on the next frame — the buffer itself is not reallocated,
        // so every node already bound to it stays valid.
        const attr = (owned as { value?: { needsUpdate: boolean } }).value
        if (attr) attr.needsUpdate = true
      },
    }
  }

  const node = asReadOnly(source)
  return {
    node,
    values: null,
    set() {
      throw new Error('vertex mask: buffer is externally owned — write it on the GPU instead')
    },
  }
}
