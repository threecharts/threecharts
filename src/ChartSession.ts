import { WebGPURenderer } from 'three/webgpu'
import { Clock } from './Clock'
import type { Figure } from './Figure'
import { REQUIRED_STORAGE_BUFFERS } from './deviceLimits'

/** What a Figure needs from its session — decoupled so Figure doesn't import
 *  ChartSession at runtime (avoids the cycle). */
export interface FigureSession {
  readonly renderer: WebGPURenderer
  readonly clock: Clock
  register(fig: Figure): void
  unregister(fig: Figure): void
}

export interface ChartSessionOptions {
  backgroundColor?: number
  /**
   * Ask the device for TIMESTAMP QUERIES, so `renderer.info.render.timestamp`
   * reports GPU time per frame. Default false.
   *
   * A CONSTRUCTION option and not a settable flag, because the backend creates its
   * query pool during `init()` from the value it sees there — setting
   * `renderer.trackTimestamp` afterwards flips the Renderer's own boolean and
   * leaves the pool that never got made, so every timestamp reads zero and the
   * measurement silently reports "free" for work that is not.
   *
   * Off by default: a diagnostic should not be paying for itself in every session.
   */
  trackTimestamp?: boolean
}

/**
 * ChartSession — the shared rendering context for SEVERAL Figures (= a MATLAB
 * process hosting many `figure()` windows). Owns ONE `WebGPURenderer`/device, ONE
 * shared `Clock`, and the single animation loop; each member Figure renders into its
 * OWN `<canvas>` via a `CanvasTarget` (the three `webgpu_multiple_canvas` pattern).
 *
 * Because the device is shared, GPU storage buffers created against
 * `session.renderer` are visible to every Figure — so multiple separate figures
 * (an image-series dock, a vector-field dock, a timeseries dock) draw from the SAME
 * buffers at the SAME clock frame, with zero cross-canvas copying.
 */
/* The storage-buffer budget lives in `deviceLimits.ts` — `Figure` needs the same
   number and must not import this module at runtime (see the header). Re-exported
   here because this is where callers have always found it. */
export { REQUIRED_STORAGE_BUFFERS } from './deviceLimits'

/**
 * The 2-D texture edge the session ASKS the device for, above WebGPU's 8192 default.
 *
 * **Requested, not required** — unlike `REQUIRED_STORAGE_BUFFERS`, which the charts
 * cannot run without. `requestDevice` REJECTS when a required limit exceeds what the
 * adapter supports, so asking unconditionally would turn "cannot capture at 4×" into
 * "the app does not start" on a GPU that reports only 8192. `init()` therefore asks,
 * and falls back to the default device on failure.
 *
 * 16384 because that is what desktop adapters overwhelmingly advertise — including the
 * one that produced the error this exists for, which offered 16384 while its device sat
 * at 8192 and refused an 8536 px capture.
 */
export const WANTED_TEXTURE_SIZE = 16384

/**
 * Did this renderer actually get a WebGPU device, or fall back?
 *
 * **The retry in `init()` depends on this and cannot use `try`/`catch`.**
 * `requestDevice` rejects when a required limit exceeds the adapter's — which is
 * what the fallback below exists for — but `WebGPURenderer.init()` does not
 * propagate that rejection. It catches it, warns to the console, and continues on
 * its WebGL2 backend. So a `catch` around `init()` never runs, and the session goes
 * on to render degraded while reporting success.
 *
 * That was this file's behaviour until it was caught on an adapter reporting
 * `maxTextureDimension2D: 8192` — precisely the case the retry was written for, and
 * the case its own comment says is common on mobile. The retry was dead code and
 * the black-window trade it meant to avoid was being made silently instead.
 */
function isWebGPU(r: WebGPURenderer): boolean {
  const b = (r as unknown as { backend?: { isWebGPUBackend?: boolean; device?: unknown } }).backend
  return b?.isWebGPUBackend === true && b.device != null
}

export class ChartSession implements FigureSession {
  readonly renderer: WebGPURenderer
  readonly clock = new Clock()
  private _figures: Figure[] = []
  private _lastTime = 0
  private _running = false

  private readonly _bg: number

  private readonly _trackTimestamp: boolean

