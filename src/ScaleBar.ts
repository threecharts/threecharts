/**
 * ScaleBar — an adaptive PHYSICAL scale bar for a 3D axes, the honest replacement for
 * numeric axis ticks on data whose absolute coordinates carry no meaning (a cortex, a
 * fiber bundle): "how big is this?" is answerable, "what is x=0.043?" is not.
 *
 * The math is ORTHOGRAPHIC, so unlike the perspective bar in `@nxr/charts-webgpu` it is
 * exact at every depth and needs no reference distance: the camera's frustum half-height
 * is `radius/zoom`, which maps to the canvas height in pixels, so
 *
 *     pxPerWorld = canvasHeightPx / (2 · radius / zoom)
 *
 * We then pick the 1-2-5 round length nearest the target pixel width and label it in the
 * most readable SI unit for its magnitude (m / cm / mm / µm) — that's the "adaptive" part.
 */

import { readCssPx } from './css'

/** The nearest 1-2-5 round number at or below `target`'s decade — the classic scale-bar
 *  ladder, so the bar always reads 1/2/5 × a power of ten. */
export function pickScaleValue(target: number): number {
  if (!isFinite(target) || target <= 0) return 1
  const exp = Math.floor(Math.log10(target))
  const base = Math.pow(10, exp)
  const ratio = target / base
  if (ratio < 2) return base
  if (ratio < 5) return base * 2
  return base * 5
}

/** Format a length in DATA units as a physical label. When the data unit is metres the
 *  SI prefix ADAPTS to the magnitude (5 cm rather than 0.05 m); any other unit is shown
 *  as-is. Returns the display string, e.g. `"5 cm"`. */
/**
 * How a metre-valued scale bar picks its SI prefix.
 *
 * `adaptive` follows the magnitude (5 cm rather than 0.05 m), which is right for a
 * chart read on its own. `mm` PINS the unit, which is right when the bar has to be
 * read against another quantity already in millimetres — on the cortex that is the
 * eigenspectrum's spatial wavelengths, and a bar that silently switches cm/mm as you
 * zoom makes the comparison an arithmetic exercise (Diellor, 2026-08-19).
 */
export type ScaleUnitMode = 'adaptive' | 'mm'

export function formatScale(value: number, unit: string, mode: ScaleUnitMode = 'adaptive'): string {
  if (unit === 'm' && mode === 'mm') return `${trimZeros((value * 1e3).toPrecision(3))} mm`
  if (unit !== 'm') {
    const v = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3)
    return unit ? `${trimZeros(v)} ${unit}` : trimZeros(v)
  }
  if (value >= 1000) return `${trimZeros((value / 1000).toPrecision(3))} km`
  if (value >= 1) return `${trimZeros(value.toPrecision(3))} m`
  if (value >= 0.01) return `${trimZeros((value * 100).toPrecision(3))} cm`
  if (value >= 1e-4) return `${trimZeros((value * 1e3).toPrecision(3))} mm`
  return `${trimZeros((value * 1e6).toPrecision(3))} µm`
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/**
 * The DOM overlay: a label over a capped rule, absolutely positioned in the figure
 * container. Pure view — the owner calls `update()` each frame with the current
 * projection state and it no-ops unless something actually changed.
 */
export class ScaleBar {
  private readonly root: HTMLDivElement
  private readonly labelEl: HTMLDivElement
  private readonly barWrap: HTMLDivElement
  private lastPx = -1
  private lastText = ''

  constructor(container: HTMLElement) {
    const stroke = 'var(--nxr-on-surface, #c8c8d8)'
    this.root = document.createElement('div')
    this.root.className = 'threecharts-scalebar'
    this.root.style.cssText =
      'position:absolute;pointer-events:none;user-select:none;z-index:2;' +
      'font-family:var(--nxr-font-mono, IBM Plex Mono, monospace);font-size:10px;line-height:1;'

    this.labelEl = document.createElement('div')
    this.labelEl.style.cssText = `color:${stroke};font-variant-numeric:tabular-nums;margin-bottom:3px;text-align:center;`
    this.root.appendChild(this.labelEl)

    this.barWrap = document.createElement('div')
    this.barWrap.style.cssText = 'position:relative;height:7px;width:0px;'
    const line = document.createElement('div')
    line.style.cssText = `position:absolute;left:0;right:0;bottom:3px;height:1.5px;background:${stroke};`
    this.barWrap.appendChild(line)
    for (const side of ['left', 'right'] as const) {
      const cap = document.createElement('div')
      cap.style.cssText = `position:absolute;bottom:0;${side}:0;width:1.5px;height:7px;background:${stroke};`
      this.barWrap.appendChild(cap)
    }
    this.root.appendChild(this.barWrap)
    container.appendChild(this.root)
  }

  /**
   * Recompute from the current ortho framing.
   * @param radius   the framed cube's half-diagonal (world units)
   * @param zoom     the orbit zoom (frustum half-height = radius/zoom)
   * @param vp       the AXES viewport rect in container CSS px — the bar pins to its
   *                 bottom-left, so it stays correct under subplots
   * @param unit     the DATA unit ('m' adapts the SI prefix; '' = unitless)
   * @param targetPx the pixel length to aim for before 1-2-5 rounding. Defaults to
   *                 `--threecharts-ramp-len`, the SAME token the legend's colour ramp
   *                 takes its width from — so the two overlays are one width, and the
   *                 bar's drawn length is that target rounded down to 1-2-5.
   */
  update(radius: number, zoom: number, vp: { left: number; top: number; w: number; h: number }, unit: string, targetPx = readCssPx('--threecharts-ramp-len', 90), mode: ScaleUnitMode = 'adaptive'): void {
    if (!(radius > 0) || !(zoom > 0) || !(vp.h > 0)) return
    this.root.style.left = `${vp.left + 14}px`
    this.root.style.top = `${vp.top + vp.h - 30}px`
    const pxPerWorld = vp.h / (2 * (radius / zoom))
    const rounded = pickScaleValue(targetPx / pxPerWorld)
    const px = Math.round(rounded * pxPerWorld)
    const text = formatScale(rounded, unit, mode)
    if (px !== this.lastPx) { this.barWrap.style.width = `${px}px`; this.lastPx = px }
    if (text !== this.lastText) { this.labelEl.textContent = text; this.lastText = text }
  }

  setVisible(v: boolean): void { this.root.style.display = v ? '' : 'none' }
  dispose(): void { this.root.remove() }
}
