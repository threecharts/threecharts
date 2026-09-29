/**
 * Colormap library loader, registry, and TSL/CPU samplers.
 *
 * A **library** is a `(colormaps.png, colormaps.json)` pair under a
 * stable URL prefix. Several libraries can be loaded into the same app
 * (e.g. `'default'` + `'matplotlib'` + `'cmocean'` + `'crameri'` +
 * `'colorcet'`); each chart binds to one library at construction and
 * addresses rows by their **library + index**.
 *
 * The set of libraries available is enumerated by `libs.json` at the
 * library-set base URL. The host pattern at boot:
 *
 *   await loadAllColormapLibraries('/colormaps')
 *
 * loads `<base>/libs.json`, then loads every library it lists in
 * parallel. Granular alternatives:
 *
 *   await loadColormapIndex('/colormaps')                     // libs.json only
 *   await loadColormapLibrary('cmocean', '/colormaps/cmocean')  // one library
 *
 * Chart pattern (chart core):
 *
 *   const sampler = createColormapSampler(opts.colormapLibrary ?? 'default')
 *   const base = sampler.sample(t, uColormapRow)
 *
 * The PNG is `N × W` RGBA8 sRGB, top-row-first (PNG row 0 = `v = 0` in
 * the sampler thanks to `flipY = false`). The JSON sidecar follows
 * `nxr-colormaps`'s `schema.json` (version 2): `{ version, library,
 * width, rows, colormaps[{ name, source, source_id, type,
 * perceptually_uniform, description, citation, index, license }] }`.
 *
 * Backward-compat: `loadAtlas` / `getAtlasTexture` / global
 * `colormapSample` / 2-arg `colormapSampleCPU` / `setAtlasImageData` /
 * `COLORMAP_NAMES` / `TOTAL_ROWS` / `ColormapName3D` all stay as
 * deprecated stubs pinned to the `'default'` library. `COLORMAP_NAMES`
 * is now an empty array (the static tuple is stale — `default` has 20
 * rows, not the 16 of the legacy MATLAB atlas); read names from
 * `getColormapLibrary('default')?.manifest.colormaps` at runtime.
 */

// @ts-ignore — three/tsl types
import { texture, vec2, float } from 'three/tsl'
import {
  TextureLoader, LinearFilter, ClampToEdgeWrapping, type Texture,
} from 'three/webgpu'

/* ─── Types — match nxr-colormaps `schema.json` v2 ───────────────────── */

export type ColormapLibraryId = string

export type ColormapType =
  | 'sequential'
  | 'diverging'
  | 'cyclic'
  | 'categorical'

export type ColormapSourceKind =
  | 'matplotlib'
  | 'cmocean'
  | 'crameri'
  | 'colorcet'
  | 'raw'

/** Per-row entry from `colormaps.json`. The `index` is the row in the PNG. */
export interface ColormapEntry {
  name: string
  source: ColormapSourceKind
  source_id: string
  type: ColormapType
  perceptually_uniform: boolean
  description: string
  citation: string
  index: number
  /** CSS linear-gradient preview of this colormap (stored in colormaps.json). */
  preview?: string
  license: string
  /**
   * What this colormap is FOR, when it is not a general-purpose ramp.
   *
   * `'atlas'` marks a parcellation lookup table: baked into the `default` texture so
   * a chart can resolve it by name — every drawable hardcodes
   * `createColormapSampler('default')` — and excluded from `colormapCatalog()`,
   * because offering a parcellation LUT as a choice for a scalar field offers a
   * colour ramp that is not one. Its only consumers are the atlas tools, which name
   * it directly.
   *
   * `type` cannot carry this: `tab10`, `Set2` and `glasbey` are categorical too and
   * belong in the picker. Empty (absent) on every general-purpose entry.
   */
  usage?: string
}

/** Top-level shape of `colormaps.json` (v2). */
export interface ColormapManifest {
  version: 2
  library: string
  width: number
  rows: number
  colormaps: ColormapEntry[]
}

