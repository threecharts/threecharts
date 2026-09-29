import { WebGPURenderer, CanvasTarget, Color, Group, type Scene, type Camera } from 'three/webgpu'
import { GraphicsObject } from './GraphicsObject'
import { Clock } from './Clock'
import { Axes, type AxesOptions } from './Axes'
import { subplotRect } from './grid'
import type { FigureSession } from './ChartSession'
import { REQUIRED_STORAGE_BUFFERS } from './deviceLimits'

/** Px reserved at the top of the canvas for the figure super-title when it's set. */
const FIGURE_TITLE_BAND = 30

/** Scratch for `getClearColor` reads. The API asks for the renderer-internal
 *  `Color4` (not exported from `three/webgpu`); a plain Color satisfies it at
 *  runtime — only the alpha channel goes uncopied, and the capture reads hex. */
const _captureColor = new Color() as Parameters<WebGPURenderer['getClearColor']>[0]

/** The minimal shape `Figure` needs from an `Axes` (Task 5 satisfies it). Kept
 *  as an interface to avoid a Figure↔Axes import cycle. */
export interface AxesLike {
  readonly scene: Scene
  readonly camera: Camera
  /** Normalized rect within the figure ([0..1]) → renderer viewport. */
  readonly position: { left: number; bottom: number; width: number; height: number }
  update(): void
  /** Recompute auto limits + camera just before this axes renders. */
  syncFrame(): void
  /** The axes viewport in the figure container, CSS px (origin top-left). */
  viewportPx(): { left: number; top: number; w: number; h: number }
  /** The plot box (data region) in viewport CSS px — drawables clip to this. */
  plotBoxPx(): { left: number; top: number; w: number; h: number }
  /** Redraw the screen-fixed chrome overlay (ticks/labels). */
  overlayRedraw(): void
  dispose(): void
}

export interface FigureOptions {
  container: HTMLElement
  backgroundColor?: number
  colormap?: string
  pixelRatio?: number
  /** Inject an EXTERNAL, already-initialized renderer (arrangement 1): compute +
   *  storage buffers live outside the Figure but must share ONE device, so the
   *  owner passes its renderer here. The Figure renders from buffers it doesn't
   *  own and won't dispose the renderer. Omit → the Figure creates + owns one. */
  renderer?: WebGPURenderer
  /** Join a ChartSession (multiple-canvas): this Figure renders into its OWN
   *  `<canvas>` via a `CanvasTarget`, sharing the session's renderer + Clock + loop
   *  with sibling Figures. Takes precedence over `renderer`. Omit → single-canvas. */
  session?: FigureSession
}

/**
 * Figure — the root graphics object (= MATLAB figure). Owns the WebGPU renderer,
 * the canvas, the animation loop, the figure-level colormap, and an ordered list
 * of `Axes` (Decision 3: own many, implement one). Each frame it flushes the
 * dirty tree, then renders every axes into its own viewport rect.
 */
export class Figure extends GraphicsObject {
  readonly renderer: WebGPURenderer
  /** The shared temporal source of truth. Figure-owned by default; a session
   *  injects its own so sibling Figures share one clock. */
  readonly clock: Clock
  colormap: string
  /** Figure super-title (MATLAB `sgtitle`) — spans all subplots in a reserved top
   *  band. Empty → no band, no reserved space. */
  title = ''
  /** Toggle the super-title without losing its text; false hides it + reclaims the band. */
  titleVisible = true
  /** Draw the title as an in-canvas band (bare figures = MATLAB sgtitle). A host shell
   *  that shows the title in its own chrome sets this false so it isn't drawn twice. */
  titleInCanvas = true
  private _titleEl: HTMLDivElement | null = null
  private _axes: AxesLike[] = []
  private _w = 0
  private _h = 0
  /** The ratio the figure lives at — capture raises above it and comes back. */
  private _basePixelRatio = 1
  /** This figure's own clear colour — kept so a transparent capture can restore it. */
  private _bg = 0x000000
  /** The renderer's clear colour saved at `setCaptureBackground(true)` — what the
   *  paired `false` restores (theme-follow writers move the clear colour without
   *  touching `_bg`, so the construction-time value can be stale). */
  private _captureBg: number | null = null
  private _lastTime = 0
  private readonly _ownsRenderer: boolean
  private readonly _session: FigureSession | null
  /** This figure's canvas — its own element in session mode, else the renderer's. */
  private readonly _canvas: HTMLCanvasElement
  /** The session-mode output surface (null in single-canvas mode). */
  private readonly _canvasTarget: CanvasTarget | null

