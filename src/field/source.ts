// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray } from 'three/tsl'
import { asReadOnly } from '../storage-access'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A GPU storage-buffer node — what `attributeArray` returns and what a shader
 * indexes.
 *
 * Typed loosely, and honestly: `three` ships no declarations for `three/tsl`, so
 * there is no real type to name. The value here is not enforcement — it is that a
 * signature reading `FieldSource` tells a reader "an array or a GPU buffer", where
 * `unknown` told them nothing at all.
 */
export type StorageNode = { readonly isStorageBufferNode?: boolean } & object

/**
 * Any TSL node — a uniform, an expression, a buffer read. Typed loosely for the
 * same reason as `StorageNode`: there is no declaration to name.
 */
export type ShaderNode = object

/**
 * Which slice of a stacked `[frames × …]` field to read.
 *
 * Omit it and the drawable follows the figure's shared clock, so every layer
 * animates in lock-step. Pass a NUMBER to pin a slice — a spectrogram, a template,
 * anything that must not follow playback. Pass a node for the advanced case: any
 * uniform evaluating to a frame index, which is what lets a host drive one layer
 * from a different timeline.
 */
export type Timepoint = number | ShaderNode

/** Element layout of a field's values. */
export type FieldElem = 'float' | 'vec2' | 'vec3' | 'vec4'

/**
 * What every field-valued input accepts.
 *
 * **TSL is the implementation, never the entry fee.** A node is ACCEPTED — that
 * is the compute-backed path this system exists for, where a kernel writes the
 * buffer a chart reads with no copy and no readback. It is simply never REQUIRED,
 * because a user plotting five thousand points should not have to know that GPU
 * memory exists, let alone import from a package they did not choose.
 */
export type FieldSource = Float32Array | StorageNode

/** A resolved field: one read-only node, plus who owns the memory behind it. */
export interface ResolvedField {
  /** Read-only view for a shader to index. */
  readonly node: unknown
  /** The CPU-side values when THIS module allocated the buffer, else null — a
   *  host reads it to keep picking consistent with what is drawn. */
  readonly values: Float32Array | null
  /** Whether we allocated it, and so may rewrite and free it. */
  readonly owned: boolean
  /** Rewrite the values in place. Throws when the buffer is externally owned. */
  set(v: Float32Array): void
  /** Free it, if it is ours to free. */
  dispose(): void
}

/**
 * Normalise either form of field source into one handle.
 *
 * This is the two-source contract stated ONCE. It was previously written out in
 * `Quiver` (anchors), `Particles` (positions) and `vertex-mask`, with the
 * ownership rule re-explained in prose each time — and applied only to those
 * secondary parameters, never to the field VALUES every caller passes first.
 *
 * The ownership rule, which is the part that matters: **a caller who did not hand
 * over a buffer cannot be handed write access to one.** Values we copied are ours
 * to rewrite and free; a node handed to us is read-only and outlives us, because
 * something else — a compute pass, another drawable — is using it.
 */
export function resolveField(src: FieldSource, elem: FieldElem = 'float'): ResolvedField {
  if (src instanceof Float32Array) {
    /* COPIED, not referenced. A caller who mutates their array afterwards must not
       silently change what is drawn — the same decision MATLAB makes when `plot`
       captures its arguments, and the one that makes a chart's data predictable. */
    const values = Float32Array.from(src)
    const owned = (attributeArray as (d: unknown, t: string) => any)(values, elem)
    return {
      node: asReadOnly(owned),
      values,
      owned: true,
      set(v: Float32Array): void {
        if (v.length !== values.length) {
          throw new Error(`setData: ${v.length} values != ${values.length}`)
        }
        values.set(v)
        ;(owned.value as { needsUpdate: boolean }).needsUpdate = true
      },
      dispose(): void { (owned.value as { dispose?: () => void }).dispose?.() },
    }
  }

  return {
    node: asReadOnly(src),
    values: null,
    owned: false,
    set(): void {
      throw new Error(
        'setData: this field is externally owned — pass a Float32Array to own it, ' +
        'or write the buffer through whatever produced it',
      )
    },
    dispose(): void { /* not ours */ },
  }
}

/** `resolveField`, but tolerating absence — most secondary fields are optional. */
export function resolveFieldOrNull(
  src: FieldSource | null | undefined,
  elem: FieldElem = 'float',
): ResolvedField | null {
  return src == null ? null : resolveField(src, elem)
}
