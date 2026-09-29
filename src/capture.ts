/**
 * capture.ts — read pixels back off a chart canvas, as a single image or a filmstrip.
 *
 * ── THE ONE THING THAT MAKES THIS SUBTLE ────────────────────────────────────
 *
 * **A WebGPU canvas has nothing to give unless it has just rendered.** Measured on
 * this stack: `drawImage` from a paused, unchanged figure yields a fully transparent
 * image — 0 non-background pixels, `maxAlpha` 0, and a `toDataURL` of ~1.9 KB that
 * looks like a valid PNG and is empty. Do the same thing one seek and two animation
 * frames later and it comes back with real pixels.
 *
 * That is why capture lives here rather than at the call site: the rule is "cause a
 * render, wait for it, THEN grab", and a caller who forgets any part of it gets a
 * blank file rather than an error. `captureFrames` owns the whole sequence and the
 * caller only says what should change between frames.
 *
 * ── WHAT IS AND IS NOT IN THE PICTURE ───────────────────────────────────────
 *
 * The CANVAS only — the 3D scene and its background. A chart's legend, colorbar,
 * scale bar and axis chrome are DOM siblings of the canvas, not pixels in it, so they
 * do not appear. For a filmstrip that is arguably the right cut (one colorbar beside
 * the strip beats N copies inside it), but a single snapshot is a picture of the
 * scene rather than a finished figure. Say so wherever this is offered.
 */

/** Wait for `n` animation frames — the settle the header describes. */
export function nextFrames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = Math.max(1, n)
    const tick = (): void => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
}

/**
 * Grab one frame as an image, INSTEAD of reading the canvas.
 *
 * Supplied when the host can composite the chrome — an Electron screenshot of the page
 * region — so the tiling, cropping, settling and download here are shared between the
 * two sources rather than duplicated. Return null to fall back to the canvas for that
 * frame; a capture that silently produced a chrome-less tile in the middle of a strip
 * would be worse than one that failed.
 */
export type FrameSource = () => Promise<CanvasImageSource | null>

export interface CaptureOptions {
  /** The figure's canvas — `figure.canvas`. */
  canvas: HTMLCanvasElement
  /**
   * Where a frame's PIXELS come from, if not the canvas.
   *
   * The canvas is still required even with this set: it is what `crop` measures the
   * content box against, and its aspect is what the cells are laid out from.
   */
  frameSource?: FrameSource
  /** How many frames to grab. 1 is a plain snapshot. */
  count: number
  /**
   * Cause frame `i` to be drawn — seek the clock, change a setting, anything. Awaited
   * before the settle, so an async step (a page load) can be honoured.
   *
   * A snapshot of a STATIC scene still needs this to do something that triggers a
   * render, or the grab is blank (see the header). Seeking to the current position
   * counts, since the clock emits either way.
   */
  onFrame: (i: number) => void | Promise<void>
  /** Columns in the tiled output. Default: one row. */
  cols?: number
  /** Scale each cell relative to the source canvas. Default 1. */
  scale?: number
  /**
   * Painted under every cell before the frame is drawn on it. Default opaque black.
   *
   * **`null` paints nothing, which is how a capture keeps its ALPHA.** The canvas is
   * alpha-enabled (the blank-capture probe came back `maxAlpha: 0`), so an unpainted
   * composite preserves whatever transparency the frame carries. That is only useful
   * alongside `figure.setCaptureBackground(true)` — without it the renderer still clears
   * opaque and every pixel arrives solid, so the result is an ordinary black-backed PNG
   * that merely took a different route.
   *
   * The default stays opaque because it is the safe one: a transparent PNG opened on a
   * white page shows nothing where the background should be, and that reads as a broken
   * export rather than as a deliberate one.
   */
  background?: string | null
  /** Animation frames to wait after `onFrame` before grabbing. Default 2. */
  settle?: number
  /**
   * Crop every cell to the drawn CONTENT rather than to the canvas.
   *
   * A chart canvas is as wide as the region it sits in, and a 3D scene inside it is
   * usually a small island in the middle — tiling the raw canvas six times produces an
   * image that is mostly background. The crop box is measured ONCE, on the first frame,
   * and reused for the rest: measuring per frame would let the box breathe with the
   * data and the strip would stop being a comparison.
   *
   * Off by default, since a chart that fills its canvas wants the whole thing.
   */
  crop?: boolean
  /** Padding kept around the content box, in source px. Default 12. */
  cropPadding?: number
}

