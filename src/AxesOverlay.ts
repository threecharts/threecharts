import type { Axes } from './Axes'
import type { AxisScale } from './Axis'

const SVGNS = 'http://www.w3.org/2000/svg'
const AXIS = '#c8c8d8'
const GRID = '#242a34'
const LABEL = '#c8c8d8'
const TITLE = '#e6e8ec'

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

/**
 * AxesOverlay — the screen-fixed chrome (Decision 4): a DOM/SVG layer over the
 * figure container that draws the axes frame, grid, tick marks, tick labels, and
 * axis titles by reading `axes.dataToScreen` + the rulers. Not in the GPU scene,
 * so it stays crisp and fixed-size as the data zooms. Redrawn every frame.
 */
export class AxesOverlay {
  private svg: SVGSVGElement

  constructor(container: HTMLElement) {
    this.svg = el('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;' })
    container.appendChild(this.svg)
  }

  redraw(axes: Axes): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild)
    const vp = axes.viewportPx()
    const { xlim, ylim } = axes.dataLimits()
    const abs = (x: number, y: number): [number, number] => {
      const [px, py] = axes.dataToScreen(x, y)
      return [vp.left + px, vp.top + py]
    }
    const xticks = axes.xAxis.tickValues()
    const yticks = axes.yAxis.tickValues()
    const fs = 10 // base tick label px

    // ── grid ──
    if (axes.grid) {
      for (const tx of xticks) { const [x, y0] = abs(tx, ylim[0]); const [, y1] = abs(tx, ylim[1]); this.svg.appendChild(el('line', { x1: x, y1: y0, x2: x, y2: y1, stroke: GRID, 'stroke-width': 1 })) }
      for (const ty of yticks) { const [x0, y] = abs(xlim[0], ty); const [x1] = abs(xlim[1], ty); this.svg.appendChild(el('line', { x1: x0, y1: y, x2: x1, y2: y, stroke: GRID, 'stroke-width': 1 })) }
    }

    // ── frame box (at the data limits) ──
    const [bx0, by1] = abs(xlim[0], ylim[0])   // bottom-left
    const [bx1, by0] = abs(xlim[1], ylim[1])   // top-right
    if (axes.box) {
      this.svg.appendChild(el('rect', { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0, fill: 'none', stroke: AXIS, 'stroke-opacity': 0.5, 'stroke-width': 1 }))
    }

    // ── x ticks (marks) + value labels ──
    for (const tx of xticks) {
      const [x, y] = abs(tx, ylim[0])
      if (axes.xAxis.ticksVisible) this.svg.appendChild(el('line', { x1: x, y1: y, x2: x, y2: y + 5, stroke: AXIS }))
      if (axes.xAxis.tickLabelsVisible) {
        const t = el('text', { x, y: y + 8 + fs, fill: LABEL, 'font-size': fs * axes.xAxis.tickFontSize, 'font-family': 'IBM Plex Mono, monospace', 'text-anchor': 'middle' })
        t.textContent = axes.xAxis.tickFormat?.(tx) ?? fmt(tx, axes.xAxis.scale); this.svg.appendChild(t)
      }
    }
    // ── y ticks (marks) + value labels ──
    for (const ty of yticks) {
      const [x, y] = abs(xlim[0], ty)
      if (axes.yAxis.ticksVisible) this.svg.appendChild(el('line', { x1: x, y1: y, x2: x - 5, y2: y, stroke: AXIS }))
      if (axes.yAxis.tickLabelsVisible) {
        const t = el('text', { x: x - 8, y: y + fs / 3, fill: LABEL, 'font-size': fs * axes.yAxis.tickFontSize, 'font-family': 'IBM Plex Mono, monospace', 'text-anchor': 'end' })
        t.textContent = axes.yAxis.tickFormat?.(ty) ?? fmt(ty, axes.yAxis.scale); this.svg.appendChild(t)
      }
    }

    // ── the RIGHT y ruler (yyaxis right) — the same coordinate, its OWN ticks ──
    //
    // ⚠ The GRID deliberately does not read these. It reads `yAxis.tickValues()` only,
    // and must keep doing so: a per-lane frequency ruler repeats its ticks once per lane,
    // so a grid over them would draw sixty lines across the data.
    if (axes.yAxisRightVisible) {
      for (const ty of axes.yAxisRight.tickValues()) {
        const [x, y] = abs(xlim[1], ty)
        if (axes.yAxisRight.ticksVisible) this.svg.appendChild(el('line', { x1: x, y1: y, x2: x + 5, y2: y, stroke: AXIS }))
        if (axes.yAxisRight.tickLabelsVisible) {
          const t = el('text', { x: x + 8, y: y + fs / 3, fill: LABEL, 'font-size': fs * axes.yAxisRight.tickFontSize, 'font-family': 'IBM Plex Mono, monospace', 'text-anchor': 'start' })
          t.textContent = axes.yAxisRight.tickFormat?.(ty) ?? fmt(ty, axes.yAxisRight.scale); this.svg.appendChild(t)
        }
      }
    }

    // ── axis titles ──
    if (axes.xAxis.labelVisible && axes.xAxis.label) {
      const t = el('text', { x: (bx0 + bx1) / 2, y: by1 + 8 + fs * 2.6, fill: LABEL, 'font-size': fs * 1.2, 'font-family': 'IBM Plex Sans, sans-serif', 'text-anchor': 'middle' })
      t.textContent = capitalize(axes.xAxis.label); this.svg.appendChild(t)
    }
    if (axes.yAxis.labelVisible && axes.yAxis.label) {
      const cx = bx0 - 8 - fs * 2.6, cy = (by0 + by1) / 2
      const t = el('text', { x: cx, y: cy, fill: LABEL, 'font-size': fs * 1.2, 'font-family': 'IBM Plex Sans, sans-serif', 'text-anchor': 'middle', transform: `rotate(-90 ${cx} ${cy})` })
      t.textContent = capitalize(axes.yAxis.label); this.svg.appendChild(t)
    }
    if (axes.yAxisRightVisible && axes.yAxisRight.labelVisible && axes.yAxisRight.label) {
      // ROTATED THE OTHER WAY (+90, not -90): the left title reads bottom-to-top beside
      // its own ruler, and a right-hand title turned the same way reads away from its.
      const cx = bx1 + 8 + fs * 2.6, cy = (by0 + by1) / 2
      const t = el('text', { x: cx, y: cy, fill: LABEL, 'font-size': fs * 1.2, 'font-family': 'IBM Plex Sans, sans-serif', 'text-anchor': 'middle', transform: `rotate(90 ${cx} ${cy})` })
      t.textContent = capitalize(axes.yAxisRight.label); this.svg.appendChild(t)
    }

    // ── playhead cursor (a clock-driven vertical line at a data-x) ──
    if (axes.cursorX) {
      const cx = axes.cursorX()
      if (cx != null && cx >= xlim[0] && cx <= xlim[1]) {
        const [px, py0] = abs(cx, ylim[0])
        const [, py1] = abs(cx, ylim[1])
        this.svg.appendChild(el('line', { x1: px, y1: py0, x2: px, y2: py1, stroke: '#e0796b', 'stroke-width': 1.5 }))
      }
    }

    // ── per-subplot title (top-center, above the frame in the reserved band) ──
    if (axes.titleVisible && axes.title) {
      const t = el('text', { x: (bx0 + bx1) / 2, y: by0 - 10, fill: TITLE, 'font-size': fs * 1.4, 'font-weight': 700, 'font-family': 'Instrument Sans, sans-serif', 'text-anchor': 'middle' })
      t.textContent = axes.title; this.svg.appendChild(t)
    }
  }

  dispose(): void { this.svg.remove() }
}

/** Axis titles render with a capitalized first letter (leaves the rest as-authored,
 *  so units/casing like "pH" or "mV" are preserved beyond the first character). */
function capitalize(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s }

/** A tick label. On a LOG axis the tick position is an exponent, so it is
 *  labelled with the VALUE it stands for (10ᵏ), not with the exponent. */
function fmt(v: number, scale: AxisScale = 'linear'): string {
  if (scale === 'log') {
    const e = Math.round(v)
    if (Math.abs(v - e) < 1e-9) return e === 0 ? '1' : `1e${e}`
    return fmt(Math.pow(10, v))            // a 1-2-5 subdivision → label its value
  }
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e4 || a < 1e-3) return v.toExponential(1)
  return String(Math.round(v * 1000) / 1000)
}