/** Top-level shape of `libs.json`. */
export interface ColormapIndex {
  version: 1
  libraries: ColormapLibraryId[]
}

/** A loaded library: GPU texture, CPU image data, and the JSON manifest. */
export interface ColormapLibrary {
  id: ColormapLibraryId
  /** Base URL the library was loaded from. */
  baseUrl: string
  /** GPU side (used by TSL `texture(...)`). */
  texture: Texture
  /** CPU side (used by `colormapSampleCPU` for canvas/colorbar paths). */
  imageData: ImageData
  manifest: ColormapManifest
}

/** A library-bound TSL sampler — capture once per chart, reuse per fragment. */
export interface ColormapSampler {
  /** The library this sampler is bound to. */
  library: ColormapLibrary
  /** Build a TSL `texture(...)` lookup at `(t, row)`.
   *  `colormapIndex` may be a JS number (static) or a TSL uniform node
   *  (so the row can be switched at runtime by updating `.value`). */
  sample: (tNode: unknown, colormapIndex: number | unknown) => unknown
}

/* ─── Registry ───────────────────────────────────────────────────────── */

const _libraries = new Map<ColormapLibraryId, ColormapLibrary>()
const _loadingPromises = new Map<ColormapLibraryId, Promise<ColormapLibrary>>()

/**
 * Load a colormap library — fetches `<baseUrl>/colormaps.png` and
 * `<baseUrl>/colormaps.json` in parallel, registers under `id`, and
 * resolves with the loaded library. Idempotent.
 */
export function loadColormapLibrary(
  id: ColormapLibraryId,
  baseUrl: string,
): Promise<ColormapLibrary> {
  const existing = _libraries.get(id)
  if (existing) return Promise.resolve(existing)
  const inflight = _loadingPromises.get(id)
  if (inflight) return inflight

  const trimmed = baseUrl.replace(/\/$/, '')
  const pngUrl = `${trimmed}/colormaps.png`
  const jsonUrl = `${trimmed}/colormaps.json`

  // GPU side — TextureLoader.
  const texPromise = new Promise<Texture>((resolve, reject) => {
    new TextureLoader().load(
      pngUrl,
      (tex) => {
        tex.minFilter = LinearFilter
        tex.magFilter = LinearFilter
        tex.wrapS = ClampToEdgeWrapping
        tex.wrapT = ClampToEdgeWrapping
        tex.generateMipmaps = false
        tex.flipY = false   // PNG row 0 = top = v=0 in sampler space
        resolve(tex)
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(`Failed to load ${pngUrl}: ${err}`)),
    )
  })

  // CPU side — Image → canvas → ImageData. Same URL; HTTP cache makes
  // this typically a single network request.
  const imgPromise = new Promise<ImageData>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')
      if (!ctx) return reject(new Error('2D canvas context unavailable'))
      ctx.drawImage(img, 0, 0)
      resolve(ctx.getImageData(0, 0, img.width, img.height))
    }
    img.onerror = () => reject(new Error(`Failed to load image ${pngUrl}`))
    img.src = pngUrl
  })

  // Manifest — fetch + parse.
  const manifestPromise = fetch(jsonUrl).then(async (r) => {
    if (!r.ok) throw new Error(`Failed to load ${jsonUrl}: HTTP ${r.status}`)
    const data = (await r.json()) as ColormapManifest
    if (typeof data?.rows !== 'number' || !Array.isArray(data?.colormaps)) {
      throw new Error(`${jsonUrl}: not a valid ColormapManifest`)
    }
    return data
  })

  const promise = Promise.all([texPromise, imgPromise, manifestPromise])
    .then(([tex, imageData, manifest]) => {
      const lib: ColormapLibrary = {
        id, baseUrl: trimmed, texture: tex, imageData, manifest,
      }
      _libraries.set(id, lib)
      _loadingPromises.delete(id)
      // Invalidate any cached CPU palettes for this library.
      for (const k of [..._cpuPalettes.keys()]) {
        if (k.startsWith(`${id}:`)) _cpuPalettes.delete(k)
      }
      return lib
    })
    .catch((err) => {
      _loadingPromises.delete(id)
      throw err
    })

  _loadingPromises.set(id, promise)
  return promise
}