/** The bounding box of everything that differs from the canvas's corner pixel, or null
 *  when the frame is empty. Sampled on a downscale — a crop box does not need to be
 *  exact, and reading 2164x698 pixels per capture would be the slowest thing here. */
function contentBox(
  canvas: HTMLCanvasElement, pad: number,
): { x: number; y: number; w: number; h: number } | null {
  const SAMPLE_W = 320
  const s = Math.min(1, SAMPLE_W / canvas.width)
  const sw = Math.max(1, Math.round(canvas.width * s))
  const sh = Math.max(1, Math.round(canvas.height * s))
  const probe = document.createElement('canvas')
  probe.width = sw; probe.height = sh
  const pg = probe.getContext('2d', { willReadFrequently: true })
  if (!pg) return null
  pg.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, sw, sh)
  const d = pg.getImageData(0, 0, sw, sh).data
  // The corner is background by construction — a scene centred in its viewport never
  // reaches it. Comparing against it rather than against alpha covers both an opaque
  // clear colour and a transparent canvas.
  const br = d[0], bg = d[1], bb = d[2], ba = d[3]
  const TOL = 10
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4
      const differs = Math.abs(d[i] - br) > TOL || Math.abs(d[i + 1] - bg) > TOL
        || Math.abs(d[i + 2] - bb) > TOL || Math.abs(d[i + 3] - ba) > TOL
      if (differs) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  const inv = 1 / s
  const x = Math.max(0, Math.round(x0 * inv) - pad)
  const y = Math.max(0, Math.round(y0 * inv) - pad)
  const w = Math.min(canvas.width - x, Math.round((x1 - x0 + 1) * inv) + pad * 2)
  const h = Math.min(canvas.height - y, Math.round((y1 - y0 + 1) * inv) + pad * 2)
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/**
 * Grab `count` frames and tile them into one image.
 *
 * Returns null if the canvas has no size, or if the composite would exceed what a
 * canvas can be — a browser silently fails to allocate past ~16384 px a side, which
 * would otherwise surface as an empty download rather than as a refusal.
 */
