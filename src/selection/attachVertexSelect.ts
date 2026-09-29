/**
 * attachVertexSelect — click the surface to select vertices.
 *
 *     const detach = attachVertexSelect(surface, canvas, { onChange })
 *
 * An `attach*` returning a `detach`, the shape `attachOrbit` and `attachPanZoom`
 * already use, because a viewing/interaction BEHAVIOUR is what is being copied
 * between call sites — not a new thing to draw. It owns three pieces and no state of
 * its own beyond them: an `ActiveSelection` (the model), a `VertexMarkers` drawable
 * (the spheres), and the surface's own selection tint (the wash).
 *
 * MODIFIERS follow the mask's compose ops: shift adds, alt subtracts, shift+alt
 * intersects, and a plain click replaces. That mapping lives here rather than in the
 * mask because it is a UI convention, and a host on a different platform may want a
 * different one.
 *
 * Hover is a POINTER-MOVE raycast against the cortex, which is the one thing here
 * that runs at frame rate. It is guarded two ways: the picker is garbage-free by
 * construction, and a move that resolves to the same vertex does no work at all.
 *
 * NO COMPUTE. Everything is the geometry the surface already holds — which is what
 * makes this slice independent of the eigenbasis work that region growing needs.
 */

import type { Surface } from '../Surface'
import type { Axes } from '../Axes'
import { VertexMarkers, type VertexMarkerSpec } from '../VertexMarkers'
import { ActiveSelection, type SelectionSummary } from './ActiveSelection'
import { createVertexPicker } from './vertexPicker'
import { maskFromVertices, verticesFromMask, type ComposeOp } from './selectionMask'

export interface VertexSelectOptions {
  /** Fired whenever the selection changes. The heavy per-vertex mask is NOT in here —
   *  read it from the returned handle when you actually need it. */
  onChange?: (summary: SelectionSummary) => void
  /** `single` keeps one vertex and ignores modifiers; `multi` composes. Default
   *  `multi`. */
  mode?: 'single' | 'multi'
  /** Marker sphere radius as a fraction of the mesh radius. Default 0.012. */
  markerScale?: number
  /** How many markers can be drawn. Default 64 — this slice is click-selection, and
   *  the region tools that produce thousands will pass their own. */
  markerCapacity?: number
  /** Tint the surface where selected. Default true. */
  tint?: boolean
  /** Highlight the vertex under the pointer. Default true. */
  hover?: boolean
  /**
   * Grow a soft `0..1` mask around a seed — the brush.
   *
   * A PROVIDER rather than something this package computes, because growing a region
   * across a surface is a question about the subject's geometry, and `threecharts`
   * knows a buffer and a clim and never a cortex. The host supplies whatever field
   * it has; here that is the Laplace–Beltrami heat kernel, read from the store.
   *
   * `size` is the caller's own unit — this only passes it through. Return null (or
   * omit the option) and a click selects the single vertex under it.
   */
  grow?: (seed: number, size: number) => Float32Array | null
  /** Initial brush size, in whatever unit `grow` reads. Default 0. */
  size?: number
  /** Start in the FOCUSED view — the fill applies to everything except the selection.
   *  Default false. */
  invert?: boolean
}

export interface VertexSelectHandle {
  /** The live model — for a host that wants `commit()`/`clear()`. */
  readonly selection: ActiveSelection
  /**
   * Resize the brush and RE-RUN the live gesture at the new size.
   *
   * This is what the pending slot exists for: the last click is held as a seed plus
   * its parameters, so dragging a size slider re-grows from that seed and replaces
   * the contribution — it never composes onto what is already committed, so shrinking
   * takes vertices back instead of leaving them stuck on.
   */
  setSize(size: number): void
  /**
   * Focused view: apply the surface's selection fill to everything EXCEPT what is
   * selected, so one region is read without the rest of the data competing.
   *
   * Gated on a non-empty selection, and that gate lives here rather than in the
   * drawable: inverting nothing selects everything, so a `Surface` asked to invert an
   * empty mask would correctly blank the entire cortex. Only the tool knows the
   * selection is empty, so only the tool can decline.
   */
  setInvert(on: boolean): void
  /**
   * Re-grow the live gesture from the same seed.
   *
   * For when something the `grow` provider CLOSES OVER changed — a different operator,
   * a reloaded basis — which this cannot see. `setSize` re-runs on its own; anything
   * else the host varies behind the provider has to say so.
   */
  rerun(): void
  /** The previewed mask, freshly composed. */
  read(): Float32Array
  /** The selected vertex ids, ascending. */
  vertices(): number[]
  /** Drop the selection and its chrome. */
  clear(): void
  /** Remove listeners and the marker drawable. */
  detach(): void
}

/** Pointer travel, in px, past which a press-and-release is a DRAG and not a click. */
const DRAG_SLOP = 4

/** Modifier keys → compose op. Shift+alt first: it is the specific case, and testing
 *  shift alone before the pair would swallow it. */
function opFor(e: MouseEvent): ComposeOp {
  if (e.shiftKey && e.altKey) return 'intersect'
  if (e.shiftKey) return 'add'
  if (e.altKey) return 'subtract'
  return 'replace'
}

