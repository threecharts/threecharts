/**
 * `tickValuesOverride` — an axis whose coordinate is not a QUANTITY.
 *
 * A lane chart stacks C channels of S scales into one [C·S, T] raster, so its y
 * coordinate is a row index and `niceTicks` over [0, 600] returns 0, 200, 400, 600 —
 * round numbers naming nothing. What the ruler wants is a tick per LANE.
 */
import { describe, it, expect } from 'vitest'
import { Axis } from './Axis'

describe('Axis.tickValuesOverride', () => {
  it('defaults to null, so ticks are computed', () => {
    const a = new Axis('y')
    expect(a.tickValuesOverride).toBeNull()
    a.limits = [0, 10]
    expect(a.tickValues().length).toBeGreaterThan(0)
  })

  it('returns the supplied positions when set', () => {
    const a = new Axis('y')
    a.limits = [0, 100]
    const lanes = [10, 30, 50, 70, 90]
    a.tickValuesOverride = lanes
    expect(a.tickValues()).toEqual(lanes)
  })

  it('CLIPS to the limits — a scrolled window must not label rows off screen', () => {
    const a = new Axis('y')
    a.limits = [20, 60]
    a.tickValuesOverride = [0, 10, 30, 50, 70, 90]
    expect(a.tickValues()).toEqual([30, 50])
  })

  it('clips against REVERSED limits too', () => {
    const a = new Axis('y')
    a.limits = [60, 20]
    a.tickValuesOverride = [10, 30, 50, 70]
    expect(a.tickValues()).toEqual([30, 50])
  })

  it('an empty override yields no ticks — it is a list, not a fallback', () => {
    const a = new Axis('y')
    a.limits = [0, 100]
    a.tickValuesOverride = []
    expect(a.tickValues()).toEqual([])
  })

  it('setting it back to null restores computed ticks', () => {
    const a = new Axis('y')
    a.limits = [0, 10]
    a.tickValuesOverride = [1, 2]
    expect(a.tickValues()).toEqual([1, 2])
    a.tickValuesOverride = null
    expect(a.tickValues()).not.toEqual([1, 2])
    expect(a.tickValues().length).toBeGreaterThan(0)
  })

  it('composes with tickFormat — positions here, names there', () => {
    const a = new Axis('y')
    a.limits = [0, 100]
    a.tickValuesOverride = [15, 45]
    a.tickFormat = (v) => `lane${v}`
    expect(a.tickValues().map((v) => a.tickFormat!(v))).toEqual(['lane15', 'lane45'])
  })
})
