/**
 * Reading NXR CSS custom properties from code that needs a NUMBER.
 *
 * Most token use is declarative — the value goes straight into a `style` string and
 * CSS resolves it. This exists for the cases that cannot: an SVG `points` list, a
 * canvas coordinate, a layout constant the geometry depends on. Reading the token
 * here rather than mirroring its value in TypeScript is what keeps the token the
 * single definition.
 *
 * `@nxr/utils` has the colour equivalent (`readCssColorHex`), but `threecharts`
 * deliberately depends on nothing but `three` — a dozen lines is a smaller price
 * than widening that boundary, and this file is where a second one would go.
 */

const cache = new Map<string, number>()

/**
 * Read a CSS custom property as a number of PIXELS.
 *
 * Only px-valued tokens resolve; anything else — a `%`, an unresolved `calc()`, an
 * unset var, or no `document` at all — falls back, so a caller always gets a usable
 * number rather than a `NaN` that propagates into geometry.
 */
export function readCssPx(varName: string, fallback: number): number {
  const hit = cache.get(varName)
  if (hit !== undefined) return hit
  if (typeof document === 'undefined') return fallback

  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  const m = /^(-?\d*\.?\d+)px$/.exec(raw)
  if (!m) return fallback
  const px = Number(m[1])
  if (!isFinite(px)) return fallback

  cache.set(varName, px)
  return px
}

/** Drop the cache — call after a theme swap that changes a geometry token. */
export function flushCssPxCache(): void { cache.clear() }

const colorCache = new Map<string, number>()

/**
 * Read a CSS custom property as a `0xRRGGBB` NUMBER — for chrome drawn in the 3-D
 * scene, where a colour has to reach a material rather than a style attribute.
 *
 * Parsed here rather than through three's `Color`, which accepts CSS colour syntax
 * but not all of what `getComputedStyle` RETURNS: a token built with `color-mix()`
 * resolves to space-separated `rgb(r g b / a)` or to `color(srgb …)` depending on the
 * browser, and a parser that throws on those would take a chart down over a colour.
 * Hex and both `rgb()` spellings cover every token this package reads; anything else
 * falls back, so a caller always gets a usable number.
 *
 * Alpha is DISCARDED — a material's opacity is its own channel here.
 */
export function readCssColorHex(varName: string, fallback: number): number {
  const hit = colorCache.get(varName)
  if (hit !== undefined) return hit
  if (typeof document === 'undefined') return fallback

  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  const hex = parseCssColor(raw)
  if (hex === null) return fallback

  colorCache.set(varName, hex)
  return hex
}

/** Exported for its own test — the browser-dependent spellings are the whole risk. */
export function parseCssColor(raw: string): number | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null

  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s)
  if (short) {
    const [, r, g, b] = short
    return (parseInt(r + r, 16) << 16) | (parseInt(g + g, 16) << 8) | parseInt(b + b, 16)
  }
  // 8-digit hex is #rrggbbaa; the alpha pair is dropped with the rest.
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s)
  if (long) return parseInt(long[1], 16)

  // `rgb(1, 2, 3)`, `rgba(1,2,3,.5)` and the modern `rgb(1 2 3 / 50%)` in one pass:
  // split on commas, slashes and runs of space, then take the first three numbers.
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number)
    if (parts.length === 3 && parts.every((v) => isFinite(v))) {
      const [r, g, b] = parts.map((v) => Math.max(0, Math.min(255, Math.round(v))))
      return (r << 16) | (g << 8) | b
    }
  }
  return null
}

/** Drop the colour cache — call after a theme swap. */
export function flushCssColorCache(): void { colorCache.clear() }
