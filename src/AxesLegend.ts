import { colormapSampleCPU, colormapRow } from './colormap-node'
import { readCssPx } from './css'

/**
 * AxesLegend — the boxed key in an axes corner: one ENTRY per layer that encodes
 * something by COLOUR.
 *
 *     ┌──────────────────────┐
 *     │ ∇·J                  │   the surface's colour scale
 *     │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  │
 *     │ -1.8e3        1.4e3  │
 *     └──────────────────────┘
 *
 * Every entry draws into the same footprint (`--threecharts-ramp-*`), so
 * entries line up as one table rather than a pile.
 *
 * It briefly also stated a QUIVER's length mapping — a reference arrow with the
 * magnitude it stood for. That is gone: the arrow-length SLIDER says the same thing
 * in the same units and is a control rather than a caption, so the legend was a
 * second, read-only copy of a number the toolbar already showed — and one that had
 * to invert the drawable's length law to stay true, which it silently failed to do
 * when the law changed.
 */

/**
 * THE RAMP BOX — every legend entry's colour ramp, and the width its label rows take.
 *
 * `--threecharts-ramp-{len,thick}`, which the SCALE BAR reads too: the ramp's length is
 * the bar's target length, so the two overlays at opposite corners of the scene are
 * the same width and read as one system.
 *
 * The height used to be 26px, and it was an arrow's: the box was sized for the tallest
 * glyph the legend drew, a full-width arrow being `2 · headHalf · w = 0.36w` across its
 * head. That vector entry was removed when the quiver legend went, so the ramp had been
 * wearing a deleted glyph's proportions ever since.
 */
function glyphBox(): { w: number; h: number } {
  return {
    w: readCssPx('--threecharts-ramp-len', 90),
    h: readCssPx('--threecharts-ramp-thick', 16),
  }
}



/** Short numeric label for a ramp end. */
function fmtEnd(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e4 || a < 1e-2)) return v.toExponential(1)
  return String(Math.round(v * 100) / 100)
}