/**
 * Fetch `<baseUrl>/libs.json` — the top-level index of available
 * libraries. Doesn't load any library PNG/JSON — call
 * `loadColormapLibrary` separately, or use `loadAllColormapLibraries`
 * to load every library the index lists.
 */
export function loadColormapIndex(baseUrl: string): Promise<ColormapIndex> {
  const trimmed = baseUrl.replace(/\/$/, '')
  const url = `${trimmed}/libs.json`
  return fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`Failed to load ${url}: HTTP ${r.status}`)
    const data = (await r.json()) as ColormapIndex
    if (typeof data?.version !== 'number' || !Array.isArray(data?.libraries)) {
      throw new Error(`${url}: not a valid ColormapIndex`)
    }
    return data
  })
}

/**
 * One-shot boot helper — load `libs.json` then every library it lists
 * in parallel. Resolves with all loaded libraries.
 */
export function loadAllColormapLibraries(baseUrl: string): Promise<ColormapLibrary[]> {
  const trimmed = baseUrl.replace(/\/$/, '')
  return loadColormapIndex(trimmed).then((index) =>
    Promise.all(
      index.libraries.map((id) => loadColormapLibrary(id, `${trimmed}/${id}`)),
    ),
  )
}

/** Lookup a registered library. Returns `null` if not loaded. */
export function getColormapLibrary(id: ColormapLibraryId): ColormapLibrary | null {
  return _libraries.get(id) ?? null
}

/** All currently-registered libraries. */
export function listColormapLibraries(): ColormapLibrary[] {
  return Array.from(_libraries.values())
}

/** UI-facing per-row view of a loaded library: name, atlas index, type, and the
 *  stored gradient preview. Returns [] when the library is not (yet) loaded. */
export function getColormapLibraryEntries(
  id: ColormapLibraryId,
): Array<{ name: string; index: number; type: string; preview?: string }> {
  const lib = _libraries.get(id)
  if (!lib) return []
  return lib.manifest.colormaps.map((e) => ({
    name: e.name, index: e.index, type: e.type, preview: e.preview,
  }))
}

/**
 * Build a TSL sampler bound to `id`. Throws if the library isn't
 * loaded — call `loadColormapLibrary` first. Re-binding to a different
 * library means rebuilding the sampler (and the chart's color node).
 */
export function createColormapSampler(id: ColormapLibraryId): ColormapSampler {
  const lib = _libraries.get(id)
  if (!lib) {
    throw new Error(
      `createColormapSampler: library '${id}' not loaded. ` +
      `Call loadColormapLibrary('${id}', '<baseUrl>') (or loadAllColormapLibraries) first.`,
    )
  }
  const rows = lib.manifest.rows
  return {
    library: lib,
    sample(tNode, colormapIndex) {
      const idxNode: any =
        typeof colormapIndex === 'number'
          ? float(colormapIndex)
          : (colormapIndex as any)
      const row = idxNode.add(0.5).div(float(rows))
      return texture(lib.texture as any, vec2(tNode as any, row as any))
    },
  }
}

/* ─── CPU sampling — canvas + colorbar path ──────────────────────────── */

// Cached per-(library, row) lookup tables. Key: `${libraryId}:${row}`.
const _cpuPalettes = new Map<string, Uint8Array>()

function _paletteKey(libraryId: ColormapLibraryId, row: number): string {
  return `${libraryId}:${row}`
}

