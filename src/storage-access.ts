/**
 * `asReadOnly(node)` — how a drawable READS a storage buffer it does not own.
 *
 * Charts here follow the ownership charter: compute passes and their storage
 * buffers live OUTSIDE the Figure, and a drawable only ever reads them. That
 * makes `node.toReadOnly()` the wrong call — three's `toReadOnly()` MUTATES the
 * node in place and returns `this`, so a chart reaching for a read view instead
 * retracts the producer's write access. Because WGSL is generated lazily at
 * first dispatch, the producer's compute kernel then compiles as
 * `var<storage, read>` and the shader fails to build:
 *
 *   error: cannot store into a read-only type 'ref<storage, f32, read>'
 *
 * It only shows when the drawable is constructed BEFORE the producer dispatches
 * — build the Figure first and a working demo breaks. (The identical defect hit
 * `app/src/compute` on 2026-07-24; see `app/src/compute/buffers.ts`.)
 *
 * This returns a FRESH read-only node over the same buffer, so the access flag
 * stays local to the reader. Both nodes bind the same GPUBuffer — the backend
 * keys buffers off the underlying attribute — so it costs a JS object and
 * nothing on the GPU.
 *
 * Build ONE view per buffer per drawable and reuse it across the node graph
 * (that is what the mutating call used to give you); a fresh view per read site
 * would emit a separate binding for the same buffer in one shader.
 *
 * Rendering is unaffected either way: three forces read-only access in every
 * non-compute stage regardless of the node's flag, so a material node never
 * needed the call — the mutation was pure side effect.
 */

// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { storage } from 'three/tsl'

/**
 * A read-only view of an externally-owned storage-buffer node. Passes `null` /
 * `undefined` straight through, since optional buffers (`opts.sizes`,
 * `opts.values`) are absent as often as not.
 */
export function asReadOnly<T>(node: T): T {
  const n = node as unknown as {
    isStorageBufferNode?: boolean
    value?: { count?: number }
    bufferType?: string
    bufferCount?: unknown
  } | null
  if (n == null) return node
  // Not a storage node (or an exotic one) — leave it to the caller's own read.
  if (n.isStorageBufferNode !== true || n.value == null) return node
  // `attributeArray(data, elem)` passes the seeding TypedArray through as
  // bufferCount; take the attribute's own element count when it isn't a number.
  const count = typeof n.bufferCount === 'number' && n.bufferCount > 0
    ? n.bufferCount
    : (n.value.count ?? 0)
  const view = (storage as unknown as (b: unknown, t: unknown, c: number) => { toReadOnly(): unknown })(
    n.value,
    n.bufferType,
    count,
  ).toReadOnly()
  return view as T
}