/** CSS `linear-gradient` for a colormap (16 CPU-sampled stops, low→right). */
function gradientCss(idx: number): string {
  const stops: string[] = []
  for (let i = 0; i < 16; i++) {
    const t = i / 15
    const [r, g, b] = colormapSampleCPU('default', t, idx)
    stops.push(`rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}

/** One layer's colour mapping, as the legend needs to state it. */
export interface LegendEntry {
  /**
   * Suppress this entry's colour ramp because an earlier entry already shows the
   * SAME mapping. Set by `dedupeRamps`, never by a caller — a legend that draws one
   * colour scale twice is asserting there are two, and the reader has to compare
   * their ends to find out there are not.
   */
  rampShown?: boolean
  /** Which layer this is, e.g. `'∇·J'`. */
  title: string
  /** The quantity's unit, shown ONCE per entry so its numbers stay bare. */
  unit: string
  clim: readonly [number, number]
  colormap: string
}

/**
 * Hide the ramp on any entry whose (colormap, clim) a PRECEDING entry already
 * states. Two layers routinely share one colour mapping — the cortex coloured by
 * ‖J‖ beside the current glyphs coloured by ‖J‖ is the normal case, not an edge
 * one — and drawing that scale twice is the panel claiming two mappings exist.
 *
 * The entry itself stays: its TITLE says which layer.
 */
export function dedupeRamps(entries: LegendEntry[]): LegendEntry[] {
  const seen = new Set<string>()
  return entries.map((e) => {
    const key = `${e.colormap}|${e.clim[0]}|${e.clim[1]}`
    const first = !seen.has(key)
    seen.add(key)
    return { ...e, rampShown: first }
  })
}

/** One entry's DOM. Kept as an object so a structural change rebuilds only when the
 *  shape moved, and a value change touches text nodes only. */
interface EntryView {
  titleEl: HTMLSpanElement
  unitEl: HTMLSpanElement
  ramp: HTMLDivElement
  lowEl: HTMLSpanElement
  highEl: HTMLSpanElement
  last: { title: string; unit: string; cmap: string; ends: string }
}

export class AxesLegend {
  private readonly root: HTMLDivElement
  private views: EntryView[] = []
  /** The entry SHAPE the current DOM was built for — the kinds, in order. */
  private shape = ''

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'threecharts-legend'
    this.root.style.cssText =
      'position:absolute;pointer-events:none;user-select:none;z-index:2;' +
      /* 12px between ENTRIES (was 6): two stacked colorbars — the surface's and
         the glyphs' — read as one block at the tighter gap (Diellor, 2026-08-14);
         the intra-entry rows keep their own tighter --threecharts-legend-gap. */
      'display:flex;flex-direction:column;gap:var(--nxr-space-6);' +
      'padding:var(--threecharts-legend-pad);' +
      // NO BORDER. The panel floats over the scene, and an outline around it drew a
      // second rectangle competing with the ramp's own edge; the translucent fill is
      // enough to lift the text off the cortex.
      'border-radius:var(--nxr-corner-small);' +
      'background:color-mix(in srgb, var(--nxr-surface-container-lowest) 62%, transparent);' +
      'font-family:var(--nxr-font-mono);font-size:var(--threecharts-legend-text);line-height:1;' +
      'color:var(--threecharts-label);font-variant-numeric:tabular-nums;'
    container.appendChild(this.root)
  }

  private build(entries: LegendEntry[]): void {
    const { w, h } = glyphBox()
    this.root.replaceChildren()
    this.views = entries.map((e) => {
      const box = document.createElement('div')
      box.style.cssText = 'display:flex;flex-direction:column;gap:var(--threecharts-legend-gap);'

      /**
       * A label row the width of the ramp. Two justifications, and the difference is
       * what each row MEANS:
       *
       *   `center`  the TITLE — a caption for the whole ramp, like the scale bar's
       *             "5 cm" over its rule. Both overlays now name their bar the same way.
       *   `between` the ENDS — `0` and `1.28` are positional, each sitting over the end
       *             of the ramp it labels, so they cannot move to the middle.
       */
      const row = (justify: 'center' | 'space-between'): HTMLDivElement => {
        const d = document.createElement('div')
        d.style.cssText =
          `display:flex;justify-content:${justify};align-items:baseline;width:${w}px;` +
          'gap:var(--nxr-space-4);'
        box.appendChild(d)
        return d
      }

      const head = row('center')
      const titleEl = document.createElement('span')
      const unitEl = document.createElement('span')
      unitEl.style.color = 'var(--threecharts-label-muted)'
      // Hidden until a unit ARRIVES. The memo below only fires on a CHANGE, and a
      // legend built empty then updated with `unit: ''` never changes — so hiding here
      // is what makes the unitless case (every entry today) actually centre.
      unitEl.style.display = 'none'
      head.appendChild(titleEl); head.appendChild(unitEl)

      const ramp = document.createElement('div')
      const lowEl = document.createElement('span')
      const highEl = document.createElement('span')
      if (e.rampShown !== false) {
        ramp.style.cssText =
          `width:${w}px;height:${h}px;flex:0 0 auto;box-sizing:border-box;` +
          'border-radius:var(--nxr-corner-extra-small);' +
          'border:1px solid color-mix(in srgb, var(--nxr-outline-variant) 70%, transparent);'
        box.appendChild(ramp)
        const ends = row('space-between')
        ends.appendChild(lowEl); ends.appendChild(highEl)
      }


      this.root.appendChild(box)
      return {
        titleEl, unitEl, ramp, lowEl, highEl,
        last: { title: '', unit: '', cmap: '', ends: '' },
      }
    })
  }

  /**
   * Recompute from the current ortho framing and each layer's live mapping.
   *
   * @param radius  the framed cube's half-diagonal (world units)
   * @param zoom    the orbit zoom (frustum half-height = radius/zoom)
   * @param vp      the AXES viewport rect in container CSS px
   * @param entries one per layer that encodes something, in display order
   */
  update(
    radius: number, zoom: number,
    vp: { left: number; top: number; w: number; h: number },
    entries: LegendEntry[],
  ): void {
    if (!entries.length) { this.setVisible(false); return }
    this.setVisible(true)
    if (!(radius > 0) || !(zoom > 0) || !(vp.h > 0)) return

    // Rebuild the DOM only when the SHAPE changes — a layer appearing, or one
    // a ramp appearing or being suppressed. A value change must not reflow.
    const shape = entries.map((e) => (e.rampShown === false ? 'noramp' : 'ramp')).join(',')
    if (shape !== this.shape) { this.shape = shape; this.build(entries) }

    // Pin to the viewport's BOTTOM-RIGHT. Anchoring by right/bottom rather than
    // left/top means the box never has to measure itself, so its size can change
    // with the entries without a reflow-and-reposition round trip.
    const parent = this.root.parentElement
    const pw = parent?.clientWidth ?? vp.left + vp.w
    const ph = parent?.clientHeight ?? vp.top + vp.h
    const inset = 'var(--threecharts-legend-inset)'
    this.root.style.right = `calc(${Math.max(0, pw - (vp.left + vp.w))}px + ${inset})`
    this.root.style.bottom = `calc(${Math.max(0, ph - (vp.top + vp.h))}px + ${inset})`


    entries.forEach((e, i) => {
      const v = this.views[i]
      if (!v) return
      if (e.title !== v.last.title) { v.titleEl.textContent = e.title; v.last.title = e.title }
      if (e.unit !== v.last.unit) {
        v.unitEl.textContent = e.unit
        // DISPLAY:NONE, not an empty span: an empty flex item still takes the row's
        // gap, which pushed a unitless title half a gap left of the ramp's centre —
        // 4 px, enough to read as "not centred" beside a scale bar that is.
        v.unitEl.style.display = e.unit ? '' : 'none'
        v.last.unit = e.unit
      }
      if (e.colormap !== v.last.cmap) {
        v.last.cmap = e.colormap
        v.ramp.style.background = gradientCss(colormapRow(e.colormap))
      }
      const ends = `${e.clim[0]}|${e.clim[1]}`
      if (ends !== v.last.ends) {
        v.last.ends = ends
        v.lowEl.textContent = fmtEnd(e.clim[0])
        v.highEl.textContent = fmtEnd(e.clim[1])
      }
    })
  }

  setVisible(v: boolean): void { this.root.style.display = v ? '' : 'none' }
  dispose(): void { this.root.remove() }
}