function _buildCPUPalette(lib: ColormapLibrary, row: number): Uint8Array {
  const w = lib.imageData.width
  const pal = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = Math.min(w - 1, Math.round((i * (w - 1)) / 255))
    const off = (row * w + x) * 4
    pal[i * 3]     = lib.imageData.data[off]
    pal[i * 3 + 1] = lib.imageData.data[off + 1]
    pal[i * 3 + 2] = lib.imageData.data[off + 2]
  }
  _cpuPalettes.set(_paletteKey(lib.id, row), pal)
  return pal
}

/** Sample a colormap on the CPU. Returns `[r, g, b]` in 0–255.
 *  Returns mid-gray if the library isn't loaded yet (so callers don't
 *  crash mid-render — they'll repaint once the library arrives). */
export function colormapSampleCPU(libraryId: ColormapLibraryId, t: number, colormapIndex: number): [number, number, number]
/** @deprecated — pass a `libraryId`; this overload defaults to `'default'`. */
export function colormapSampleCPU(t: number, colormapIndex: number): [number, number, number]
export function colormapSampleCPU(
  ...args: [string, number, number] | [number, number]
): [number, number, number] {
  const [libraryId, t, colormapIndex] =
    typeof args[0] === 'string'
      ? args as [string, number, number]
      : ['default', args[0] as number, args[1] as number]
  const lib = _libraries.get(libraryId)
  if (!lib) return [128, 128, 128]
  const key = _paletteKey(libraryId, colormapIndex)
  const pal = _cpuPalettes.get(key) ?? _buildCPUPalette(lib, colormapIndex)
  const idx = Math.max(0, Math.min(255, Math.round(t * 255)))
  return [pal[idx * 3], pal[idx * 3 + 1], pal[idx * 3 + 2]]
}

/* ─── Backward-compat shims (deprecated; pinned to 'default') ────────── */

/** @deprecated Use `loadColormapLibrary('default', '/colormaps/default')`
 *  or `loadAllColormapLibraries('/colormaps')`. */
export function loadAtlas(url?: string): Promise<Texture> {
  if (url && url !== '/colormaps.png' && url !== '/colormaps/default/colormaps.png') {
    // eslint-disable-next-line no-console
    console.warn(
      `loadAtlas: legacy shim ignores custom URL '${url}'. ` +
      `Use loadColormapLibrary('<id>', '<baseUrl>') for non-default libraries.`,
    )
  }
  return loadColormapLibrary('default', '/colormaps/default').then((lib) => lib.texture)
}

/** @deprecated Use `getColormapLibrary('default')?.texture`. */
export function getAtlasTexture(): Texture | null {
  return _libraries.get('default')?.texture ?? null
}

/** @deprecated Use `createColormapSampler('default').sample(t, idx)`. */
export function colormapSample(
  tNode: unknown,
  colormapIndex: number | unknown,
): unknown {
  const lib = _libraries.get('default')
  if (!lib) {
    // Pre-load fallback. Charts gate rendering on getAtlasTexture() /
    // getColormapLibrary() before mounting, so this branch shouldn't fire
    // in practice. Returns a dummy lookup against a null texture.
    const idxNode: any =
      typeof colormapIndex === 'number' ? float(colormapIndex) : (colormapIndex as any)
    const row = idxNode.add(0.5).div(float(20))
    return texture(null as any, vec2(tNode as any, row as any))
  }
  const rows = lib.manifest.rows
  const idxNode: any =
    typeof colormapIndex === 'number'
      ? float(colormapIndex)
      : (colormapIndex as any)
  const row = idxNode.add(0.5).div(float(rows))
  return texture(lib.texture as any, vec2(tNode as any, row as any))
}

/** @deprecated `loadColormapLibrary` populates ImageData automatically; no-op. */
export function setAtlasImageData(_imageData: ImageData): void {
  // No-op — kept so legacy callers don't break.
}

/**
 * @deprecated Stale: the previous static tuple matched the legacy
 * MATLAB-baked atlas (16 entries). The current `'default'` library has
 * 20 rows. Read names from `getColormapLibrary('default')?.manifest.colormaps`
 * at runtime instead.
 */
export const COLORMAP_NAMES: readonly string[] = []