  constructor(readonly container: HTMLElement, opts: FigureOptions) {
    super(new Group())
    this.colormap = opts.colormap ?? 'viridis'
    const session = opts.session ?? null
    this._session = session
    this.clock = session ? session.clock : new Clock()
    this._ownsRenderer = !session && !opts.renderer
    /* The CONSTANT, never a literal: this path (no session, no renderer) has to
       ask for the same budget `ChartSession` does, and a second copy of the
       number is how one of them silently keeps asking for a limit the other
       abandoned — which is exactly what happened with the old 10. */
    this.renderer = session?.renderer ?? opts.renderer ?? new WebGPURenderer({
      antialias: true,
      requiredLimits: { maxStorageBuffersPerShaderStage: REQUIRED_STORAGE_BUFFERS } as unknown as Record<string, number>,
    })
    /* THE CLEAR COLOUR IS THE DEVICE'S, NOT THIS FIGURE'S. With a session the
       renderer is SHARED, so this line sets the background for every canvas in
       the window and the last Figure constructed wins. Four spectrum panels
       passed a hardcoded `0x06080a` while the cortex and the traces passed the
       chart surface, so opening one of them repainted the others (2026-07-31).
       If figures ever need different backgrounds, that is a per-target clear,
       not a per-figure one — do not "fix" it by calling this later. */
    this._bg = opts.backgroundColor ?? 0x000000
    this.renderer.setClearColor(this._bg, 1)
    if (!container.style.position) container.style.position = 'relative'
    /* CLIPPING IS PER-GROUP, NOT PER-MATERIAL. This said the opposite — "WebGPU
       applies material.clippingPlanes per-material" — and it is wrong: three's
       `ClippingContext` reads `clippingGroup.clippingPlanes` and never consults a
       material's (verified against three 0.183 source, 2026-08-20). There is no
       `localClippingEnabled` either; a `ClippingGroup` in the scene simply gets a
       context. `Axes` IS one, which is what its own note describes and how the 2D
       clip box works. Nested groups get their own context, so a single drawable
       can be clipped without touching its siblings. */

    if (session) {
      // MULTIPLE-CANVAS: this Figure owns a fresh <canvas> + CanvasTarget; the
      // session's renderer presents to it via setCanvasTarget each frame.
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;'
      container.appendChild(canvas)
      this._canvas = canvas
      this._canvasTarget = new CanvasTarget(canvas)
      this._basePixelRatio = Math.min(opts.pixelRatio ?? window.devicePixelRatio, 2)
      this._canvasTarget.setPixelRatio(this._basePixelRatio)
    } else {
      // SINGLE-CANVAS: the renderer's own domElement is this figure's canvas.
      this._basePixelRatio = Math.min(opts.pixelRatio ?? window.devicePixelRatio, 2)
      this.renderer.setPixelRatio(this._basePixelRatio)
      this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;'
      container.appendChild(this.renderer.domElement)
      this._canvas = this.renderer.domElement
      this._canvasTarget = null
    }
  }

  get canvas(): HTMLCanvasElement { return this._canvas }

