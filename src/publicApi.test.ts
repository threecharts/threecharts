import { describe, it, expect } from 'vitest'
import * as api from './index'

/**
 * A snapshot of the public surface.
 *
 * The `exports` map already stops a consumer reaching `src/` — Node refuses a deep
 * import with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so folder layout is invisible from
 * outside. What it does NOT stop is the surface DRIFTING: a re-export added while
 * solving something else, a rename that silently breaks consumers, an internal
 * helper promoted by accident. Each of those is a one-way door once published.
 *
 * So the boundary is pinned here instead of trusted to convention. Changing it is
 * fine — updating this list is one line — but it becomes a visible diff in review
 * rather than something noticed a version later.
 */
const PUBLIC_API = [
  // object tree
  'Axes', 'Axis', 'ChartSession', 'Clock', 'Drawable', 'Figure', 'GraphicsObject',
  'createFigure', 'logTicks', 'niceTicks', 'REQUIRED_STORAGE_BUFFERS',
  // domains
  'gridDomain', 'isMovable', 'isParametric', 'meshDomain', 'pointsDomain',
  // field data + what a third-party drawable needs to accept it
  'resolveField', 'resolveFieldOrNull', 'asReadOnly',
  // compute
  'reduce', 'mapField', 'mean', 'variance', 'std', 'readValue', 'extent',
  // drawables
  'Arrows', 'Band', 'ClipHelper', 'Fibers', 'Glyphs', 'Image', 'Labels', 'Line', 'Particles',
  'Quiver', 'SignMarkers', 'Slice', 'Surface', 'VertexMarkers', 'Volume',
  'ARROW', 'arrowGeometry', 'colorIndexBuffer',
  // illustrations
  'AxesLegend', 'ScaleBar', 'formatScale', 'pickScaleValue',
  // interaction
  'attachOrbit', 'attachPanZoom', 'attachTimeScroll', 'clampView', 'orbitLookingFrom',
  // selection
  'ActiveSelection', 'attachVertexSelect', 'cloneMask', 'composeMask', 'createMask',
  'createVertexMask', 'createVertexPicker', 'markerBaseHex', 'markerGlowHex',
  'maskBounds', 'maskCount', 'maskFromVertices', 'verticesFromMask',
  // colour
  'COLORMAP_NAMES', 'binaryScheme', 'buildCategoricalLut', 'categoricalColor',
  'colormapCatalog', 'colormapGradientCss', 'colormapLevels', 'colormapSampleCPU',
  'computeRange', 'createCategoricalScheme', 'getColormapLibrary',
  'listColormapNames', 'loadAllColormapLibraries', 'loadColormapIndex',
  'loadColormapLibrary', 'resolveColormapRow', 'resolveContourInterval',
  'schemeFromColormap',
  // geometry + volume utilities
  'buildVertexAdjacency', 'createVolumeTexture', 'disposeVolumeTexture', 'fixedAxis',
  'freeAxes', 'movePlaneTo', 'planeThrough', 'sliceCount', 'sliceExtent', 'sliceUVW',
  'sliceVoxel', 'smoothVertices', 'volumeUVW', 'voxelToSliceUV', 'withClipping',
  // layout, coordinates, capture
  'captureFrames', 'dataToScreen', 'downloadBlob', 'nextFrames', 'padLimits',
  'screenToData', 'subplotRect', 'unionBounds',
].sort()

describe('public API', () => {
  it('exports exactly what it means to', () => {
    expect(Object.keys(api).sort()).toEqual(PUBLIC_API)
  })

  /** Types are erased at runtime, so the list above cannot cover them. This at
   *  least pins that the entry has not become a re-export of everything. */
  it('stays small enough to be a boundary rather than a dump', () => {
    expect(Object.keys(api).length).toBeLessThan(110)
  })
})
