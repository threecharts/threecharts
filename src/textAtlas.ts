import { CanvasTexture, LinearFilter, ClampToEdgeWrapping, SRGBColorSpace, type Texture } from 'three/webgpu'

/**
 * textAtlas.ts — many short strings, rasterised ONCE into one texture.
 *
 * The alternative is a texture per label, which at MEG channel counts is ~272
 * textures and ~272 draw calls. One atlas is one upload and one instanced draw.
 *
 * BAKED AT A SCALE, and it is a real trade rather than a detail: a bitmap atlas
 * is sharp at the size it was baked and soft past it. `scale: 2` costs 4× the
 * texels and stays crisp to roughly 2× zoom, which is the honest first answer.
 * The scale-free answer is an MSDF atlas, which needs a different fragment
 * shader and a font build step — worth having only once zoom sharpness is shown
 * to matter.
 *
 * REBAKE ON A THEME CHANGE AND AFTER THE FONTS LOAD. The colour and the typeface
 * are baked into the texels, and this app has shipped an entire UI in fallback
 * fonts once already — an atlas built before the webfont arrives is permanently
 * wrong, and nothing about it looks broken.
 */

/** Where one label sits in the atlas, and how big it wants to be drawn. */
export interface LabelRect {
  /** Normalised atlas coordinates: `[u0, v0, u1, v1]`, v measured from the TOP. */
  uv: [number, number, number, number]
  /** CSS pixels the label should occupy on screen — the baked size over `scale`. */
  widthPx: number
  heightPx: number
}

export interface TextAtlas {
  texture: Texture
  rects: LabelRect[]
  /** Atlas dimensions in texels. */
  width: number
  height: number
  dispose(): void
}

/** The next power of two ≥ n — GPU textures are happiest there and it keeps the
 *  atlas size predictable across relayouts. */
export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

/**
 * Shelf-pack boxes into rows of at most `maxWidth`.
 *
 * Pure, so the packing is TESTED without a canvas — the part that can be wrong in
 * a way no screenshot explains is the arithmetic, not the drawing. Returns each
 * box's origin plus the atlas size the packing needs.
 *
 * A box WIDER than `maxWidth` still gets a row of its own rather than being
 * dropped or clipped: a truncated label is a wrong label, and a caller who wants
 * elision should do it in the text.
 */
export function packBoxes(
  boxes: readonly { w: number; h: number }[], maxWidth: number,
): { origins: { x: number; y: number }[]; width: number; height: number } {
  const origins: { x: number; y: number }[] = []
  let x = 0, y = 0, rowH = 0, used = 0
  for (const b of boxes) {
    if (x > 0 && x + b.w > maxWidth) { x = 0; y += rowH; rowH = 0 }
    origins.push({ x, y })
    x += b.w
    used = Math.max(used, x)
    rowH = Math.max(rowH, b.h)
  }
  return { origins, width: nextPow2(Math.max(1, used)), height: nextPow2(Math.max(1, y + rowH)) }
}

export interface TextAtlasOptions {
  /** CSS font shorthand, at the LOGICAL size — `scale` multiplies it. */
  font?: string
  color?: string
  /** Supersampling. 2 keeps text crisp to ~2× zoom at 4× the texels. */
  scale?: number
  /** Texels of transparent margin around each label, so neighbours cannot bleed
   *  into one another under linear filtering. */
  padding?: number
  maxWidth?: number
}

/**
 * Rasterise `texts` into one atlas.
 *
 * Returns null when there is no 2D canvas to draw on (jsdom, a worker) rather
 * than throwing — a chart without labels is a chart, and a test environment
 * should not have to stub a canvas to mount one.
 */
export function buildTextAtlas(
  texts: readonly string[], opts: TextAtlasOptions = {},
): TextAtlas | null {
  const scale = opts.scale ?? 2
  const pad = opts.padding ?? 2
  const font = opts.font ?? '12px system-ui, sans-serif'
  const color = opts.color ?? '#ffffff'
  const maxWidth = opts.maxWidth ?? 2048

  const measure = document.createElement('canvas')
  const mctx = measure.getContext('2d')
  if (!mctx) return null
  mctx.font = `${scale * parseFloat(font) || 12 * scale}px ${font.replace(/^[\d.]+px\s*/, '')}`
  const scaledFont = mctx.font

  const boxes = texts.map((t) => {
    const m = mctx.measureText(t)
    /* Ascent + descent from the METRICS, not a guess at the line height: a name
       with a descender ('g' in a channel label) is clipped by an em-height box,
       and the clip is subtle enough to read as a font problem. */
    const asc = m.actualBoundingBoxAscent || scale * 9
    const desc = m.actualBoundingBoxDescent || scale * 3
    return { w: Math.ceil(m.width) + pad * 2, h: Math.ceil(asc + desc) + pad * 2, asc }
  })

  const { origins, width, height } = packBoxes(boxes, maxWidth)
  const cv = document.createElement('canvas')
  cv.width = width; cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.font = scaledFont
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'

  const rects: LabelRect[] = []
  texts.forEach((t, i) => {
    const b = boxes[i], o = origins[i]
    ctx.fillText(t, o.x + pad, o.y + pad + b.asc)
    rects.push({
      uv: [o.x / width, o.y / height, (o.x + b.w) / width, (o.y + b.h) / height],
      widthPx: b.w / scale,
      heightPx: b.h / scale,
    })
  })

  const tex = new CanvasTexture(cv)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.generateMipmaps = false
  /* sRGB: these ARE authored-for-display colours, unlike the volume and the
     categorical LUT — the opposite call from `volumeTexture.ts`, for the opposite
     reason. */
  tex.colorSpace = SRGBColorSpace
  tex.needsUpdate = true

  return { texture: tex, rects, width, height, dispose: () => tex.dispose() }
}
