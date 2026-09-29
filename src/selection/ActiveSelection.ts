/**
 * `ActiveSelection` — one committed mask plus one live pending gesture.
 *
 * The pending slot is what makes a size knob cheap: a gesture is held as a
 * CONTRIBUTION plus the parameters that produced it, so re-running it with a new
 * radius replaces the contribution and never touches what was already committed.
 * Starting a new gesture bakes the previous one.
 *
 * Pure logic — no three, no GPU, no React. Ported from the deprecated
 * `@nxr/charts-webgpu`, which had already isolated it this way.
 */

import {
  type ComposeOp, createMask, cloneMask, composeMask, maskCount, maskBounds,
} from './selectionMask'

/** The parametric descriptor of the live gesture — e.g.
 *  `{ tool: 'region', params: { seed: 12, radius: 0.3 } }`. */
export interface PendingGesture {
  tool: string
  params: Record<string, number | number[]>
}

/** What a host needs to render its chrome. Per-vertex membership is read on demand
 *  through `read()`, never carried in here — this is the object that crosses into
 *  React, and a 20k-element array crossing every gesture is how a picker becomes the
 *  slowest thing on screen. */
export interface SelectionSummary {
  count: number
  bounds: { min: [number, number, number]; max: [number, number, number] } | null
  revision: number
  activeTool: string
  pendingGesture?: PendingGesture
}

interface Pending {
  contribution: Float32Array
  op: ComposeOp
  gesture: PendingGesture
}

export class ActiveSelection {
  readonly n: number
  private _committed: Float32Array
  private _pending: Pending | null = null
  private _revision = 0
  /** Most-recent tool to touch the selection — surfaced in the summary. */
  activeTool = 'navigate'

  constructor(n: number) {
    this.n = n
    this._committed = createMask(n)
  }

  get revision(): number { return this._revision }

  /** The baked selection. Returns the LIVE buffer — clone before mutating. */
  committed(): Float32Array { return this._committed }

  /** Committed composed with the pending gesture — what the renderer draws. A fresh
   *  array each call, so a caller may hand it straight to a GPU buffer. */
  read(): Float32Array {
    const out = cloneMask(this._committed)
    if (this._pending) composeMask(out, this._pending.contribution, this._pending.op)
    return out
  }

  /** Set the live gesture, baking any prior one first. */
  setPending(contribution: Float32Array, op: ComposeOp, gesture: PendingGesture): void {
    if (contribution.length !== this.n) {
      throw new RangeError(
        `ActiveSelection.setPending: contribution length ${contribution.length} != n ${this.n}`,
      )
    }
    if (this._pending) {
      this.bakePending()
      this._revision++
    }
    this._pending = { contribution, op, gesture }
    this.activeTool = gesture.tool
  }

  private bakePending(): void {
    if (!this._pending) return
    composeMask(this._committed, this._pending.contribution, this._pending.op)
    this._pending = null
  }

  /** Bake the pending gesture and advance the revision. */
  commit(): void {
    this.bakePending()
    this._revision++
  }

  /** Reset to empty. Advances the revision by TWO — one for clearing committed, one
   *  for discarding any pending gesture — so the step is the same whether or not a
   *  gesture was live, and a host polling on revision cannot miss a clear. */
  clear(): void {
    this._committed = createMask(this.n)
    this._pending = null
    this._revision += 2
  }

  /** `positions` is the flat `geometry.attributes.position` array. */
  summary(positions: ArrayLike<number>): SelectionSummary {
    const previewed = this.read()
    return {
      count: maskCount(previewed),
      bounds: maskBounds(previewed, positions),
      revision: this._revision,
      activeTool: this.activeTool,
      ...(this._pending ? { pendingGesture: this._pending.gesture } : {}),
    }
  }
}