  /**
   * Multiply the DEVICE resolution for a capture, and put it back afterwards.
   *
   * The canvas backing store is `CSS size × pixelRatio`, and that ratio is capped at 2
   * on purpose — a live 4× view would quadruple every frame's fill cost for nothing a
   * screen can show. A capture is the one case where the extra pixels are the whole
   * point, so it raises the ratio, draws ONE frame, and is expected to restore.
   *
   * **The caller must compensate anything sized in PIXELS.** Contour lines, marker
   * outlines and any `fwidth`-based width are specified in fragments, so at 4× they come
   * out four times thinner relative to the image — technically higher resolution and
   * visibly worse. `Surface.setPixelScale` is the counterpart for the contours; see
   * `captureAtScale` for the pair used together.
   *
   * Bounded by the device's own texture limit, which is what `captureFrames` already
   * guards its composite against.
   */
  setCaptureScale(k: number): number {
    /*
     * CLAMPED TO WHAT THE DEVICE WILL ALLOCATE. The backing store IS a texture, so a
     * scale that overflows `maxTextureDimension2D` does not degrade — the swapchain
     * texture fails to create and every subsequent pass reports an invalid attachment,
     * which the renderer does not recover from. Reported by Diellor at 4× on a 1067 px
     * pane: 8536 × 2616 against a device limit of 8192.
     *
     * Returned rather than silently applied, so a caller can say what it actually got.
     */
    const ratio = this._basePixelRatio * Math.max(1, this.maxCaptureScale(k))
    if (this._canvasTarget) this._canvasTarget.setPixelRatio(ratio)
    else this.renderer.setPixelRatio(ratio)
    /* Force the backing store to reallocate. `setSize` short-circuits on an unchanged
       LOGICAL size — which is exactly the case here, since only the ratio moved — so
       the cached size has to be invalidated or the buffer stays at the old resolution
       and the capture silently comes out unchanged. */
    this._w = -1
    this._h = -1
    this.renderFrame()
    return ratio / this._basePixelRatio
  }

  /**
   * The largest capture scale that still fits the device's texture limit, at or below
   * the one asked for.
   *
   * Uses the CONTAINER's size rather than the canvas's current backing store, so it
   * answers the same way whatever scale happens to be applied right now — a clamp that
   * depended on the present state would let a second call creep past the limit.
   */
  maxCaptureScale(want: number): number {
    const limit = (this._session as unknown as { maxTextureSize?: number } | null)?.maxTextureSize ?? 8192
    const w = (this.container.clientWidth || 600) * this._basePixelRatio
    const h = (this.container.clientHeight || 400) * this._basePixelRatio
    const fits = Math.max(1, Math.floor(limit / Math.max(1, Math.max(w, h))))
    return Math.max(1, Math.min(want, fits))
  }

  /**
   * Clear to TRANSPARENT for a capture, and put it back afterwards.
   *
   * The canvas has always been able to carry alpha — three's `WebGPURenderer` defaults
   * `alpha: true` and configures the context `alphaMode: 'premultiplied'`. What made a
   * snapshot opaque was the clear ALPHA, hardcoded to 1 here and in `ChartSession`. So
   * this is the same shape as `setCaptureScale`: flip a render setting for one capture,
   * restore it, and let the caller say when.
   *
   * **It is WINDOW-wide, not figure-wide, for the same reason the clear colour is** (see
   * the constructor): with a session the renderer is SHARED, so every canvas clears
   * transparent while this is on. That is invisible in the captured PNG and briefly
   * visible on screen — a few frames of other panels showing the page behind them. It is
   * accepted rather than fixed because the alternative is a per-target clear, which is a
   * much larger change for a transient the user only sees during a deliberate export.
   *
   * **Only what the scene did not draw becomes transparent.** The cortex is opaque, so a
   * transparent capture is the surface on nothing — which is the point for a figure — not
   * a translucent brain.
   */
  setCaptureBackground(transparent: boolean): void {
    /* Restore the renderer's colour AS OF THE CAPTURE, not the construction-time
       `_bg`: the theme-follow writers (the app's session observer, ChartFigure)
       re-clear the shared renderer without updating any figure's `_bg`, so
       restoring that repainted every panel to the OLD theme's background after
       a theme toggle + PNG export. Saved at `true` time, right before the
       override; `_bg` remains the fallback for an unpaired `false`. */
    if (transparent) this._captureBg = this.renderer.getClearColor(_captureColor).getHex()
    const restore = this._captureBg ?? this._bg
    if (!transparent) this._captureBg = null
    this.renderer.setClearColor(restore, transparent ? 0 : 1)
  }

  /** The ratio in force before any capture — what `setCaptureScale(1)` returns to. */
  get basePixelRatio(): number { return this._basePixelRatio }
  /** Every axes in this figure, in draw order.
   *
   *  Named `axesList` rather than `axes` so the VERB is free: `fig.axes()` creates
   *  one, as MATLAB's `axes()` does. (`children` was not available — `GraphicsObject`
   *  already uses it for the scene-graph children, which are a different set.) */
  get axesList(): readonly AxesLike[] { return this._axes }

