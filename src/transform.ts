import type { OrthographicCamera } from 'three/webgpu'
import type { Limits } from './limits'

/**
 * Frame an orthographic camera so its view spans exactly `xlim × ylim` (in data
 * coordinates). Pass the ALREADY-PADDED limits — this is the axes' `auto`-mode
 * camera (Decision 4). Camera sits above the z=0 plane looking down, up = +Y, so
 * data-min is bottom-left.
 */
export function frameOrthoToLimits(cam: OrthographicCamera, xlim: Limits, ylim: Limits): void {
  const cx = (xlim[0] + xlim[1]) / 2, cy = (ylim[0] + ylim[1]) / 2
  const halfW = (xlim[1] - xlim[0]) / 2, halfH = (ylim[1] - ylim[0]) / 2
  // Frustum is RELATIVE to the (centered) camera — OrthographicCamera left/right
  // are camera-space, so absolute limits + a centered camera would double-offset.
  cam.left = -halfW; cam.right = halfW
  cam.bottom = -halfH; cam.top = halfH
  cam.near = -10; cam.far = 10
  cam.position.set(cx, cy, 5)
  cam.up.set(0, 1, 0)
  cam.lookAt(cx, cy, 0)
  cam.updateProjectionMatrix()
}

/** Data coords → pixels within the axes viewport (origin top-left, y down).
 *  Uses the UNPADDED data limits so ticks land on the data frame. */
export function dataToScreen(xlim: Limits, ylim: Limits, vp: { w: number; h: number }, x: number, y: number): [number, number] {
  const px = ((x - xlim[0]) / (xlim[1] - xlim[0])) * vp.w
  const py = (1 - (y - ylim[0]) / (ylim[1] - ylim[0])) * vp.h
  return [px, py]
}

/** Inverse of {@link dataToScreen}. */
export function screenToData(xlim: Limits, ylim: Limits, vp: { w: number; h: number }, px: number, py: number): [number, number] {
  const x = xlim[0] + (px / vp.w) * (xlim[1] - xlim[0])
  const y = ylim[0] + (1 - py / vp.h) * (ylim[1] - ylim[0])
  return [x, y]
}
