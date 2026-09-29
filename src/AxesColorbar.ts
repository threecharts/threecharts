import { colormapSampleCPU, colormapRow } from './colormap-node'
import { RIGHT_RULER_RESERVE, type Axes } from './Axes'

/** CSS `linear-gradient` for a colormap (16 CPU-sampled stops, low→top). */
function gradientCss(idx: number): string {
  const n = 16
  const colors: string[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const [r, g, b] = colormapSampleCPU('default', t, idx)
    colors.push(`rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(to top, ${colors.join(', ')})`
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(1)
  return String(Math.round(v * 100) / 100)
}

/**
 * AxesColorbar — a DOM *illustration* (Decision: Illustrations = Colorbar/Legend):
 * a vertical colormap gradient + value ticks, rendered in the axes' reserved right
 * margin and aligned to the data box. Redrawn each frame from the axes colormap +
 * `colorbarClim()`. Screen-fixed DOM (crisp), like `AxesOverlay`; not in the GPU
 * scene. The Axes reserves the right margin (see `Axes.framed`) when `colorbar` is on.
 */
export class AxesColorbar {
  private root: HTMLDivElement
  private bar: HTMLDivElement
  private axisEl: HTMLDivElement
  private _lastCmap = ''

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    // Tokens, not literals: this predates the token contract and carried a raw hex
    // label colour, a raw rgba border and a raw 10 px — none of which follow a theme.
    this.root.style.cssText =
      'position:absolute;display:none;pointer-events:none;gap:var(--nxr-space-2);'
      + 'font-family:var(--nxr-font-mono);font-size:var(--threecharts-legend-text);line-height:1;'
      + 'color:var(--threecharts-label);'
    this.bar = document.createElement('div')
    this.bar.style.cssText =
      'width:var(--nxr-space-6);flex:0 0 auto;border-radius:var(--nxr-corner-extra-small);'
      + 'border:1px solid color-mix(in srgb, var(--nxr-outline-variant) 70%, transparent);'
    this.axisEl = document.createElement('div')
    // 34 px was off the 2 px ladder; the nearest rung that still fits an
    // exponent-formatted tick is 36.
    this.axisEl.style.cssText = 'position:relative;width:var(--nxr-space-18);'
    this.root.appendChild(this.bar)
    this.root.appendChild(this.axisEl)
    container.appendChild(this.root)
  }

  redraw(axes: Axes): void {
    if (!axes.colorbar) { this.root.style.display = 'none'; return }
    this.root.style.display = 'flex'

    const vp = axes.viewportPx()
    const box = axes.plotBoxPx()
    /* OUTBOARD of the right ruler when there is one. `Axes.framed` has already reserved
       both bands (`rightMarginPx`); without this offset the gradient is drawn on top of
       that ruler's tick labels. */
    const rulerPx = axes.yAxisRightVisible ? RIGHT_RULER_RESERVE : 0
    this.root.style.left =
      `calc(${vp.left + box.left + box.w + rulerPx}px + var(--threecharts-legend-inset))`
    this.root.style.top = `${vp.top + box.top}px`
    this.bar.style.height = `${box.h}px`
    this.axisEl.style.height = `${box.h}px`

    if (axes.colormap !== this._lastCmap) {
      this._lastCmap = axes.colormap
      this.bar.style.background = gradientCss(colormapRow(axes.colormap))
    }

    const [lo, hi] = axes.colorbarClim()
    this.axisEl.replaceChildren()
    const ticks = 5
    for (let i = 0; i < ticks; i++) {
      const t = i / (ticks - 1)
      const value = lo + (1 - t) * (hi - lo)   // top of the bar = hi
      const s = document.createElement('span')
      s.textContent = fmt(value)
      s.style.cssText = `position:absolute;left:0;top:${t * 100}%;transform:translateY(-50%);white-space:nowrap;font-variant-numeric:tabular-nums;`
      this.axisEl.appendChild(s)
    }
  }

  dispose(): void { this.root.remove() }
}
