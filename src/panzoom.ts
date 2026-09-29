import type { Axes } from './Axes'
import type { Limits } from './limits'

/**
 * Clamp a proposed view to a hard extent it may never leave.
 *
 * TWO RULES IN ONE FUNCTION, and they are the same rule seen twice: the view may
 * never be WIDER than the bound (there is nothing out there to show), and it may
 * never sit OUTSIDE it (same reason). A view wider than its bound snaps to the
 * bound exactly, which is what makes "zoomed all the way out" a definite state
 * rather than an arbitrary amount of background.
 *
 * The proposed window's MIDPOINT is preserved where it can be, so a wheel tick
 * that would overshoot still moves toward where the reader pointed instead of
 * jumping. Pure, and tested — the arithmetic is easy to get subtly wrong in a
 * way that only shows as a view that can creep off the data one tick at a time.
 */
export function clampView([lo, hi]: Limits, [blo, bhi]: Limits): Limits {
  const bSpan = bhi - blo
  if (!(bSpan > 0)) return [blo, bhi]
  const span = Math.min(hi - lo, bSpan)
  if (!(span > 0)) return [blo, bhi]
  const mid = (lo + hi) / 2
  let a = mid - span / 2
  if (a < blo) a = blo
  if (a + span > bhi) a = bhi - span
  return [a, a + span]
}

/**
 * Attach pan/zoom to an axes on `el` (the canvas). **Mutates the axes limits**
 * (Decision 4): drag pans, wheel zooms about the cursor, double-click resets to
 * `auto`. Pan/zoom set `xLimMode`/`yLimMode = 'manual'`; reset restores `'auto'`.
 * Returns a cleanup that removes the listeners.
 *
 * `opts.canPan` gates the DRAG-pan (the "pan tool" toggle) — when it returns
 * false, dragging does nothing; wheel-zoom and double-click reset stay active.
 * Defaults to always-on.
 *
 * `opts.zoomAxes` gates the WHEEL per axis — the "which axes respond" toggles a
 * chart toolbar offers. Read through a callback rather than captured, so a host
 * that flips a toggle does not have to re-attach. With one axis off, the wheel
 * scales the other and leaves this one where it is, which is what makes a
 * frequency axis usable while the power axis stays put.
 *
 * `opts.bounds` is the hard extent the view may never leave — for data with a
 * real edge, where outside is not empty space but NOTHING. An MRI slice is the
 * case: zooming out past the image puts the head in a field of background, and
 * panning off it loses the image entirely, neither of which is a view of
 * anything. Omit it and pan/zoom stay unbounded, which is right for a plot whose
 * axes are a coordinate system rather than a picture. Read through a callback so
 * a host whose extent changes (a new volume) never has to re-attach.
 */
export function attachPanZoom(
  axes: Axes,
  el: HTMLElement,
  opts: {
    canPan?: () => boolean
    zoomAxes?: () => { x: boolean; y: boolean }
    bounds?: () => { x?: Limits | null; y?: Limits | null } | null
  } = {},
): () => void {
  const canPan = opts.canPan ?? (() => true)
  const zoomAxes = opts.zoomAxes ?? (() => ({ x: true, y: true }))
  /* Applied on EVERY write, not only on the wheel: a pan is just as capable of
     walking the view off the data, one drag at a time. */
  const bound = (which: 'x' | 'y', v: Limits): Limits => {
    const b = opts.bounds?.()?.[which]
    return b ? clampView(v, b) : v
  }
  let dragging = false
  let lastX = 0, lastY = 0

  const cursorData = (clientX: number, clientY: number): [number, number] => {
    const rect = el.getBoundingClientRect()
    const vp = axes.viewportPx()
    return axes.screenToData(clientX - rect.left - vp.left, clientY - rect.top - vp.top)
  }

  const onDown = (e: PointerEvent): void => {
    if (!canPan()) return                      // pan tool off → no drag-pan
    dragging = true; lastX = e.clientX; lastY = e.clientY
    try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return
    const { xlim, ylim } = axes.dataLimits()
    /* THROUGH THE AXES' OWN MAPPING, not span/viewport-px. The two agree only
       when the data box IS the viewport — it never is (the rulers take fixed px
       off every side) and under `dataAspect` it is not even proportional, so the
       naive ratio drags the content at the wrong rate and the picture slips out
       from under the pointer. `screenToData` is what the click handlers and the
       crosshair already use, so the drag now moves the data by exactly the
       amount the pointer moved over it. */
    const [x0, y0] = cursorData(lastX, lastY)
    const [x1, y1] = cursorData(e.clientX, e.clientY)
    const dxData = x1 - x0
    const dyData = y1 - y0
    // content follows cursor
    axes.xlim = bound('x', [xlim[0] - dxData, xlim[1] - dxData])
    axes.ylim = bound('y', [ylim[0] - dyData, ylim[1] - dyData])
    lastX = e.clientX; lastY = e.clientY
  }
  const onUp = (e: PointerEvent): void => {
    dragging = false
    try { el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const onWheel = (e: WheelEvent): void => {
    const { x: zx, y: zy } = zoomAxes()
    if (!zx && !zy) return                     // both off → let the page scroll
    e.preventDefault()
    const [cx, cy] = cursorData(e.clientX, e.clientY)
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1
    const { xlim, ylim } = axes.dataLimits()
    if (zx) axes.xlim = bound('x', [cx + (xlim[0] - cx) * factor, cx + (xlim[1] - cx) * factor])
    if (zy) axes.ylim = bound('y', [cy + (ylim[0] - cy) * factor, cy + (ylim[1] - cy) * factor])
  }
  const onDbl = (): void => { axes.xLimMode = 'auto'; axes.yLimMode = 'auto' }

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
