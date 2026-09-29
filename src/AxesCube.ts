import { Vector3 } from 'three/webgpu'
import type { Axes } from './Axes'
import { cubeCenterRadius } from './camera3d'
import { ScaleBar } from './ScaleBar'
import { AxesLegend, dedupeRamps } from './AxesLegend'

const SVGNS = 'http://www.w3.org/2000/svg'
const EDGE = '#3a4150'       // box wireframe
const TITLE = '#e6e8ec'

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

/** The 8 cube corners, indexed by (xi,yi,zi) bits → [x,y,z] picking lo/hi. */
const CORNERS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
]
/** The 12 box edges, as corner-index pairs. */
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],   // bottom face (z=lo)
  [4, 5], [5, 6], [6, 7], [7, 4],   // top face (z=hi)
  [0, 4], [1, 5], [2, 6], [3, 7],   // verticals
]

/**
 * AxesCube — the 3D chrome (the `projection:'3d'` counterpart of AxesOverlay).
 *
 * Deliberately MINIMAL: numeric ticks and axis labels were removed, because on data whose
 * absolute coordinates are arbitrary (a cortex, a fiber bundle) they answer a question
 * nobody asks while cluttering the view. What remains is what actually informs:
 *   • an adaptive physical SCALE BAR (on by default) — answers "how big is this?"
 *   • an optional bare bounding BOX (`axes.box`, OFF by default in 3D) — a spatial
 *     reference frame for orbit, drawn by projecting the 8 corners each frame.
 *   • the per-axes title.
 */
export class AxesCube {
  private svg: SVGSVGElement
  private readonly bar: ScaleBar
  private readonly legend: AxesLegend
  private readonly _v = new Vector3()

  constructor(container: HTMLElement) {
    // overflow:hidden — clip the projected cube to the canvas so a zoomed-in box can't
    // spill out over the surrounding toolbars/transport (the GPU-rendered primitives are
    // already viewport-clipped; this matches them).
    this.svg = el('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden;' })
    container.appendChild(this.svg)
    this.bar = new ScaleBar(container)
    this.legend = new AxesLegend(container)
  }

  /** World (x,y,z) → container px (through the axes camera). */
  private project(axes: Axes, x: number, y: number, z: number): [number, number] {
    const v = this._v.set(x, y, z).project(axes.camera)   // → NDC [-1,1]
    const vp = axes.viewportPx()
    return [vp.left + (v.x * 0.5 + 0.5) * vp.w, vp.top + (1 - (v.y * 0.5 + 0.5)) * vp.h]
  }

  redraw(axes: Axes): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild)
    const [x0, x1] = axes.xlim, [y0, y1] = axes.ylim, [z0, z1] = axes.zlim

    // ── bare bounding box (12 edges) — opt-in ──
    if (axes.box) {
      const px = CORNERS.map(([xi, yi, zi]) => this.project(axes, xi ? x1 : x0, yi ? y1 : y0, zi ? z1 : z0))
      for (const [a, b] of EDGES) {
        this.svg.appendChild(el('line', { x1: px[a][0], y1: px[a][1], x2: px[b][0], y2: px[b][1], stroke: EDGE, 'stroke-width': 1 }))
      }
    }

    // ── adaptive physical scale bar ──
    this.bar.setVisible(axes.scaleBar)
    if (axes.scaleBar) {
      const { radius } = cubeCenterRadius(axes.xlim, axes.ylim, axes.zlim)
      this.bar.update(radius, axes.orbit.zoom, axes.viewportPx(), axes.scaleBarUnit,
        undefined, axes.scaleBarUnitMode)
    }

    // ── the LEGEND: every layer's mapping, in one box ──
    // Built from the drawables' LIVE state each frame, so switching the surface's
    // scalar or rescaling the glyphs relabels it rather than leaving a key that lies.
    {
      const entries = dedupeRamps(axes.legendEntries())
      if (entries.length) {
        const { radius } = cubeCenterRadius(axes.xlim, axes.ylim, axes.zlim)
        this.legend.update(radius, axes.orbit.zoom, axes.viewportPx(), entries)
      } else {
        this.legend.setVisible(false)
      }
    }

    // ── per-subplot title (top-center of the viewport) ──
    if (axes.titleVisible && axes.title) {
      const vp = axes.viewportPx()
      const t = el('text', { x: vp.left + vp.w / 2, y: vp.top + 16, fill: TITLE, 'font-size': 14, 'font-weight': 700, 'font-family': 'Instrument Sans, sans-serif', 'text-anchor': 'middle' })
      t.textContent = axes.title; this.svg.appendChild(t)
    }
  }

  dispose(): void { this.bar.dispose(); this.legend.dispose(); this.svg.remove() }
}
