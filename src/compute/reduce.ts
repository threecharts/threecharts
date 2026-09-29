import type { WebGPURenderer } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import {
  Fn, If, Loop, float, int, uint, instanceIndex, invocationLocalIndex,
  workgroupId, workgroupArray, workgroupBarrier, attributeArray, min, max, sqrt,
} from 'three/tsl'
import { asReadOnly } from '../storage-access'
import { resolveField, type FieldSource, type ResolvedField } from '../field/source'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What to combine with. */
export type ReduceOp = 'sum' | 'min' | 'max'

/**
 * Threads per workgroup.
 *
 * 256 rather than the 1024 a discrete adapter allows, because
 * `maxComputeInvocationsPerWorkgroup` is **256 on SwiftShader** — which is what CI
 * runs on. A kernel that only fits the development machine is a kernel that fails
 * in CI and on modest hardware, and the difference here is one extra pass over a
 * shrinking array.
 */
const WG = 256

/**
 * The value a lane past the end of the data contributes.
 *
 * **Finite sentinels, not `Infinity`** — WGSL has no infinity LITERAL, so
 * `float(Infinity)` does not survive shader generation and every min/max came back
 * as the identity it started from. `±3.4028234e38` is f32's largest magnitude,
 * which is identity enough for any real datum and is expressible.
 */
const F32_MAX = 3.4028234e38
const IDENTITY: Record<ReduceOp, number> = {
  sum: 0,
  min: F32_MAX,
  max: -F32_MAX,
}

/**
 * Reduce a field to ONE value, on the device.
 *
 * **A tree, not an atomic accumulator — and that is forced, not chosen.** WGSL has
 * no `atomic<f32>`: atomics are integer-only. So the obvious "every thread adds
 * into one accumulator" cannot express a float sum at all, and a tree is the only
 * portable way to reduce the data this library actually holds.
 *
 * It is also the right answer numerically, which is a happy coincidence rather
 * than the reason. A sequential f32 sum accumulates error as `O(n)`; a tree as
 * `O(log n)`. And a fixed tree shape is DETERMINISTIC, where atomic accumulation
 * varies with completion order — so results do not change between runs, which is
 * the difference between a tool a scientist trusts and one they check by hand.
 *
 * The result STAYS ON THE DEVICE, as a one-element field. That is the default
 * because most reductions feed another kernel — normalising by a maximum, a
 * z-score, a spectral filter — and never need to be a JavaScript number. Ask for
 * the number with `readValue` only when a CPU decision depends on it.
 */
export interface ReduceOptions {
  /**
   * Applied to each element BEFORE the fold, on the FIRST pass only.
   *
   * Fused into the reduction rather than materialised, which is the difference
   * between one dispatch and two plus a temporary the size of the input. It is
   * what lets `variance` square deviations without ever writing them down.
   */
  map?: (value: unknown, index: unknown) => unknown
}

export async function reduce(
  renderer: WebGPURenderer,
  values: FieldSource,
  count: number,
  op: ReduceOp,
  opts: ReduceOptions = {},
): Promise<ResolvedField> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`reduce: count must be a positive integer, got ${count}`)
  }
  const src = resolveField(values, 'float')

  const combine = (a: any, b: any): any =>
    op === 'sum' ? a.add(b) : op === 'min' ? min(a, b) : max(a, b)

  let input: any = src.node
  let n = count
  let owned: ResolvedField | null = null
  let first = true

  /* Each pass turns `n` values into ceil(n / WG); repeat until one remains. AT
     LEAST ONE PASS ALWAYS RUNS, even for a single element. That is not symmetry
     for its own sake: three creates a device buffer lazily, on first use, so a
     field that was never dispatched has nothing to read back — returning the input
     untouched made `readValue` fail with a null-dereference inside three rather
     than with anything meaningful. One trivial workgroup buys a uniform contract. */
  do {
    const groups = Math.ceil(n / WG)
    const outValues = new Float32Array(groups).fill(IDENTITY[op])
    const outAttr = (attributeArray as (d: unknown, t: string) => any)(outValues, 'float')
    const nUniform = n
    const isFirst = first
    first = false

    const kernel = (Fn as any)(() => {
      const scratch = workgroupArray('float', WG)
      const lid: any = invocationLocalIndex
      const gid: any = instanceIndex

      /* Out-of-range lanes seed the IDENTITY rather than skipping, so every lane
         contributes a well-defined value and the tree below needs no bounds test
         at each level. Skipping would leave stale workgroup memory in the fold. */
      const v: any = float(IDENTITY[op]).toVar()
      If(gid.lessThan(uint(nUniform)), () => {
        const raw: any = float((input as any).element(gid))
        // The map belongs to the FIRST pass only — later passes fold PARTIALS,
        // which have already been transformed and must not be again.
        v.assign(isFirst && opts.map ? (opts.map(raw, gid) as any) : raw)
      })
      scratch.element(lid).assign(v)
      workgroupBarrier()

      // Fold in halves: 128, 64, … 1. A fixed shape, hence a deterministic result.
      Loop({ start: uint(WG / 2), end: uint(0), condition: '>', update: '>>= 1' }, ({ i }: any) => {
        If(lid.lessThan(i), () => {
          scratch.element(lid).assign(combine(scratch.element(lid), scratch.element(lid.add(i))))
        })
        workgroupBarrier()
      })

      If(lid.equal(uint(0)), () => {
        ;(outAttr as any).element((workgroupId as any).x).assign(scratch.element(uint(0)))
      })
    })().compute(groups * WG, [WG])

    await (renderer as any).computeAsync(kernel)

    owned = {
      node: asReadOnly(outAttr),
      values: outValues,
      owned: true,
      set() { throw new Error('reduce: the result is computed, not settable') },
      dispose() { (outAttr.value as { dispose?: () => void }).dispose?.() },
    }
    input = owned.node
    n = groups
  } while (n > 1)

  return owned!
}

