import { describe, it, expect } from 'vitest'
import { dedupeRamps } from './AxesLegend'

describe('dedupeRamps', () => {
  const e = (title: string, colormap: string, clim: [number, number]) =>
    ({ title, unit: '', colormap, clim })

  it('keeps the FIRST ramp and hides a later identical one', () => {
    // The normal case: a cortex coloured by ‖J‖ beside glyphs coloured by ‖J‖.
    const out = dedupeRamps([
      e('‖J‖', 'turbo', [0, 1.28]),
      e('‖J‖', 'turbo', [0, 1.28]),
    ])
    expect(out.map((x) => x.rampShown)).toEqual([true, false])
    // The ENTRY survives — its title says which layer, and the vector still owns a
    // length mapping the ramp says nothing about.
    expect(out).toHaveLength(2)
  })

  it('keeps both when the mapping genuinely differs', () => {
    expect(dedupeRamps([
      e('∇·J', 'coolwarm', [-240, 240]),
      e('‖J‖', 'turbo', [0, 1.28]),
    ]).map((x) => x.rampShown)).toEqual([true, true])
  })

  it('treats a clim change as a different mapping', () => {
    expect(dedupeRamps([
      e('a', 'turbo', [0, 1]),
      e('b', 'turbo', [0, 2]),
    ]).map((x) => x.rampShown)).toEqual([true, true])
  })
})