/** @deprecated Read `getColormapLibrary('default')?.manifest.rows` at runtime. */
export const TOTAL_ROWS = 20

/** @deprecated A free-form `string` now — names are dynamic per library.
 *  Use `string` directly or read the manifest. */
export type ColormapName3D = string

/**
 * A colormap as a CSS `linear-gradient`, sampled from the ATLAS.
 *
 * Prefer `colormapCatalog()`, whose `gradient` is the preview the BAKER wrote into
 * the manifest — this samples the loaded texture instead, which is the same data by a
 * longer route and is here for callers that want a different stop count or direction.
 */
export function colormapGradientCss(name: string, stops = 16, dir = 'to right'): string {
  const lib = getColormapLibrary('default')
  if (!lib) return 'transparent'
  const hit = lib.manifest.colormaps.find((c) => c.name === name)
  if (!hit) return 'transparent'
  const out: string[] = []
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1)
    const [r, g, b] = colormapSampleCPU('default', t, hit.index)
    out.push(`rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(${dir}, ${out.join(', ')})`
}

/** Every colormap the loaded atlas offers, in wire order. Empty before the atlas
 *  has loaded — a caller should fall back to its own list rather than render none. */
export function listColormapNames(): string[] {
  const lib = getColormapLibrary('default')
  return lib ? lib.manifest.colormaps.map((c) => c.name) : []
}

/** One colormap, as a picker needs to show it. Everything here is the BAKER's —
 *  read from the manifest, not re-derived. */
export interface ColormapChoice {
  name: string
  /** `sequential` · `diverging` · `cyclic` · `categorical`. Filters a picker. */
  type: ColormapType
  /** Where the colormap COMES FROM — `matplotlib`, `cmocean`, `colorcet`, `crameri`.
   *  Attribution, and the natural grouping: a library is a design point of view, so
   *  its maps belong together in a chooser. */
  source: ColormapSourceKind
  /** CSS `linear-gradient(...)`, baked beside the texture rows. */
  gradient: string
  description: string
  perceptuallyUniform: boolean
}

/**
 * THE colormap vocabulary — every map the renderer can actually draw, with the
 * preview that IS that map.
 *
 * One list, one source. A UI that offers something else can offer a name the shader
 * cannot draw, or draw a gradient the shader does not produce; both happened while
 * the design system kept a hand-authored set of twelve gradients beside this atlas of
 * fifty (six of the twelve had no row at all and rendered as viridis).
 *
 * Empty until the atlas has loaded — a picker should render nothing rather than
 * inventing a list.
 */
export function colormapCatalog(): ColormapChoice[] {
  const lib = getColormapLibrary('default')
  if (!lib) return []
  return lib.manifest.colormaps
    /* ATLAS LUTs ARE IN THE TEXTURE BUT NOT IN THE PICKER. They must be baked into
       `default` to be drawable at all — every drawable hardcodes
       `createColormapSampler('default')` — but offering a parcellation lookup table
       as a choice for a scalar field is offering a colour ramp that is not one.
       Their only consumers are the atlas tools, which name them directly.

       Filtered on `usage`, not on `type`: `tab10`, `Set2` and `glasbey` are
       categorical too and belong in the picker. */
    .filter((c) => c.usage !== 'atlas')
    .map((c) => ({
    name: c.name,
    type: c.type,
    source: c.source,
    gradient: c.preview ?? colormapGradientCss(c.name),
    description: c.description,
    perceptuallyUniform: c.perceptually_uniform,
  }))
}

/** Names already warned about, so a per-frame resolve does not spam the console. */
const warned = new Set<string>()

/**
 * A colormap NAME → its atlas row, or null when the atlas has no such map.
 *
 * THE resolver — every drawable, colorbar and legend goes through it, and it is the
 * one place a bad name is noticed. Matching is exact first, then case-insensitive,
 * because the atlas ships `RdBu_r` while half the codebase wrote `rdbu_r` and a
 * silent miss there is indistinguishable from a design decision.
 *
 * Returns NULL rather than a fallback row: a caller that draws greyscale on a miss
 * and a caller that draws the first colormap are making different choices, and this
 * function should not make either of them silently. `colormapRow` is the one that
 * decides, and it says so out loud.
 */
