import { describe, it, expect } from 'vitest'
import { OrthographicCamera } from 'three/webgpu'
import { frameOrthoToLimits, dataToScreen, screenToData } from './transform'

describe('transform', () => {
  it('frames the ortho camera to the limits (centered, relative frustum)', () => {
    const cam = new OrthographicCamera()
    frameOrthoToLimits(cam, [0, 220], [0, 128])
    // frustum is half-extent relative to the camera centered on the data
    expect(cam.left).toBe(-110); expect(cam.right).toBe(110)
    expect(cam.bottom).toBe(-64); expect(cam.top).toBe(64)
    expect(cam.position.x).toBe(110); expect(cam.position.y).toBe(64)
    expect(cam.up.toArray()).toEqual([0, 1, 0])
  })
  it('maps data→screen (y flips: data-min at the bottom)', () => {
    const vp = { w: 200, h: 100 }
    expect(dataToScreen([0, 10], [0, 5], vp, 0, 0)).toEqual([0, 100])   // bottom-left
    expect(dataToScreen([0, 10], [0, 5], vp, 10, 5)).toEqual([200, 0])  // top-right
    expect(dataToScreen([0, 10], [0, 5], vp, 5, 2.5)).toEqual([100, 50])
  })
  it('screenToData inverts dataToScreen', () => {
    const vp = { w: 200, h: 100 }
    const [x, y] = screenToData([0, 10], [0, 5], vp, 100, 50)
    expect(x).toBeCloseTo(5); expect(y).toBeCloseTo(2.5)
  })
})
