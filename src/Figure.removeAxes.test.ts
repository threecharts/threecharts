import { describe, it, expect, vi } from 'vitest'
import { Figure } from './Figure'
import type { AxesLike } from './Figure'

/**
 * `removeAxes` is list bookkeeping plus disposal, and that is what is tested here.
 *
 * A real `Figure` needs a WebGPU device, which no test in this package has (the
 * rest are pure functions — `niceTicks`, `subplotRect`, `limits`). So the method
 * is invoked against a stand-in holding the same `_axes` field it manipulates.
 * That covers the whole of its behaviour: which entries survive, that the removed
 * one is disposed, and what it reports back.
 */
function fakeAxes(): AxesLike & { dispose: ReturnType<typeof vi.fn> } {
  return {
    dispose: vi.fn(),
  } as unknown as AxesLike & { dispose: ReturnType<typeof vi.fn> }
}

/** A minimal host with the one field `removeAxes` touches. Typed by its own shape
 *  rather than as `Figure & { _axes }`: `_axes` is PRIVATE on `Figure`, and the
 *  intersection resolves it to `never` under `strict`. `removeAxes` below takes
 *  `unknown`, so the class type was never needed. */
function host(axes: AxesLike[]): { _axes: AxesLike[] } {
  return { _axes: axes } as { _axes: AxesLike[] }
}

const removeAxes = (h: unknown, a: AxesLike): boolean =>
  (Figure.prototype.removeAxes as (this: unknown, a: AxesLike) => boolean).call(h, a)

describe('Figure.removeAxes', () => {
  it('drops the axes, disposes it, and reports that it was there', () => {
    const a = fakeAxes(), b = fakeAxes()
    const h = host([a, b])

    expect(removeAxes(h, a)).toBe(true)
    expect(h._axes).toEqual([b])
    expect(a.dispose).toHaveBeenCalledTimes(1)
    // The survivor is untouched — removal is not a teardown of the figure.
    expect(b.dispose).not.toHaveBeenCalled()
  })

  it('leaves the list alone and disposes nothing for a foreign axes', () => {
    const a = fakeAxes(), stranger = fakeAxes()
    const h = host([a])

    expect(removeAxes(h, stranger)).toBe(false)
    expect(h._axes).toEqual([a])
    expect(stranger.dispose).not.toHaveBeenCalled()
    expect(a.dispose).not.toHaveBeenCalled()
  })

  it('removing the last axes is legal — renderFrame clears on an empty list', () => {
    const a = fakeAxes()
    const h = host([a])

    expect(removeAxes(h, a)).toBe(true)
    expect(h._axes).toEqual([])
  })

  it('is idempotent: a second removal is a no-op, not a double dispose', () => {
    const a = fakeAxes()
    const h = host([a])

    expect(removeAxes(h, a)).toBe(true)
    expect(removeAxes(h, a)).toBe(false)
    expect(a.dispose).toHaveBeenCalledTimes(1)
  })
})
