import type { OrthographicCamera } from 'three/webgpu'
import type { Limits } from './limits'

/** The orbit state a 3D axes carries — an azimuth/elevation/zoom the camera reads.
 *  `az`/`el` in radians (el clamped away from the poles by the orbit interaction);
 *  `zoom` scales the ortho frustum (>1 = closer). */
export interface Orbit { az: number; el: number; zoom: number }

/** Which world axis reads as UP on screen (and is the orbit pole). `'y'` = generic
 *  three.js (the default); `'z'` = the neuroimaging convention (Brainstorm SCS, +Z
 *  superior) — the app's `ManifoldViewport` frame. Only the CAMERA changes; the data
 *  is never rotated, so world coordinates stay in their native frame. */
export type UpAxis = 'y' | 'z'

/** A sensible default 3/4 view (looking slightly down, rotated off-axis). */
export const DEFAULT_ORBIT: Orbit = { az: -0.9, el: 0.5, zoom: 1 }

/**
 * How close to the pole a preset view may sit, in radians.
 *
 * `frameOrthoCube` pins `cam.up` to the up AXIS, so an elevation of exactly ±π/2 puts
 * the view direction parallel to it and `lookAt`'s `cross(up, dir)` degenerates — the
 * camera's roll becomes undefined and the picture flips unpredictably between frames.
 * A thousandth of a radian off the pole is visually indistinguishable from straight
 * down and leaves the cross product a well-conditioned direction to normalise.
 *
 * Tighter than the DRAG clamp (`orbit.ts`'s ~86°), deliberately: a drag wants to stop
 * somewhere that still reads as a 3D view, and a named top-down preset wants to be
 * top-down.
 */
export const POLE_LIMIT = Math.PI / 2 - 1e-3

/**
 * The orbit that places the camera along `dir`, looking back at the data.
 *
 * The inverse of the direction `frameOrthoCube` derives, so it is the way to express a
 * view as "put the eye over there" rather than as two angles whose meaning depends on
 * which axis is up. `dir` need not be normalised and its magnitude is ignored.
 *
 * DOMAIN-FREE, and that is the boundary: this knows axes, not anatomy. A caller that
 * means "superior" or "lateral" owns the mapping from that word to a direction — those
 * are facts about a subject's coordinate frame, and one of them (lateral) is not even
 * a fixed direction. See `@nxr/cortical-flow`'s `AnatomyChart`.
 */
export function orbitLookingFrom(
  dir: { x: number; y: number; z: number },
  up: UpAxis = 'y',
  opts: {
    zoom?: number
    /**
     * Azimuth to use instead of the one `dir` implies — the camera's ROLL.
     *
     * Only meaningful for a view along the pole, where `dir` genuinely does not
     * determine it: looking straight down, every azimuth shows the same face and they
     * differ solely in which way the picture is rotated. Without this a top-down
     * request lands on `atan2(0, 0) = 0` — an arbitrary answer that happens to put the
     * negative first axis at the top of the screen.
     */
    azimuth?: number
  } = {},
): Orbit {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1
  const x = dir.x / len, y = dir.y / len, z = dir.z / len
  // Read back exactly what `frameOrthoCube` writes: the pole component gives the
  // elevation, the other two the azimuth — in the order that function pairs them.
  const [pole, a, b] = up === 'z' ? [z, y, x] : [y, z, x]
  const el = Math.asin(Math.max(-1, Math.min(1, pole)))
  return {
    az: opts.azimuth ?? Math.atan2(a, b),
    el: Math.max(-POLE_LIMIT, Math.min(POLE_LIMIT, el)),
    zoom: opts.zoom ?? 1,
  }
}

/** Center + bounding radius of the data cube `[xlim × ylim × zlim]`. The radius is
 *  HALF THE DIAGONAL, so the whole cube fits the frustum at ANY orbit angle. */
export function cubeCenterRadius(xlim: Limits, ylim: Limits, zlim: Limits): { cx: number; cy: number; cz: number; radius: number } {
  const cx = (xlim[0] + xlim[1]) / 2, cy = (ylim[0] + ylim[1]) / 2, cz = (zlim[0] + zlim[1]) / 2
  const dx = xlim[1] - xlim[0], dy = ylim[1] - ylim[0], dz = zlim[1] - zlim[0]
  const radius = 0.5 * Math.hypot(dx, dy, dz) || 0.5
  return { cx, cy, cz, radius }
}

/**
 * Frame an ORTHOGRAPHIC camera to view a data cube from an orbit angle. Ortho (not
 * perspective) keeps data proportions honest — parallel edges stay parallel, a cube
 * reads as a cube. The camera sits on a sphere of radius `dist` around the cube
 * center at (az, el); the frustum half-height is `radius/zoom` (aspect-corrected by
 * the viewport w/h) so the cube fits vertically and scales with the window. `radius`
 * is the cube's half-diagonal, so no corner ever clips regardless of angle.
 */
export function frameOrthoCube(
  cam: OrthographicCamera,
  center: { cx: number; cy: number; cz: number; radius: number },
  orbit: Orbit,
  aspect: number,
  up: UpAxis = 'y',
): void {
  const { cx, cy, cz, radius } = center
  const halfH = radius / orbit.zoom
  const halfW = halfH * aspect
  cam.left = -halfW; cam.right = halfW; cam.bottom = -halfH; cam.top = halfH

  // The orbit POLE is the up axis: elevation is the angle above the plane normal to it.
  // Data is never rotated — only the camera — matching the app's SCS convention.
  const ce = Math.cos(orbit.el), se = Math.sin(orbit.el)
  const dir = up === 'z'
    ? { x: ce * Math.cos(orbit.az), y: ce * Math.sin(orbit.az), z: se }
    : { x: ce * Math.cos(orbit.az), y: se, z: ce * Math.sin(orbit.az) }
  const dist = radius * 4
  cam.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist)
  cam.near = Math.max(0.01, dist - radius * 3)
  cam.far = dist + radius * 3
  if (up === 'z') cam.up.set(0, 0, 1); else cam.up.set(0, 1, 0)
  cam.lookAt(cx, cy, cz)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld()
}
