import { describe, it, expect } from 'vitest'
import { Group } from 'three/webgpu'
import { Drawable } from './Drawable'
import { Volume } from './Volume'
import { Fibers } from './Fibers'
import type { Axes } from './Axes'
import type { Bounds } from './limits'

/** A drawable that only counts how often it was asked to react. */
class Probe extends Drawable {
  reacts = 0
  invalidations = 0
  constructor() { super({ colormap: 'viridis' } as unknown as Axes, new Group()) }
  protected onClimChanged(): void { this.reacts++ }
  override invalidate(): void { this.invalidations++; super.invalidate() }
  dataBounds(): Bounds | null { return null }
}

describe('Drawable clim', () => {
  it('defaults to the unit range', () => {
    expect(new Probe().clim()).toEqual([0, 1])
  })

  it('retargets, and tells the subclass once', () => {
    const d = new Probe()
    d.setClim([-3, 7])
    expect(d.clim()).toEqual([-3, 7])
    expect(d.reacts).toBe(1)
  })

  /**
   * The early-out is the load-bearing part, not a micro-optimisation.
   *
   * An auto-clim that tracks the data writes this on every frame the time cursor
   * moves. For a drawable that BAKES the range into its colour node, reacting to an
   * unchanged value means recompiling the shader — during a drag, which is the one
   * moment it must not happen.
   */
  it('does nothing at all when the range is unchanged', () => {
    const d = new Probe()
    d.setClim([0, 5])
    const { reacts, invalidations } = d
    d.setClim([0, 5])
    d.setClim([0, 5])
    expect(d.reacts).toBe(reacts)
    expect(d.invalidations).toBe(invalidations)
  })

  /**
   * Two drawables held a clim that nothing could retarget: `Volume` and `Fibers`
   * declared one and never grew a setter. Hoisting the concern closed both gaps as
   * a side effect — which is the argument for hoisting it rather than tidying six
   * copies in place.
   */
  it('gives every drawable a working setter, including the two that lacked one', () => {
    for (const C of [Volume, Fibers]) {
      expect(typeof C.prototype.setClim).toBe('function')
      expect(typeof C.prototype.clim).toBe('function')
    }
  })
})