  constructor(opts: ChartSessionOptions = {}) {
    this._bg = opts.backgroundColor ?? 0x000000
    this._trackTimestamp = opts.trackTimestamp === true
    this.renderer = this._makeRenderer(WANTED_TEXTURE_SIZE)
  }

  private _makeRenderer(textureSize: number | null): WebGPURenderer {
    const limits: Record<string, number> = { maxStorageBuffersPerShaderStage: REQUIRED_STORAGE_BUFFERS }
    if (textureSize !== null) limits.maxTextureDimension2D = textureSize
    const r = new WebGPURenderer({
      antialias: true,
      requiredLimits: limits as unknown as Record<string, number>,
      // The backend ANDs this with the adapter's own `timestamp-query` feature, so a
      // device without it degrades to no timestamps rather than to no device.
      trackTimestamp: this._trackTimestamp,
    } as ConstructorParameters<typeof WebGPURenderer>[0])
    r.setClearColor(this._bg, 1)
    return r
  }

  /**
   * Async: the WebGPU backend initializes asynchronously. Call before adding figures.
   *
   * **Retries once without the raised texture limit.** `requestDevice` rejects outright
   * when a required limit is above what the adapter supports, so an unconditional ask
   * for 16384 would make the app fail to START on a GPU that reports 8192 — trading a
   * capture ceiling for a black window. The retry is safe here precisely because this
   * runs before any figure exists: nothing holds a reference to the discarded renderer.
   */
  async init(): Promise<void> {
    await this.renderer.init()
    if (isWebGPU(this.renderer)) return
    console.warn('[ChartSession] device refused maxTextureDimension2D =',
      WANTED_TEXTURE_SIZE, '— retrying at the default')
    ;(this as { renderer: WebGPURenderer }).renderer = this._makeRenderer(null)
    await this.renderer.init()
    if (!isWebGPU(this.renderer)) {
      console.warn('[ChartSession] no WebGPU device — running on the WebGL2 fallback')
    }
  }

  /**
   * The largest 2-D texture THIS DEVICE will create — the hard ceiling on any render
   * target, including the swapchain a high-resolution capture allocates.
   *
   * **The device limit, not the adapter's, and they differ.** WebGPU's default
   * `maxTextureDimension2D` is 8192; an adapter commonly advertises 16384 but a device
   * only gets the larger number if it was REQUESTED at creation. Reading the adapter's
   * figure and sizing a target to it produces exactly the failure this getter exists to
   * prevent: `Texture size (8536×2616) exceeded maximum texture size (8192×8192). This
   * adapter supports a higher maxTextureDimension2D of 16384` — followed by an invalid
   * swapchain and a cascade of invalid-texture errors the renderer does not recover
   * from.
   *
   * 8192 when the backend has not initialised or does not report — the spec's guaranteed
   * floor, so a caller that clamps to it is always safe.
   */
  get maxTextureSize(): number {
    const dev = (this.renderer as unknown as { backend?: { device?: { limits?: { maxTextureDimension2D?: number } } } })
      .backend?.device?.limits?.maxTextureDimension2D
    return typeof dev === 'number' && dev > 0 ? dev : 8192
  }

  /** The figures currently painting into this session, in registration order.
   *  Read-only — membership is `register`/`unregister`'s. Exists so a diagnostic
   *  can walk what is actually being drawn without a parallel registry that could
   *  disagree with the render loop about what exists. */
  get figures(): readonly Figure[] { return this._figures }
  register(fig: Figure): void { if (!this._figures.includes(fig)) this._figures.push(fig) }
  unregister(fig: Figure): void { this._figures = this._figures.filter((f) => f !== fig) }

  /** Start the shared loop: advance the one clock, then paint every figure's canvas. */
  start(): void {
    if (this._running) return
    this._running = true
    this.renderer.setAnimationLoop(this.frame)
  }

  stop(): void {
    this._running = false
    this.renderer.setAnimationLoop(null)
  }

  private frame = (time = 0): void => {
    const dt = this._lastTime ? (time - this._lastTime) / 1000 : 0
    this._lastTime = time
    this.clock.advance(dt)                         // one shared clock tick…
    for (const f of this._figures) f.renderFrame() // …then each figure paints its own canvas
  }

  dispose(): void {
    this.stop()
    this._figures = []
    this.renderer.dispose()
  }
}
