import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { attributeArray } from 'three/tsl'
import { assertWebGPU, hasWebGPU } from '../testing/gpu'
import { ChartSession } from '../ChartSession'
import { createFigure } from '../Figure'
import { gridDomain } from './gridDomain'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('Image on a grid domain', () => {
  let session: ChartSession
  let container: HTMLElement

  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    session = new ChartSession()
    await session.init()
    assertWebGPU(session.renderer)
    container = document.createElement('div')
    Object.assign(container.style, { width: '400px', height: '300px' })
    document.body.appendChild(container)
  })
  afterAll(() => { session?.dispose(); container?.remove() })

  const fig = async () => {
    const f = await createFigure({ container, session })
    return { f, ax: f.axes() }
  }

  it('takes shape in DATA order and builds the lattice from it', async () => {
    const { f, ax } = await fig()
    const buf = attributeArray(new Float32Array(4 * 3), 'float')
    // 4 rows of 3 — the array's own order.
    const img = ax.image(buf, { shape: [4, 3], xExtent: [0, 6], yExtent: [-1, 1] })

    /* The LATTICE is fastest-axis-first, so it reads [cols, rows]. Both orders are
       correct for different things, and keeping them in separate, named forms is
       what stops a caller having to know which one a bare pair means. */
    expect((img.domain as any).shape).toEqual([3, 4])
    // The domain answers, so a 2-D lattice's degenerate z comes with it.
    expect(img.dataBounds()).toEqual({ xlim: [0, 6], ylim: [-1, 1], zlim: [0, 0] })
    f.dispose()
  })

  it('defaults the extent to the cell count, as it always did', async () => {
    const { f, ax } = await fig()
    const buf = attributeArray(new Float32Array(4 * 3), 'float')
    expect(ax.image(buf, { shape: [4, 3] }).dataBounds())
      .toEqual({ xlim: [0, 3], ylim: [0, 4], zlim: [0, 0] })
    f.dispose()
  })

  /**
   * The reason the domain form exists. An image and the glyphs drawn over it used
   * to declare their extents SEPARATELY — two lattices that agreed only because
   * someone typed the same four numbers twice, and drifted the moment one changed.
   */
  it('shares one lattice with a quiver drawn over it', async () => {
    const { f, ax } = await fig()
    const grid = gridDomain({ nx: 3, ny: 4, x: [0, 6], y: [-1, 1] })
    const values = attributeArray(new Float32Array(4 * 3), 'float')
    const vectors = attributeArray(new Float32Array(grid.count * 3), 'vec3')

    const img = ax.image(values, grid)
    const q = ax.quiver(vectors, grid.count, 1, { dims: 3, domain: grid })

    expect(img.domain).toBe(grid)
    expect(q.domain).toBe(grid)
    expect(q.dataBounds()!.xlim).toEqual(img.dataBounds().xlim)
    f.dispose()
  })

  /**
   * The reversal this replaced.
   *
   * `Volume`'s documented layout is `[frames × D × H × W]` and its shader indexes
   * `iz·(H·W) + iy·W + ix` — but the positional constructor took `(W, H, D)`, the
   * REVERSE. A caller holding a `[D][H][W]` array had to hand the three numbers
   * over backwards, and nothing at the call site said so. `shape` is now the data's
   * own order, and the distinct extents below prove it is not silently transposed.
   */
  it('takes a volume shape as [depth, height, width], not reversed', async () => {
    const { f, ax } = await fig()
    const D = 2, H = 3, W = 4
    const buf = attributeArray(new Float32Array(D * H * W), 'float')
    const vol = ax.volume(buf, {
      shape: [D, H, W],
      xExtent: [0, 40], yExtent: [0, 30], zExtent: [0, 20],
    })
    // x spans WIDTH, y spans HEIGHT, z spans DEPTH — each with its own extent, so a
    // transposition anywhere would show up as the wrong number here.
    expect(vol.dataBounds()).toEqual({ xlim: [0, 40], ylim: [0, 30], zlim: [0, 20] })
    // And the lattice counts follow: nx = W, ny = H, nz = D.
    expect(vol.domain.shape).toEqual([W, H, D])
    f.dispose()
  })
})