export async function captureFrames(opts: CaptureOptions): Promise<Blob | null> {
  const { canvas, count, onFrame, settle = 2 } = opts
  const scale = opts.scale ?? 1
  const cols = Math.max(1, Math.min(opts.cols ?? count, count))
  const rows = Math.ceil(count / cols)
  if (canvas.width === 0 || canvas.height === 0) return null

  /* THE FIRST FRAME IS DRAWN BEFORE THE OUTPUT EXISTS, because with `crop` the output's
     SIZE depends on what that frame contains. So frame 0 is rendered, measured, and
     only then does the composite get allocated — and frame 0 is drawn into it from the
     canvas, which still holds it. */
  await onFrame(0)
  await nextFrames(settle)
  const src = (opts.crop ? contentBox(canvas, opts.cropPadding ?? 12) : null)
    ?? { x: 0, y: 0, w: canvas.width, h: canvas.height }

  /*
   * A COMPOSITED frame is the whole region, not the canvas — so the crop box measured
   * above, which is in CANVAS pixels, does not apply to it. It carries the chrome that
   * sits OUTSIDE the cortex's content box (the colorbar is in the corner, the scale bar
   * at the edge), and cropping to the cortex would cut off precisely what compositing
   * was for.
   */
  const composited = opts.frameSource ? await opts.frameSource() : null
  const useSource = composited !== null

  const sw = useSource ? sourceWidth(composited!) : src.w
  const sh = useSource ? sourceHeight(composited!) : src.h
  const cellW = Math.max(1, Math.round(sw * scale))
  const cellH = Math.max(1, Math.round(sh * scale))
  /* The 2D COMPOSITE's ceiling, which is a different thing from the render target's:
     this is a plain `<canvas>`, so the browser's own maximum applies, not the WebGPU
     device's. 16384 is Chromium's. The render-side limit is enforced where it belongs,
     in `Figure.maxCaptureScale`. */
  const MAX_SIDE = 16384
  if (cellW * cols > MAX_SIDE || cellH * rows > MAX_SIDE) return null

  const out = document.createElement('canvas')
  out.width = cellW * cols
  out.height = cellH * rows
  const g = out.getContext('2d')
  if (!g) return null
  /* `null` = keep the alpha (see `background`). A fresh 2-D canvas is already fully
     transparent, so the fill is simply skipped — `clearRect` would be a no-op. */
  const bg = opts.background === undefined ? '#000' : opts.background
  if (bg !== null) {
    g.fillStyle = bg
    g.fillRect(0, 0, out.width, out.height)
  }

  for (let i = 0; i < count; i++) {
    let frame: CanvasImageSource | null = i === 0 ? composited : null
    if (i > 0) {
      await onFrame(i)
      await nextFrames(settle)
      if (opts.frameSource) frame = await opts.frameSource()
    }
    const cx = (i % cols) * cellW
    const cy = Math.floor(i / cols) * cellH
    if (frame) {
      g.drawImage(frame, 0, 0, sourceWidth(frame), sourceHeight(frame), cx, cy, cellW, cellH)
    } else {
      // Source rect explicitly: the canvas BACKING size, not its CSS size, or a
      // device-pixel-ratio of 2 would draw a quarter of the scene at full scale.
      g.drawImage(canvas, src.x, src.y, src.w, src.h, cx, cy, cellW, cellH)
    }
  }

  return new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), 'image/png'))
}

/** `CanvasImageSource` is a union whose members spell their size differently — a
 *  `VideoFrame` has `codedWidth`, an `SVGImageElement` only a `width` attribute. These
 *  narrow the two the capture path actually produces. */
function sourceWidth(s: CanvasImageSource): number {
  return (s as HTMLImageElement).naturalWidth || (s as HTMLCanvasElement).width || 1
}
function sourceHeight(s: CanvasImageSource): number {
  return (s as HTMLImageElement).naturalHeight || (s as HTMLCanvasElement).height || 1
}

/** Hand a blob to the browser as a download. Revokes the URL once the click is
 *  dispatched — holding it pins the whole image in memory for the session. */
/** The URL of the last download, revoked when the next one starts — see below. */
let lastDownloadUrl: string | null = null

export function downloadBlob(blob: Blob, filename: string): void {
  /* NEVER REVOKE ON A TIMER.
   *
   * This used to release the URL after 1000 ms, which is fine in a browser — Chrome
   * resolves a blob download almost synchronously — and WRONG in Electron, where the
   * app registers no `will-download` handler and so gets the default: a native SAVE
   * DIALOG. A person takes longer than a second to choose a folder, and the URL was
   * revoked out from under the download while they were still deciding.
   *
   * So the previous URL is released when the NEXT download starts, and the current one
   * lives as long as it needs to. That bounds the leak to one image rather than to the
   * session, without guessing at how long a human takes.
   *
   * Worth knowing about the test that missed it: the capture gate intercepted
   * `createObjectURL` to inspect the blob's bytes, which verified the IMAGE and never
   * exercised the download at all.
   */
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl)
  const url = URL.createObjectURL(blob)
  lastDownloadUrl = url
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// A page teardown is the one moment the current URL is certainly finished with.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl)
    lastDownloadUrl = null
  })
}