/** Bring a one-element field back to the host. The only place a reduction costs a
 *  round trip — everything above stays on the device. */
export async function readValue(renderer: WebGPURenderer, field: ResolvedField): Promise<number> {
  const attr = (field.node as { value?: unknown }).value ?? field.node
  const buf = await (renderer as any).getArrayBufferAsync(attr)
  return new Float32Array(buf)[0]
}

/**
 * `[min, max]` of a field, read back — the auto-clim case.
 *
 * Two reductions and two round trips, which is why this is a distinct call rather
 * than the default: it is the one shape where a CPU decision genuinely depends on
 * the answer, and it should be done ONCE over the whole stack rather than per
 * frame. Per-frame limits make an axes breathe, and a travelling wave then looks
 * stationary while the world moves around it.
 */
export async function extent(
  renderer: WebGPURenderer,
  values: FieldSource,
  count: number,
): Promise<[number, number]> {
  const src = resolveField(values, 'float')
  const lo = await reduce(renderer, src.node as FieldSource, count, 'min')
  const hi = await reduce(renderer, src.node as FieldSource, count, 'max')
  return [await readValue(renderer, lo), await readValue(renderer, hi)]
}

/**
 * Apply a function to every element of a field, producing a new one.
 *
 * Tier 1 of R22's taxonomy — a MAP, the class that fuses freely and costs one
 * dispatch. It exists here mostly so a reduction's result can be scaled without a
 * round trip: `mean` is a sum divided by a count, and that division should not
 * require the sum to become a JavaScript number first.
 */
export async function mapField(
  renderer: WebGPURenderer,
  values: FieldSource,
  count: number,
  fn: (value: unknown, index: unknown) => unknown,
): Promise<ResolvedField> {
  const src = resolveField(values, 'float')
  const outValues = new Float32Array(count)
  const outAttr = (attributeArray as (d: unknown, t: string) => any)(outValues, 'float')

  const kernel = (Fn as any)(() => {
    const i: any = instanceIndex
    If(i.lessThan(uint(count)), () => {
      ;(outAttr as any).element(i).assign(fn(float((src.node as any).element(i)), i))
    })
  })().compute(count)
  await (renderer as any).computeAsync(kernel)

  return {
    node: asReadOnly(outAttr),
    values: outValues,
    owned: true,
    set() { throw new Error('mapField: the result is computed, not settable') },
    dispose() { (outAttr.value as { dispose?: () => void }).dispose?.() },
  }
}

/** The arithmetic mean, as a one-element field on the device. */
export async function mean(
  renderer: WebGPURenderer,
  values: FieldSource,
  count: number,
): Promise<ResolvedField> {
  const total = await reduce(renderer, values, count, 'sum')
  return mapField(renderer, total.node as FieldSource, 1, (x: any) => x.div(float(count)))
}

export interface VarianceOptions {
  /**
   * Divide by `n − 1` rather than `n`. Default TRUE — MATLAB's `std` normalises by
   * `N − 1`, and `DIRECTION.md` says to prefer MATLAB's answer where it has one.
   * (numpy defaults the other way, so this is worth stating rather than assuming.)
   */
  sample?: boolean
}

/**
 * Variance, in TWO passes — and the second pass is the whole argument for keeping
 * a reduction's result on the device.
 *
 * The one-pass identity `E[x²] − E[x]²` is algebraically correct and numerically
 * catastrophic: when the mean is large relative to the spread, both terms are huge
 * and nearly equal, so f32 subtracts away every significant digit. A field centred
 * on 10⁶ with a spread of 1 loses the answer entirely.
 *
 * The stable form sums `(x − mean)²`, which needs the mean already computed. Here
 * that mean is a one-element FIELD, so the second kernel simply reads it — no
 * readback, no `await` in the middle, no JavaScript number. The deviation is
 * squared inside the reduction via `map`, so nothing the size of the input is ever
 * written down.
 */
export async function variance(
  renderer: WebGPURenderer,
  values: FieldSource,
  count: number,
  opts: VarianceOptions = {},
): Promise<ResolvedField> {
  const sample = opts.sample ?? true
  const n = sample ? Math.max(1, count - 1) : count
  const mu = await mean(renderer, values, count)
  const muNode: any = mu.node

  const sumSq = await reduce(renderer, values, count, 'sum', {
    map: (x: any) => {
      const d: any = x.sub(float(muNode.element(int(0))))
      return d.mul(d)
    },
  })
  return mapField(renderer, sumSq.node as FieldSource, 1, (x: any) => x.div(float(n)))
}

/** Standard deviation — the square root of {@link variance}. */
export async function std(
  renderer: WebGPURenderer,
  values: FieldSource,
  count: number,
  opts: VarianceOptions = {},
): Promise<ResolvedField> {
  const v = await variance(renderer, values, count, opts)
  return mapField(renderer, v.node as FieldSource, 1, (x: any) => sqrt(x))
}
