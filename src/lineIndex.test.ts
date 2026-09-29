import { describe, it, expect } from 'vitest'
import { lineVertexIndex, type LineIndexSpec, type LineIndexMode } from './lineIndex'

/**
 * The CPU mirror of `Line._decode`. These assertions are the contract the TSL is
 * written to satisfy — the shader itself cannot be run here.
 */
describe('lineVertexIndex', () => {
  describe('frame-indexed', () => {
    const spec: LineIndexSpec = { channels: 3, slots: 4, mode: { kind: 'samples' } }

    it('walks a channel contiguously and starts each channel on its own row', () => {
      expect([0, 1, 2, 3].map((v) => lineVertexIndex(v, spec).flat)).toEqual([0, 1, 2, 3])
      expect(lineVertexIndex(4, spec)).toEqual({ chan: 1, flat: 4 })
      expect(lineVertexIndex(11, spec)).toEqual({ chan: 2, flat: 11 })
    })

    it('offsets by a whole frame per timepoint', () => {
      expect(lineVertexIndex(5, { ...spec, timepoint: 2 })).toEqual({ chan: 1, flat: 2 * 12 + 5 })
    })

    it('reads through the row map while chan stays the DRAWN index', () => {
      // Drawn channel 1 is buffer row 7 — the baseline follows the drawn index (1),
      // the read follows the map (7). Conflating them is the montage defect.
      const mapped = { ...spec, rowMap: [4, 7, 0] }
      expect(lineVertexIndex(4, mapped)).toEqual({ chan: 1, flat: 7 * 4 + 0 })
      expect(lineVertexIndex(6, mapped)).toEqual({ chan: 1, flat: 7 * 4 + 2 })
    })
  })

  describe('windowed', () => {
    const spec: LineIndexSpec = {
      channels: 2, slots: 4, mode: { kind: 'samples', totalSamples: 100 },
    }

    it('reads a window at scroll into a channel-major page', () => {
      expect(lineVertexIndex(0, { ...spec, scroll: 30 })).toEqual({ chan: 0, flat: 30 })
      expect(lineVertexIndex(3, { ...spec, scroll: 30 })).toEqual({ chan: 0, flat: 33 })
      // Channel 1 starts a whole page-row later, not a window later.
      expect(lineVertexIndex(4, { ...spec, scroll: 30 })).toEqual({ chan: 1, flat: 130 })
    })

    it('floors a fractional scroll, as the shader floors its uniform', () => {
      expect(lineVertexIndex(0, { ...spec, scroll: 30.9 }).flat).toBe(30)
    })

    it('ignores the timepoint — a windowed line reads a page, not a frame', () => {
      expect(lineVertexIndex(1, { ...spec, scroll: 5, timepoint: 9 }).flat).toBe(6)
    })
  })

  describe('envelope', () => {
    // 3 drawn buckets of a 50-bucket buffer: 6 slots a channel, 100 in the buffer.
    const spec: LineIndexSpec = {
      channels: 2, slots: 6, mode: { kind: 'envelope', totalBuckets: 50 },
    }

    it('pairs min and max within a bucket', () => {
      expect([0, 1, 2, 3].map((v) => lineVertexIndex(v, spec).flat)).toEqual([0, 1, 2, 3])
    })

    it('scrolls in BUCKETS, two slots at a time', () => {
      expect(lineVertexIndex(0, { ...spec, scroll: 10 }).flat).toBe(20)
      expect(lineVertexIndex(1, { ...spec, scroll: 10 }).flat).toBe(21)
      expect(lineVertexIndex(2, { ...spec, scroll: 10 }).flat).toBe(22)
    })

    it('strides by the BUFFER width, not the drawn one', () => {
      // The trap this exists to catch: 6 (the geometry's slots) instead of 100.
      expect(lineVertexIndex(6, spec)).toEqual({ chan: 1, flat: 100 })
    })

    it('reads through the row map', () => {
      expect(lineVertexIndex(6, { ...spec, rowMap: [3, 5] })).toEqual({ chan: 1, flat: 500 })
    })
  })

  describe('3D curves', () => {
    const spec: LineIndexSpec = { channels: 2, slots: 5, mode: { kind: 'curve3d' } }

    it('indexes whole points at the clock frame', () => {
      expect(lineVertexIndex(7, spec)).toEqual({ chan: 1, flat: 7 })
      expect(lineVertexIndex(7, { ...spec, timepoint: 3 })).toEqual({ chan: 1, flat: 30 + 7 })
    })

    it('ignores the row map — a curve buffer IS its geometry', () => {
      expect(lineVertexIndex(7, { ...spec, rowMap: [9, 9] }).flat).toBe(7)
    })
  })

  it('agrees with itself across modes at the origin', () => {
    // Vertex 0 of channel 0 is buffer slot 0 in every mode with no scroll or frame.
    const modes: LineIndexMode[] = [
      { kind: 'samples' },
      { kind: 'samples', totalSamples: 100 },
      { kind: 'envelope', totalBuckets: 50 },
      { kind: 'curve3d' },
    ]
    for (const mode of modes) {
      expect(lineVertexIndex(0, { channels: 2, slots: 6, mode })).toEqual({ chan: 0, flat: 0 })
    }
  })
})
