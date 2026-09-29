/**
 * The public API.
 *
 * **Everything exported here is a promise.** Once a version is published, each
 * name becomes something someone can depend on and something we cannot change
 * without breaking them — so the question for any addition is not "is this
 * useful?" but "are we willing to support this shape indefinitely?".
 *
 * The sections below are the intended boundary. Helpers that exist to implement
 * ONE module — atlas packing, envelope bucketing, uniform wrappers, camera framing
 * arithmetic — are deliberately absent even where they are exported from their own
 * file, because a caller who needs them is telling us about a gap in the API rather
 * than about a missing export. Say so in an issue; pre-1.0 is exactly when that is
 * cheap to fix.
 *
 * Test helpers live at `threecharts/testing` — a separate entry so a contributed
 * geometry can be verified on a real device without the harness becoming part of
 * the runtime surface.
 */

/* ── The object tree: session → figure → axes → drawables ────────────────────── */
export { GraphicsObject } from './GraphicsObject'
export { ChartSession, REQUIRED_STORAGE_BUFFERS } from './ChartSession'
export type { FigureSession, ChartSessionOptions } from './ChartSession'
export { Figure, createFigure } from './Figure'
export type { FigureOptions, AxesLike } from './Figure'
export { Axes } from './Axes'
export type { AxesOptions, Projection } from './Axes'
export { Axis, niceTicks, logTicks } from './Axis'
export type { AxisScale } from './Axis'
export { Drawable } from './Drawable'
export { Clock } from './Clock'
export type { ClockListener } from './Clock'

/* ── Field data: a typed array, or a GPU node — never a required GPU node ──────
   `resolveField` is exported for the same reason `Drawable` is: authoring a new
   visual mark is a supported extension point, and a mark that cannot accept a
   `FieldSource` is not one. Exporting the TYPE while keeping the function private
   is the same defect as declaring an option `FieldSource` and never resolving it. */
export { resolveField, resolveFieldOrNull } from './field/source'
export type {
  FieldSource, StorageNode, ShaderNode, FieldElem, Timepoint, ResolvedField,
} from './field/source'
/** A read-only view of an externally-owned storage node — what a drawable binds
 *  when it must not retract the producer's write access. See its own doc. */
export { asReadOnly } from './storage-access'

/* ── Compute: operations on GPU-resident fields ───────────────────────────────
   A reduction returns a one-element FIELD, not a number: most feed another kernel
   and never need to leave the device. `readValue` is the explicit round trip. */
export { reduce, mapField, mean, variance, std, readValue, extent } from './compute/reduce'
export type { ReduceOp, ReduceOptions, VarianceOptions } from './compute/reduce'

/* ── Domains: what a field is defined on — see docs/FOUNDATIONS.md §1.1 ─────────
   Rectilinear, curvilinear and unstructured geometries differ ONLY in
   `positionAt`, which is why a new coordinate system needs no new chart type. */
export type { Domain, MovableDomain, ParametricDomain } from './domain/Domain'
export { isMovable, isParametric } from './domain/Domain'
export { gridDomain } from './domain/gridDomain'
export type { GridDomain } from './domain/gridDomain'
export { meshDomain } from './domain/meshDomain'
export type { MeshDomain } from './domain/meshDomain'
export { pointsDomain } from './domain/pointsDomain'
export type { PointsDomain } from './domain/pointsDomain'

/* ── Drawables ───────────────────────────────────────────────────────────────── */
export { Band } from './Band'
export type { BandOptions } from './Band'
export { Glyphs } from './Glyphs'
export type { GlyphsOptions, GlyphSizeMode, GlyphLayout } from './Glyphs'
export { Image } from './Image'
export type { ImageOptions, ImageMask } from './Image'
export { Volume } from './Volume'
export type { VolumeOptions } from './Volume'
export { Slice } from './Slice'
export type { SliceOptions } from './Slice'
export { Surface } from './Surface'
export type {
  SurfaceOptions, SurfaceShading, SurfaceWireframe, SurfaceCategorical,
  SurfaceContours, SurfaceMinorContours, SurfaceZeroCrossing, SurfaceThreshold,
  SurfaceSelection, SelectionBlend,
} from './Surface'
/* `colorIndexBuffer` is here because a consumer reaches for it, not because it
   reads like API: building a Line's per-channel colour index is something the
   caller currently has to do itself. That is a gap worth closing rather than a
   helper worth documenting — when Line can derive it, this goes. */
