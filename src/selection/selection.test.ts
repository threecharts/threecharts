import { describe, it, expect } from 'vitest'
import {
  createMask, composeMask, maskCount, maskBounds, maskFromVertices, verticesFromMask,
} from './selectionMask'
import { ActiveSelection } from './ActiveSelection'
import { parseCssColor } from '../css'

const m = (...v: number[]) => Float32Array.from(v)

describe('composeMask', () => {
  it('composes with float min/max so a SOFT selection survives', () => {
    // The whole reason these are not boolean: a region grown from a band-limited
    // basis arrives feathered, and an `add` that rounded to 0|1 would harden every
    // edge the moment two selections met.
    expect([...composeMask(m(0.5, 0, 1), m(0.25, 0.75, 0), 'add')]).toEqual([0.5, 0.75, 1])
    expect([...composeMask(m(0.5, 1, 1), m(0.25, 0.75, 0), 'intersect')]).toEqual([0.25, 0.75, 0])
  })

  it('subtract is 1 − contribution, not a boolean clear', () => {
    expect([...composeMask(m(1, 1), m(0.25, 1), 'subtract')]).toEqual([0.75, 0])
  })

  it('replace overwrites wholesale', () => {
    expect([...composeMask(m(1, 1, 1), m(0, 0.5, 0), 'replace')]).toEqual([0, 0.5, 0])
  })

  it('refuses a length mismatch rather than composing a prefix', () => {
    expect(() => composeMask(createMask(3), createMask(4), 'add')).toThrow(RangeError)
  })
})

describe('mask helpers', () => {
  it('counts anything strictly positive, including partial membership', () => {
    expect(maskCount(m(0, 0.01, 0, 1))).toBe(2)
  })

  it('round-trips vertex ids', () => {
    expect(verticesFromMask(maskFromVertices(5, [3, 1]))).toEqual([1, 3])
  })

  it('ignores out-of-range ids instead of growing the mask', () => {
    expect(verticesFromMask(maskFromVertices(3, [-1, 1, 99]))).toEqual([1])
  })

  it('bounds only the selected vertices, and is null when none are', () => {
    const pos = [0, 0, 0, 10, 1, 2, 5, 5, 5]
    expect(maskBounds(m(0, 1, 1), pos)).toEqual({ min: [5, 1, 2], max: [10, 5, 5] })
    expect(maskBounds(m(0, 0, 0), pos)).toBeNull()
  })
})

describe('ActiveSelection', () => {
  it('previews the pending gesture without committing it', () => {
    const s = new ActiveSelection(4)
    s.setPending(maskFromVertices(4, [1]), 'add', { tool: 'pick', params: { vertex: 1 } })
    expect(verticesFromMask(s.read())).toEqual([1])
    expect(verticesFromMask(s.committed())).toEqual([])
    s.commit()
    expect(verticesFromMask(s.committed())).toEqual([1])
  })

  it('bakes the previous gesture when a new one starts', () => {
    const s = new ActiveSelection(4)
    s.setPending(maskFromVertices(4, [0]), 'add', { tool: 'pick', params: {} })
    s.setPending(maskFromVertices(4, [2]), 'add', { tool: 'pick', params: {} })
    // The first is committed, the second is still previewing — both visible in read().
    expect(verticesFromMask(s.committed())).toEqual([0])
    expect(verticesFromMask(s.read())).toEqual([0, 2])
  })

  it('re-running a gesture REPLACES its contribution — the size-knob case', () => {
    // A radius drag re-runs one gesture many times; if each pass composed onto
    // committed, shrinking the radius could never take a vertex back.
    const s = new ActiveSelection(4)
    s.setPending(maskFromVertices(4, [0, 1, 2]), 'replace', { tool: 'region', params: { r: 2 } })
    s.setPending(maskFromVertices(4, [0]), 'replace', { tool: 'region', params: { r: 1 } })
    expect(verticesFromMask(s.read())).toEqual([0])
  })

  it('advances the revision by two on clear whether or not a gesture was live', () => {
    const a = new ActiveSelection(2)
    const before = a.revision
    a.clear()
    const bare = a.revision - before
    const b = new ActiveSelection(2)
    b.setPending(maskFromVertices(2, [0]), 'add', { tool: 'pick', params: {} })
    const r0 = b.revision
    b.clear()
    expect(b.revision - r0).toBe(bare)
  })

  it('refuses a contribution of the wrong length', () => {
    const s = new ActiveSelection(4)
    expect(() => s.setPending(createMask(3), 'add', { tool: 'x', params: {} })).toThrow(RangeError)
  })

  it('summary carries the pending gesture, and drops it once committed', () => {
    const s = new ActiveSelection(3)
    const pos = [0, 0, 0, 1, 1, 1, 2, 2, 2]
    s.setPending(maskFromVertices(3, [1]), 'add', { tool: 'region', params: { seed: 1 } })
    expect(s.summary(pos).pendingGesture).toEqual({ tool: 'region', params: { seed: 1 } })
    expect(s.summary(pos).count).toBe(1)
    s.commit()
    expect(s.summary(pos).pendingGesture).toBeUndefined()
  })
})

describe('parseCssColor', () => {
  // `getComputedStyle` returns different spellings per browser for the same token —
  // a `color-mix()` resolves to space-separated `rgb()` in Chromium — so the parser
  // has to take all of them rather than the one the token was authored in.
  it('takes both hex lengths, dropping any alpha pair', () => {
    expect(parseCssColor('#abc')).toBe(0xaabbcc)
    expect(parseCssColor('#1E90FF')).toBe(0x1e90ff)
    expect(parseCssColor('#1e90ff80')).toBe(0x1e90ff)
  })

  it('takes both rgb() spellings', () => {
    expect(parseCssColor('rgb(30, 144, 255)')).toBe(0x1e90ff)
    expect(parseCssColor('rgba(30,144,255,0.5)')).toBe(0x1e90ff)
    expect(parseCssColor('rgb(30 144 255 / 50%)')).toBe(0x1e90ff)
  })

  it('clamps and rounds out-of-gamut components rather than wrapping', () => {
    expect(parseCssColor('rgb(300 -10 255.6)')).toBe(0xff00ff)
  })

  it('returns null for what it cannot read, so the caller can fall back', () => {
    for (const bad of ['', 'oklch(0.7 0.1 200)', 'color(srgb 1 0 0)', 'nonsense']) {
      expect(parseCssColor(bad)).toBeNull()
    }
  })
})
