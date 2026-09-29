import { describe, it, expect, vi } from 'vitest'
import { Axes } from './Axes'
import type { Drawable } from './Drawable'

/**
 * `Axes.dispose()` needs a WebGPU device end-to-end (a real `scene`/`camera`/
 * `chrome`), which no test in this package has — the same constraint
 * `Figure.removeAxes.test.ts` documents. So, like that file, this invokes the
 * real prototype method against a stand-in holding only the fields it touches.
 *
 * `_children` is left EMPTY here, deliberately, rather than mirroring the real
 * `addDrawable` (which also parents a drawable via `this.add()`, making it a
 * `GraphicsObject` child). That is what isolates the thing this test is FOR:
 * before this fix, `Axes.dispose()` disposed its drawables only as a side
 * effect of `super.dispose()`'s generic child walk — coincidental, not a
 * stated contract of `_drawables`. An empty `_children` proves the axes'
 * OWN bookkeeping is what disposes them now, independent of that walk.
 */
function fakeDrawable(): Drawable & { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() } as unknown as Drawable & { dispose: ReturnType<typeof vi.fn> }
}

/* Deliberately NOT an intersection with `Axes`. `chrome`, `colorbarOverlay` and
   `_drawables` are PRIVATE there, and intersecting a class with a redeclaration of
   its own private members resolves those members to `never` — so `h._drawables`
   stops type-checking under `strict`. The stand-in is described by its own shape;
   `dispose` below takes `unknown` anyway, so nothing needed the class type. */
type FakeAxes = {
  chrome: { dispose: ReturnType<typeof vi.fn> }
  colorbarOverlay: { dispose: ReturnType<typeof vi.fn> }
  _drawables: Drawable[]
}

function host(drawables: Drawable[]): FakeAxes {
  return {
    chrome: { dispose: vi.fn() },
    colorbarOverlay: { dispose: vi.fn() },
    _drawables: drawables,
    _children: [],
    parent: null,
  } as unknown as FakeAxes
}

const dispose = (h: unknown): void => (Axes.prototype.dispose as (this: unknown) => void).call(h)

describe('Axes.dispose', () => {
  it('disposes every drawable it still holds, then clears the list', () => {
    const a = fakeDrawable(), b = fakeDrawable()
    const h = host([a, b])

    dispose(h)

    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(b.dispose).toHaveBeenCalledTimes(1)
    expect(h._drawables).toEqual([])
    expect(h.chrome.dispose).toHaveBeenCalledTimes(1)
    expect(h.colorbarOverlay.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes an axes holding no drawables without throwing', () => {
    const h = host([])
    expect(() => dispose(h)).not.toThrow()
    expect(h._drawables).toEqual([])
  })
})