  /** Whether the in-canvas super-title band is shown (non-empty, toggled on, AND
   *  not delegated to a host shell). */
  private get _showTitle(): boolean { return !!this.title && this.titleVisible && this.titleInCanvas }

  /** Px reserved at the top of the canvas for the super-title (0 when hidden).
   *  Axes.viewportPx() insets by this so subplots sit below the title band. */
  topInsetPx(): number { return this._showTitle ? FIGURE_TITLE_BAND : 0 }

  /** Lazily create/update the super-title DOM element in the reserved top band. */
  private syncTitle(): void {
    if (!this._showTitle) {
      // Hidden (empty, toggled off, or delegated to a host shell) → remove the element
      // entirely so a stale band can never linger over the canvas.
      if (this._titleEl) { this._titleEl.remove(); this._titleEl = null }
      return
    }
    if (!this._titleEl) {
      const d = document.createElement('div')
      d.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${FIGURE_TITLE_BAND}px;` +
        `display:flex;align-items:center;justify-content:center;pointer-events:none;` +
        `color:#f0f2f5;font-family:'Instrument Sans',sans-serif;font-weight:700;font-size:15px;`
      this.container.appendChild(d)
      this._titleEl = d
    }
    if (this._titleEl.textContent !== this.title) this._titleEl.textContent = this.title
  }

  addAxes<A extends AxesLike>(a: A): A { this._axes.push(a); return a }

  /**
   * Drop an axes from the figure and dispose it — the counterpart to `addAxes`,
   * and what an INTERACTIVE layout needs: panes a user can toggle on and off.
   *
   * Disposal is not optional here, and the reason is worth stating. An `Axes`
   * lives in TWO places: this `_axes` list (which `renderFrame` walks) and, for
   * its ticks and labels, a DOM overlay parented to `figure.container`. It is not
   * a child in the `GraphicsObject` tree, so `axes.dispose()` on its own does not
   * remove it from `_axes` — the render loop would keep drawing a disposed axes.
   * Going through this method is what keeps the two in step.
   *
   * Re-laying out the SURVIVORS is the caller's job and costs nothing: `position`
   * is a plain mutable field read every frame, so assigning new rects is all a
   * re-layout is. Removing the last axes is legal — `renderFrame` clears and
   * returns — and dropping back to one full-bleed axes re-enters the
   * no-scissor fast path automatically.
   *
   * @returns whether the axes was in this figure.
   */
  removeAxes(a: AxesLike): boolean {
    const i = this._axes.indexOf(a)
    if (i < 0) return false
    this._axes.splice(i, 1)
    a.dispose()
    return true
  }

  /** MATLAB `subplot(rows, cols, index)` — create + add an Axes at a grid cell, or
   *  SPAN cells by passing an index array (`subplot(2,2,[0,1])` = the whole top row).
   *  **0-based**, row-major, cell 0 = top-left; `gutter` (fraction of a cell, default
   *  0 → cells touch, chrome margins separate them) adds extra air. Any other
   *  AxesOptions (xlim/ylim/colormap/grid) pass through. For irregular layouts, set
   *  `Axes.position` (the `axes('Position',…)` escape hatch). */
  /**
   * ONE axes filling the figure — the single-plot case, without grid arithmetic.
   *
   * `fig.subplot(1, 1, 1)` says the same thing and reads like a workaround, which
   * it was: the verb was taken by a getter, so the only way to make an axes was to
   * describe a one-cell grid. MATLAB's `axes()` creates one; so does this.
   */
  axes(opts: AxesOptions = {}): Axes {
    return this.addAxes(new Axes(this, opts))
  }

  subplot(rows: number, cols: number, index: number | number[], opts: AxesOptions & { gutter?: number } = {}): Axes {
    const { gutter, ...axesOpts } = opts
    return this.addAxes(new Axes(this, { ...axesOpts, position: subplotRect(rows, cols, index, gutter) }))
  }

  setSize(w: number, h: number): void {
    this._w = w; this._h = h
    // Size this figure's OWN surface: the CanvasTarget in session mode (so it
    // doesn't depend on which target is current), else the renderer's canvas.
    if (this._canvasTarget) this._canvasTarget.setSize(w, h)
    else this.renderer.setSize(w, h)
  }

