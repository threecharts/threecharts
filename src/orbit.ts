import type { Axes } from './Axes'

/** Clamp elevation just short of the poles so `up` never becomes ambiguous. */
const EL_LIMIT = 1.5   // ~86°

/**
 * Attach ORBIT interaction to a 3D axes on `el` (the canvas) — the 3D counterpart
 * of `attachPanZoom`. Drag rotates azimuth/elevation about the cube center, wheel
 * zooms the ortho frustum about the center, double-click resets to the default view.
 * **Mutates `axes.orbit`**; the Figure's render loop re-frames the camera from it
 * every frame, so no explicit invalidate is needed. Returns a cleanup.
 *
 * `opts.canOrbit` gates the DRAG (a "rotate tool" toggle) — wheel-zoom and
 * double-click reset stay active. Defaults to always-on.
 */
export function attachOrbit(axes: Axes, el: HTMLElement, opts: {
  canOrbit?: () => boolean
  /** Fired when an interaction SETTLES — pointer-up, a wheel tick, the dblclick
   *  reset — never per pointer-move. The orbit itself is mutated in place on
   *  `axes.orbit`; this is the notification seam a host needs to REFLECT the pose
   *  (a share-link codec, a store mirror) without polling. Callers wanting fewer
   *  wheel events debounce on their side. */
  onChange?: () => void
} = {}): () => void {
  const canOrbit = opts.canOrbit ?? (() => true)
  const changed = (): void => { opts.onChange?.() }
  let dragging = false
  let lastX = 0, lastY = 0

  const onDown = (e: PointerEvent): void => {
    if (!canOrbit()) return
    dragging = true; lastX = e.clientX; lastY = e.clientY
    try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return
    const dx = e.clientX - lastX, dy = e.clientY - lastY
    // Drag right → orbit right (azimuth); drag up → tilt up (elevation). Screen y
    // is down, so a downward drag (dy>0) lowers elevation.
    axes.orbit.az -= dx * 0.01
    axes.orbit.el = Math.max(-EL_LIMIT, Math.min(EL_LIMIT, axes.orbit.el + dy * 0.01))
    lastX = e.clientX; lastY = e.clientY
  }
  const onUp = (e: PointerEvent): void => {
    const was = dragging
    dragging = false
    try { el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (was) changed()
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    axes.orbit.zoom *= e.deltaY > 0 ? 1 / 1.1 : 1.1   // wheel up = zoom in
    axes.orbit.zoom = Math.max(0.05, Math.min(50, axes.orbit.zoom))
    changed()
  }
  const onDbl = (): void => { axes.resetView(); changed() }

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('dblclick', onDbl)

  return () => {
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('dblclick', onDbl)
  }
}