export function resolveColormapRow(name: string): number | null {
  const lib = getColormapLibrary('default')
  return lib ? matchColormapRow(lib.manifest.colormaps, name) : null
}

/** The matching RULE, over a given entry list — exported so it can be tested without
 *  a loaded atlas (which needs a fetch and an ImageBitmap). */
export function matchColormapRow(
  entries: ReadonlyArray<{ name: string; index: number }>,
  name: string,
): number | null {
  const exact = entries.find((c) => c.name === name)
  if (exact) return exact.index
  const lower = name.toLowerCase()
  const ci = entries.find((c) => c.name.toLowerCase() === lower)
  return ci ? ci.index : null
}

/**
 * The row to DRAW with: the resolved one, or the first row with a warning.
 *
 * The warning is the point. Falling back silently is what let six UI colormaps render
 * as viridis for as long as they existed — the picture was wrong in a way that looked
 * deliberate, so nothing ever surfaced it. Warned once per name: this runs on every
 * shader rebuild.
 */
export function colormapRow(name: string): number {
  const row = resolveColormapRow(name)
  if (row !== null) return row
  const lib = getColormapLibrary('default')
  if (!lib) return 0   // atlas not loaded yet — the caller redraws when it is
  if (!warned.has(name)) {
    warned.add(name)
    console.warn(
      `[threecharts] colormap "${name}" is not in the atlas — drawing `
      + `"${lib.manifest.colormaps[0]?.name ?? 'row 0'}" instead. `
      + `Offer only names from colormapCatalog().`,
    )
  }
  return lib.manifest.colormaps[0]?.index ?? 0
}

/** Cache: counting runs walks 256 texels, and callers ask per render. */
const levelsCache = new Map<string, number>()

/**
 * How many DISCRETE colours a colormap has — 10 for `tab10`, 8 for `Set2` — or 0 when
 * it is continuous.
 *
 * MEASURED off the atlas row, not declared. A categorical map is baked as flat blocks
 * across the same 256 texels a continuous one ramps over, so the block count is
 * recoverable by counting constant runs, and a consumer that needs to land a group on
 * a block CENTRE (`t = (i + 0.5) / levels`) can ask the colormap instead of keeping
 * its own table. That table existed — `PALETTE_BINS` in the app — and was the last
 * piece of colormap knowledge living outside the atlas.
 *
 * Returns 0 for a continuous map (every texel its own colour), which is what a caller
 * means by "do not quantize".
 */
export function colormapLevels(name: string): number {
  const cached = levelsCache.get(name)
  if (cached !== undefined) return cached
  const lib = getColormapLibrary('default')
  const row = resolveColormapRow(name)
  if (!lib || row === null) return 0
  const { width, data } = { width: lib.imageData.width, data: lib.imageData.data }
  let runs = 1
  const at = (x: number) => {
    const i = (row * width + x) * 4
    return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
  }
  let prev = at(0)
  for (let x = 1; x < width; x++) {
    const c = at(x)
    if (c !== prev) { runs++; prev = c }
  }
  // Every texel distinct → a ramp, not blocks.
  const levels = runs >= width ? 0 : runs
  levelsCache.set(name, levels)
  return levels
}

/**
 * The row a DRAWABLE should sample, or null when the atlas has not loaded yet.
 *
 * Null is not a failure — it means "no atlas", and every drawable answers it by
 * rendering the normalized value as greyscale until the load completes and the shader
 * is rebuilt. A name the atlas does not have is a different thing entirely and goes
 * through `colormapRow`, which warns.
 */
export function colormapRowOrNull(name: string): number | null {
  return getColormapLibrary('default') ? colormapRow(name) : null
}
