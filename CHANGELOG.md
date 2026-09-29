# Changelog

Notable changes. This project is pre-1.0 and the public API is unstable; until
1.0, minor versions may contain breaking changes.

## Unreleased

Extracted from the `nxr-cortical-flow` application into a standalone library.

### Added

- **Domains** — `Domain`, the three-member description of what a field is defined
  on (`count`, `bounds()`, `positionAt()`), with `gridDomain` (rectilinear),
  `meshDomain` (a triangulated surface) and `pointsDomain` (an unstructured point
  set). Several drawables can share one, so a surface and the glyph layers on it
  read one set of vertices instead of a copy each.
- `threecharts/testing` — a GPU harness so a contributed geometry can be verified
  on a real device rather than merely inspected.
- A GPU test suite running in headless Chromium, asserting on buffer readbacks
  rather than pixels, plus a render smoke test for the question readbacks cannot
  ask.
- CI, a build producing ESM and type declarations, `strict` TypeScript, README and
  CONTRIBUTING.
- `contrib/polar` — a polar coordinate system written entirely against the public
  API, as the worked example for adding a geometry.

### Changed

- **`domain` → `clim`** for the colormap value range, across `Image`, `Surface`,
  `Line`, `Fibers`, `Particles`, `Quiver`, `Slice` and `AxesLegend`. MATLAB's name
  for it, and it frees `domain` for the geometric meaning. `setDomain()` →
  `setClim()`, `valueRange()` → `clim()`, `colorbarDomain()` → `colorbarClim()`,
  `LegendEntry.domain` → `.clim`, and `Quiver`'s `lengthMode: 'domain'` →
  `'clim'`.
- `Image` and `Volume` accept a `GridDomain` alongside `rows`/`cols` and `W`/`H`/`D`.
- The public entry is sectioned and 39 single-module internals are no longer
  exported (atlas packing, envelope bucketing, camera framing arithmetic, colormap
  resolution internals, CSS and raster helpers). Every symbol with a known consumer
  is kept.

### Fixed

- **`ChartSession`'s device retry never ran.** It was written to fall back when an
  adapter refuses `maxTextureDimension2D: 16384`, but `renderer.init()` does not
  propagate that rejection — it degrades to the WebGL2 backend and returns — so the
  `catch` was dead code and the session rendered degraded while reporting success.
  Affects any adapter reporting 8192, which the original note calls common on
  mobile.
- **Auto-limits could not see vertex-anchored glyphs.** `Quiver` and `Particles`
  both returned `null` from `dataBounds()` in anchor mode, so an axes framed on
  them alone fell back to default limits. They now answer from their domain.
- **Domains were never disposed**, leaking a position buffer; and a *shared* domain
  must not be disposed by any one drawable, which would leave the others reading a
  released buffer.
- `Particles` allocated its positions as `vec3` while supporting rewrite — the
  combination `Quiver` documents as corrupting on rewrite. Now on the proven
  flat-float path.