export function attachVertexSelect(
  surface: Surface,
  el: HTMLElement,
  opts: VertexSelectOptions = {},
): VertexSelectHandle {
  const axes = surface.axes as Axes
  const mesh = surface.mesh
  const geometry = mesh.geometry
  const positions = geometry.attributes.position
  const nV = positions.count
  const single = opts.mode === 'single'
  const wantTint = opts.tint !== false
  const wantHover = opts.hover !== false

  const selection = new ActiveSelection(nV)
  const picker = createVertexPicker(axes, mesh, el)
  const markers = axes.addDrawable(new VertexMarkers(axes, geometry, {
    scale: opts.markerScale,
    capacity: opts.markerCapacity,
  }))

  let hovered: number | null = null
  let size = opts.size ?? 0
  let invert = opts.invert ?? false
  /** The seed and op of the LIVE gesture, so a size change can re-run it. */
  let lastSeed: number | null = null
  let lastOp: ComposeOp = 'replace'
  /** Where the user clicked — what the markers show. */
  let seeds: number[] = []
  /** Where the pointer went down, so a DRAG can be told from a click. The browser
   *  fires `click` after an orbit — press and release land on the same element — so
   *  without this every camera move would also select whatever was under the cursor
   *  when the drag ended. */
  let downX = 0
  let downY = 0
  let moved = false
  /** Hover picking is throttled to one raycast per FRAME. `pointermove` fires more
   *  often than the display refreshes, and this raycast is brute force over every
   *  triangle — 40k on a cortex — so an unthrottled hover pays for picks nobody sees. */
  let hoverRaf = 0
  let pendingX = 0
  let pendingY = 0

  const paint = (): void => {
    const mask = selection.read()
    // Markers mark SEEDS, not membership. A grown region is thousands of vertices and
    // a sphere on each says nothing — the overlay already shows the extent, and what
    // the markers add is where you clicked, which is the part you can move.
    const specs: VertexMarkerSpec[] = seeds.map((v) => ({
      vertexId: v,
      state: v === hovered ? 'hover' : 'rest',
    }))
    // The HOVERED vertex gets one even when it is not a seed — that preview is the
    // only thing telling you what a click would take, on a mesh where the nearest
    // vertex is not always the one under the cursor.
    if (hovered !== null && !seeds.includes(hovered)) {
      specs.push({ vertexId: hovered, role: 'secondary', state: 'hover' })
    }
    markers.set(specs)
    const summary = selection.summary(positions.array as ArrayLike<number>)
    if (wantTint) {
      surface.setSelection(mask)
      surface.setSelectionStyle({ invert: invert && summary.count > 0 })
    }
    opts.onChange?.(summary)
  }

  const onDown = (e: PointerEvent): void => {
    downX = e.clientX
    downY = e.clientY
    moved = false
  }

  /** The contribution one seed makes at the current size: the grown region if a field
   *  is available and asked for, else the seed vertex alone. */
  const contributionFor = (seed: number): Float32Array =>
    (size > 0 ? opts.grow?.(seed, size) : null) ?? maskFromVertices(nV, [seed])

  const runGesture = (seed: number, op: ComposeOp): void => {
    // The seed list follows the compose op, so the markers say the same thing the
    // mask does: `replace` starts over, `subtract` takes one away, the rest add.
    if (op === 'replace') seeds = [seed]
    else if (op === 'subtract') seeds = seeds.filter((v) => v !== seed)
    else if (!seeds.includes(seed)) seeds = [...seeds, seed]
    lastSeed = seed
    lastOp = op
    selection.setPending(
      contributionFor(seed),
      op,
      { tool: size > 0 ? 'brush' : 'pick', params: { vertex: seed, size } },
    )
    paint()
  }

  const onClick = (e: MouseEvent): void => {
    if (moved) return                     // that was an orbit, not a click
    const hit = picker.pick(e.clientX, e.clientY)
    if (!hit) return
    // A vertex hidden by the surface's own mask is still a raycast hit — three knows
    // nothing about the shader — so it has to be rejected here or a click lands on an
    // invisible hemisphere.
    if (surface.maskedOut(hit.vertexId)) return
    runGesture(hit.vertexId, single ? 'replace' : opFor(e))
  }

  const runHover = (): void => {
    hoverRaf = 0
    const hit = picker.pick(pendingX, pendingY)
    const next = hit && !surface.maskedOut(hit.vertexId) ? hit.vertexId : null
    if (next === hovered) return          // the common case, and it must cost nothing
    hovered = next
    paint()
  }

  const onMove = (e: PointerEvent): void => {
    if (!moved && (Math.abs(e.clientX - downX) > DRAG_SLOP || Math.abs(e.clientY - downY) > DRAG_SLOP)) {
      moved = true
    }
    if (!wantHover) return
    pendingX = e.clientX
    pendingY = e.clientY
    if (hoverRaf === 0) hoverRaf = requestAnimationFrame(runHover)
  }

  const onLeave = (): void => {
    if (hovered === null) return
    hovered = null
    paint()
  }

  // `pointerdown` is needed for the drag guard even when hover is off — the guard is
  // about CLICKS, and a click after an orbit happens either way.
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('click', onClick)
  el.addEventListener('pointermove', onMove)
  if (wantHover) el.addEventListener('pointerleave', onLeave)

  return {
    selection,
    setSize: (v: number) => {
      const next = Math.max(0, v)
      if (next === size) return
      size = next
      // Nothing clicked yet — the new size applies to the next click, and there is no
      // gesture to re-run.
      if (lastSeed === null) return
      runGesture(lastSeed, lastOp)
    },
    rerun: () => { if (lastSeed !== null) runGesture(lastSeed, lastOp) },
    setInvert: (on: boolean) => { invert = on; paint() },
    read: () => selection.read(),
    vertices: () => verticesFromMask(selection.read()),
    clear: () => { lastSeed = null; seeds = []; selection.clear(); paint() },
    detach: () => {
      if (hoverRaf !== 0) cancelAnimationFrame(hoverRaf)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('click', onClick)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      picker.dispose()
      axes.removeDrawable(markers)
      // Both, and in this order: a surface left inverted with an empty mask is a blank
      // cortex, which is what detaching mid-focus would otherwise leave behind.
      if (wantTint) {
        surface.setSelectionStyle({ invert: false })
        surface.setSelection(null)
      }
    },
  }
}
