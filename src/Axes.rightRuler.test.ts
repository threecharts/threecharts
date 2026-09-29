/**
 * The SECOND y ruler — MATLAB's `yyaxis right`.
 *
 * It shares the y COORDINATE with `yAxis` and differs only in ticks and format. It is
 * NOT a second data axis: nothing plots against it, and giving it its own limits would
 * let a reader take a value off a ruler no drawable used.
 */
import { describe, it, expect } from 'vitest'
import { RIGHT_RULER_RESERVE, COLORBAR_RESERVE, rightMarginPx } from './Axes'

describe('rightMarginPx', () => {
  it('is the base when neither band is shown', () => {
    expect(rightMarginPx(12, false, false)).toBe(12)
  })

  it('reserves the ruler band', () => {
    expect(rightMarginPx(12, true, false)).toBe(12 + RIGHT_RULER_RESERVE)
  })

  it('reserves the colorbar band', () => {
    expect(rightMarginPx(12, false, true)).toBe(12 + COLORBAR_RESERVE)
  })

  /* ADDITIVE because they are different bands: the ruler sits against the plot (its
     ticks point at the data) and the colorbar outside it. Two spellings of one offset
     is how a colorbar gradient comes to sit on top of a hertz label. */
  it('adds BOTH when both are shown', () => {
    expect(rightMarginPx(12, true, true)).toBe(12 + RIGHT_RULER_RESERVE + COLORBAR_RESERVE)
  })

  /* Enough for a 5 px mark, an 8 px gap and a tick label. A reserve that cleared only
     the mark would clip every number on the ruler, which reads as a rendering bug. */
  it('the ruler reserve clears a tick label, not merely the mark', () => {
    expect(RIGHT_RULER_RESERVE).toBeGreaterThanOrEqual(5 + 8 + 20)
  })
})
