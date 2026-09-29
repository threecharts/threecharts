// @vitest-environment node
/**
 * THE colormap resolver's rules.
 *
 * These exist because the failure they guard against is invisible: before the purge a
 * name with no atlas row silently drew row 0, so six of the design system's twelve
 * colormaps rendered as viridis under their own gradient for as long as they existed.
 * A miss must be a NULL that the caller has to decide about — never a row that looks
 * like a choice.
 */
import { describe, it, expect } from 'vitest'
import { matchColormapRow } from './colormap-node'

const ENTRIES = [
  { name: 'viridis', index: 0 },
  { name: 'RdBu_r', index: 11 },
  { name: 'balance', index: 13 },
  { name: 'tab10', index: 18 },
]

describe('matchColormapRow', () => {
  it('resolves an exact name to its row', () => {
    expect(matchColormapRow(ENTRIES, 'balance')).toBe(13)
    expect(matchColormapRow(ENTRIES, 'viridis')).toBe(0)
  })

  it('resolves case-insensitively — the atlas ships RdBu_r, the codebase wrote rdbu_r', () => {
    expect(matchColormapRow(ENTRIES, 'rdbu_r')).toBe(11)
    expect(matchColormapRow(ENTRIES, 'RDBU_R')).toBe(11)
  })

  it('prefers the EXACT match when two entries differ only by case', () => {
    const both = [{ name: 'vik', index: 1 }, { name: 'vikO', index: 2 }, { name: 'viko', index: 3 }]
    expect(matchColormapRow(both, 'vikO')).toBe(2)
    expect(matchColormapRow(both, 'viko')).toBe(3)
  })

  it('returns NULL for a name the atlas does not have — never row 0', () => {
    for (const gone of ['parula', 'blackbody', 'kindlmann', 'moreland', 'grayscale']) {
      expect(matchColormapRow(ENTRIES, gone)).toBeNull()
    }
  })

  it('returns null against an empty atlas rather than inventing a row', () => {
    expect(matchColormapRow([], 'viridis')).toBeNull()
  })
})