  private frame = (time = 0): void => {
    // Own-loop mode: advance the clock by wall-clock elapsed (framerate-independent)
    // then paint. In session mode the SESSION owns the loop + clock and calls
    // renderFrame() directly, so this is never registered.
    const dt = this._lastTime ? (time - this._lastTime) / 1000 : 0
    this._lastTime = time
    this.clock.advance(dt)
    this.renderFrame()
  }

  /** Paint one frame into THIS figure's canvas. Public because a ChartSession drives
   *  it per-figure after advancing the shared clock (multiple-canvas). */
  renderFrame(): void {
    this.update()
    this.syncTitle()

    // Route the shared renderer to this figure's output surface FIRST (no-op in
    // single-canvas mode). Order matters: CanvasTarget.setSize() dispatches a resize
    // that makes the backend invalidate `renderer.getCanvasTarget()` so it reconfigures
    // at the new size. If we resized BEFORE selecting, the resize would fire while a
    // SIBLING figure was still current — invalidating the wrong canvas and leaving this
    // one to render blank after any window resize. Select, then resize.
    if (this._canvasTarget) this.renderer.setCanvasTarget(this._canvasTarget)

    const w = this.container.clientWidth || 600
    const h = this.container.clientHeight || 400
    if (w !== this._w || h !== this._h) this.setSize(w, h)

    if (this._axes.length === 0) {
      this.renderer.clear()
      return
    }
    // Each axes renders into its `position` rect (SUBPLOTS): device-px viewport +
    // scissor, so multiple plots share ONE renderer/canvas/device — the
    // webgl_multiple_elements pattern, which is what lets several plots be driven
    // by the same GPU buffers + Clock. A single full-figure axes keeps the proven
    // no-viewport whole-canvas path (the camera maps the padded limits to the
    // whole canvas; data clips to the axes box via Axes.clipPlanes, no scissor).
    const p0 = this._axes[0].position
    const singleFull = this._axes.length === 1 && !this._showTitle &&   // title → reserve the band via viewportPx
      p0.left === 0 && p0.bottom === 0 && p0.width === 1 && p0.height === 1

    if (!singleFull) {
      // Clear the whole canvas once so the gaps between subplots show the
      // background; each axes then clears + draws only its scissored rect.
      this.renderer.setScissorTest(false)
      this.renderer.setViewport(0, 0, this._w, this._h)
      this.renderer.clear()
    }

    for (const ax of this._axes) {
      ax.syncFrame()   // recompute limits/camera/clip box (+ invalidate CPU-clipped drawables)
      ax.update()      // flush dirty drawables — lines re-clip to the fresh limits this same frame
      if (!singleFull) {
        // CSS/logical px, TOP-origin — three multiplies by pixelRatio internally
        // (three.webgpu.js Renderer.setViewport stores raw; the render pass scales).
        // This is exactly what webgpu_multiple_elements feeds from getBoundingClientRect.
        const v = ax.viewportPx()
        this.renderer.setViewport(v.left, v.top, v.w, v.h)
        this.renderer.setScissor(v.left, v.top, v.w, v.h)
        this.renderer.setScissorTest(true)
      }
      this.renderer.render(ax.scene, ax.camera)
      ax.overlayRedraw()
    }
    if (!singleFull) this.renderer.setScissorTest(false)
  }

  /** Async because the WebGPU backend initializes asynchronously. An INJECTED
   *  renderer (arrangement 1) or a session's renderer is initialized by its owner. */
  async init(): Promise<void> {
    if (this._ownsRenderer) await this.renderer.init()
    const w = this.container.clientWidth || 600
    const h = this.container.clientHeight || 400
    this.setSize(w, h)
    if (this._session) this._session.register(this)   // the session drives the loop
    else this.renderer.setAnimationLoop(this.frame)
  }

  dispose(): void {
    if (this._session) this._session.unregister(this)
    else this.renderer.setAnimationLoop(null)
    for (const a of [...this._axes]) a.dispose()
    this._axes = []
    if (this._ownsRenderer) this.renderer.dispose()   // a shared/injected renderer is the owner's to dispose
    this._titleEl?.remove()
    this._canvas.remove()
    super.dispose()
  }
}

/** Create + initialize a Figure (awaits WebGPU init, starts the loop). */
export async function createFigure(opts: FigureOptions): Promise<Figure> {
  const f = new Figure(opts.container, opts)
  await f.init()
  return f
}