export { Line, colorIndexBuffer } from './Line'
export type { LineOptions } from './Line'
export type { LineIndexMode, LineIndexSpec } from './lineIndex'
export type { LineDrawPlan } from './envelope'
export { Fibers } from './Fibers'
export type { FibersOptions, FiberColorMode } from './Fibers'
export { Quiver } from './Quiver'
export type { QuiverOptions, QuiverColorBy } from './Quiver'
export { Particles } from './Particles'
export type { ParticlesOptions } from './Particles'
export { Arrows } from './Arrows'
export { ARROW, arrowGeometry } from './arrowShape'
export type { ArrowsOptions, ArrowSegment } from './Arrows'
export { Labels } from './Labels'
export type { LabelsOptions } from './Labels'
export { VertexMarkers } from './VertexMarkers'
export type { VertexMarkerSpec, VertexMarkersOptions } from './VertexMarkers'
export { SignMarkers } from './SignMarkers'
export type { SignMarker, SignMarkersOptions } from './SignMarkers'
export { ClipHelper } from './ClipHelper'
export type { ClipHelperOptions } from './ClipHelper'

/* ── Illustrations ───────────────────────────────────────────────────────────── */
export { AxesLegend } from './AxesLegend'
export type { LegendEntry } from './AxesLegend'
export { ScaleBar, pickScaleValue, formatScale } from './ScaleBar'

/* ── Interaction ─────────────────────────────────────────────────────────────── */
export { attachPanZoom, clampView } from './panzoom'
export { attachOrbit } from './orbit'
export { attachTimeScroll } from './timeScroll'
export type { TimeScroll, TimeScrollOptions } from './timeScroll'
export { orbitLookingFrom } from './camera3d'
export type { Orbit, UpAxis } from './camera3d'

/* ── Selection: pick vertices on a Surface, no compute required ──────────────── */
export { attachVertexSelect } from './selection/attachVertexSelect'
export type { VertexSelectOptions, VertexSelectHandle } from './selection/attachVertexSelect'
export { ActiveSelection } from './selection/ActiveSelection'
export type { PendingGesture, SelectionSummary } from './selection/ActiveSelection'
export {
  createMask, cloneMask, composeMask, maskCount, maskBounds,
  maskFromVertices, verticesFromMask,
} from './selection/selectionMask'
export type { ComposeOp } from './selection/selectionMask'
export { createVertexPicker } from './selection/vertexPicker'
export type { VertexPicker, VertexPickResult } from './selection/vertexPicker'
export { markerBaseHex, markerGlowHex } from './selection/markerStates'
export type { MarkerRole, MarkerState } from './selection/markerStates'
export { createVertexMask } from './vertex-mask'
export type { VertexMask, MaskSource } from './vertex-mask'

/* ── Colour: the vocabulary, the loaders, and THE resolver ───────────────────── */
export {
  loadAllColormapLibraries, loadColormapLibrary, loadColormapIndex,
  colormapCatalog, colormapLevels, listColormapNames, getColormapLibrary,
  colormapGradientCss, colormapSampleCPU, resolveColormapRow,
  COLORMAP_NAMES,
} from './colormap-node'
export type { ColormapChoice } from './colormap-node'
export { resolveContourInterval } from './contour-node'
export {
  createCategoricalScheme, schemeFromColormap, binaryScheme, categoricalColor,
} from './categorical'
export type { CategoricalScheme } from './categorical'
export { buildCategoricalLut } from './categoricalLut'
export type { CategoricalLut } from './categoricalLut'
export { computeRange } from './raster'
export type { Raster2DScale } from './raster'

/* ── Geometry + volume utilities ─────────────────────────────────────────────── */
export { smoothVertices, buildVertexAdjacency } from './mesh-smooth'
export type { SmoothOptions, VertexAdjacency } from './mesh-smooth'
export { createVolumeTexture, volumeUVW, disposeVolumeTexture } from './volumeTexture'
export {
  freeAxes, fixedAxis, sliceCount, sliceExtent, sliceVoxel, sliceUVW, voxelToSliceUV,
} from './sliceUVW'
export type { SliceAxis, VolumeDims } from './sliceUVW'
export { withClipping, planeThrough, movePlaneTo } from './clip'

/* ── Layout, coordinates, capture ────────────────────────────────────────────── */
export { subplotRect } from './grid'
export type { PositionRect } from './grid'
export { unionBounds, padLimits } from './limits'
export type { Limits, Bounds } from './limits'
export { dataToScreen, screenToData } from './transform'
export { captureFrames, downloadBlob, nextFrames } from './capture'
export type { CaptureOptions } from './capture'
