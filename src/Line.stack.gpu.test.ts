import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ChartSession, createFigure } from './index'
import { assertWebGPU, hasWebGPU } from './testing/gpu'

/**
 * `channelSpacing` puts channel `c` at baseline `c·spacing`, which is how a
 * multi-channel recording — or a ridgeline — is drawn. The extent that implies was
 * not reported, so a caller stacking 28 channels had to pass a matching `yExtent`
 * by hand and the axes framed a single trace's worth of space.
 */
describe('Line — the channel stack and its extent', () => {
  let session: ChartSession
  let container: HTMLElement

  beforeAll(async () => {
    expect(await hasWebGPU()).toBe(true)
    session = new ChartSession()
    await session.init()
    assertWebGPU(session.renderer)
    container = document.createElement('div')
    Object.assign(container.style, { width: '200px', height: '200px' })
    document.body.appendChild(container)
  })
  afterAll(() => { session?.dispose(); container?.remove() })

  const build = async (channelSpacing: number) => {
    const fig = await createFigure({ container, session })
    const ax = fig.axes()
    const C = 8, S = 32
    const line = ax.line(new Float32Array(C * S), C, S, {
      channelSpacing, yExtent: [0, 1], xExtent: [0, 1],
    })
    return { fig, ax, line, C }
  }

  it('reports the whole stack, not one trace', async () => {
    const { fig, line, C } = await build(3)
    // 8 channels at spacing 3 → baselines 0..21, each trace occupying [0, 1].
    expect(line.dataBounds().ylim).toEqual([0, 1 + (C - 1) * 3])
    fig.dispose()
  })

  it('reports a single trace when unstacked', async () => {
    const { fig, line } = await build(0)
    expect(line.dataBounds().ylim).toEqual([0, 1])
    fig.dispose()
  })

  /**
   * The part that matters, and the reason this reads a uniform rather than a
   * constructed constant: `spacing` exists so a host can ANIMATE between butterfly
   * (0, all overlaid) and stacked. An extent fixed at construction stops matching
   * the moment that animation starts — the one situation the uniform is for.
   */
  it('follows the live uniform, so an animated stack stays framed', async () => {
    const { fig, ax, line, C } = await build(0)
    expect(line.dataBounds().ylim).toEqual([0, 1])

    line.spacing.value = 2                       // mid-animation, no rebuild
    expect(line.dataBounds().ylim).toEqual([0, 1 + (C - 1) * 2])

    // And the axes picks it up on its next frame, without the caller re-stating it.
    ax.syncFrame()
    expect(ax.ylim).toEqual([0, 1 + (C - 1) * 2])
    fig.dispose()
  })
})
