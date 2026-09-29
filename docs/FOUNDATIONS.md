# FOUNDATIONS — the model this chart system is built on

Recorded 2026-08-22, from the extraction session. Companion to `DIRECTION.md`,
which states what the engine's pieces already ARE; this file states the model
they are being generalised toward, the evidence for it in the current code, and
what remains deliberately undecided.

**Not a plan and not a spec.** Numbered resolutions exist so later work can cite
them ("R7") and so a change that contradicts one is visible as a contradiction
rather than as a preference.

---

## 0. Positioning

**What this is.** A **scientific visualisation and analysis system** — two
co-equal halves over one substrate:

```
charts    geometry-general, GPU-native, spatiotemporal
compute   TSL toolboxes over GPU-resident arrays
          └── both read and write the same `Field` (R13, R14)
```

The compute side is a **companion platform**, not a feature of the charting
side. That is the load-bearing claim, and most of this document follows from it:
the function taxonomy (R22), the sparse/dense split (R23), the graph engine
(R21) and `Field` itself (R13) only make sense if analysis is half the system
rather than something done elsewhere and then plotted.

It is also why the comparison set is VTK, ParaView and MATLAB rather than d3,
Plotly or Vega. **Charting libraries visualise results. This is meant to be
where the analysis happens** — the target user is doing scientific work, not
building a dashboard.

**What this is not.** Not a d3 competitor. d3 is a data-transformation toolkit
— scales, shapes, layouts — that emits SVG. It has no notion of a field defined
on a domain, and that is not a gap in d3; it is a different problem. Where d3's
modules fit (`d3-scale`, `d3-array`, `d3-format`) they should be CONSUMED rather
than reimplemented. What is worth taking from d3 is its modularity and the
consistency of its API grammar, not its feature list.

**What this is.** Nearer to VTK's dataset model with a MATLAB charting API,
GPU-native and in the browser. The MATLAB mapping (`ChartSession` / `Figure` /
`Axes` / `Axis`) is the asset `DIRECTION.md` already commits to; the dataset
model is what this document adds beneath it.

**The axis we compete on.** ParaView optimises for the largest dataset. This
system optimises for the fastest interaction. Those are close to orthogonal.

| their design | ours |
|---|---|
| time step change → pipeline re-executes: re-read, re-filter, re-upload | time step change → one uniform write against resident data |
| dataset larger than one machine's RAM | dataset bounded by device memory |
| install; or remote rendering streaming pixels | a figure that is a URL |
| charts are a weak afterthought | charts and 3-D fields in one figure, one clock, one buffer |

**The band we can own:** interactive, time-varying scientific data with
real-time control, in a browser, with charts and 3-D in one system. Nobody
serves it. Neuroimaging, climate, fluid teaching, sensor networks.

*"Mid-scale" was the original wording and R17 makes it wrong.* The binding
constraint is not raw dataset size but **whether a compact representation and a
frame-rate decoder exist for the data**. Where they do — linear inverse
problems, modal decompositions, low-rank fields — the reachable size moves up by
roughly two orders of magnitude with no change to the interaction model. Where
they do not, the resident window governs. Size is the wrong axis to describe the
band by; decodability is the right one.

**Where the real limits are — and it is NOT GPU memory.** A common error is to
compare their PIPELINE capacity to our RENDER capacity. ParaView never puts 50 GB
on a GPU either: it reduces first (slice, threshold, extract subset, decimate)
and renders what survives, or splits across nodes and composites the images.
Dataset size and rendered size are different numbers everywhere, and
reduce-before-render is the same discipline we use.

The genuine differences sit in the tier BELOW the GPU:

| | theirs | ours |
|---|---|---|
| host staging | ~128 GB workstation RAM | a few GB per tab — and **a tab can be KILLED under memory pressure**; a process cannot |
| random-access I/O | local seek into a monolithic file | HTTP Range / File System Access / OPFS — and CHUNKED formats (Zarr, HDF5) are a better fit for time-series streaming than seeking, because **one chunk is one time window**: the storage layout and the residency window are the same unit |
| distributed render | sort-last compositing over MPI | unavailable — but a different ANSWER to the same problem, not a missing capability (R19) |

Two advantages that offset this and are easy to under-credit. Their
client–server split exists to solve a problem we sidestep: when data is remote
they must either move it to the client (slow) or render server-side and stream
pixels (laggy, and the client cannot compute on anything). A browser with WebGPU
is a THIRD mode — stream a subset, then do real local GPU compute on it. And
time scrubbing compounds with paging rather than being limited by it: their
scrub is slow because each step re-executes the pipeline, which is largely I/O,
whereas we page a window in once and scrub inside it at uniform-write cost.
**Fluid inside the window; page at window boundaries.** Window size, not dataset
size, governs fluidity.

**What we genuinely cannot match:** VTK's format coverage, its ~1000 filters,
distributed rendering, and f64 (WebGPU has none). Two hard numbers to design
against: `maxStorageBufferBindingSize` defaults to 128 MiB and `maxBufferSize` to
256 MiB (raisable toward adapter limits — the `WANTED_TEXTURE_SIZE`
ask-and-fall-back pattern applies); and `REQUIRED_STORAGE_BUFFERS = 8` is the
guaranteed floor `deviceLimits.ts` deliberately pins, of which `flowField.ts`
already spends exactly 8. **A domain model adds binding pressure** — positions,
index buffer, adjacency/Laplacian, field values, masks, anchors — so the packing
discipline that file already documents (`vec2`/`vec3` over separate buffers)
stops being an optimisation and becomes a design rule for domains.

---

## 1. The model

Four ideas, in dependency order.

### 1.1 A domain is a manifold with intrinsic structure

```
domain = addressing            which samples exist, and their index structure
       + laplacian?            intrinsic relations. OPTIONAL — only needed to COMPUTE
```

The addressing is what `[frames × rows × cols]` already is: for a rectilinear
domain **the array shape IS the addressing**, and the strides are the index
arithmetic. That equivalence is why `Image` is 232 clean lines.

It has a hard boundary. A mesh's data is `[N]` — flat. The shape carries none of
the geometry; topology and position live in separate buffers. Every awkward
thing in the current code sits on the far side of that boundary.

### 1.2 An embedding maps a domain into another domain

Positions are **not** part of the domain. They are a map out of it:

```
curve ──embed──▶ surface ──embed──▶ ℝ³ ──camera──▶ screen
```

Embeddings COMPOSE, and the chain terminates in a Euclidean ambient space
because that is what a rasteriser consumes. One domain may have many embeddings
— the same cortical addressing carried by a folded mesh, an inflated mesh, a
registered sphere and a flat map. Morphing between them is interpolating
embeddings, which is a GPU operation and essentially free.

Embeddings are generally NOT isometries. A log axis is a non-isometric embedding
of an interval into the plane. Every question about whether a chart is visually
honest is a question about that relationship.

### 1.3 A field is a section, not an embedding

```
embedding:  domain ──▶ domain      where things ARE     composes to the screen
field:      domain ──▶ values      what things CARRY    terminates at appearance
```

Different species of map. Conflating them is the trap; the next idea is where
they legitimately meet.

### 1.4 Two operations

Every primitive in the system is one of two things:

- **paint** — a field determines APPEARANCE on a fixed embedding
- **place** — a field determines THE EMBEDDING (position, extent, orientation, scale)

| chart | place | paint |
|---|---|---|
| heatmap | fixed lattice | value → colour |
| `surf` | value → z displacement | value → colour |
| scatter | (x,y) → position | third field → colour |
| bar | value → extent | category → colour |
| quiver | vector → glyph orientation | magnitude → colour |
| surface + scalar | fixed mesh | scalar → colour |
| inflated cortex | field → vertex displacement | scalar → colour |

`surf`, `imagesc` and `contour` over identical data are three charts
distinguished only by whether the field feeds **place**, **paint**, or derives a
new domain. That is a consequence of the model, not a per-chart encoding.

---

## 2. Evidence in the current code

The model is not being imposed on working code. The code keeps re-deriving it
locally, and each local derivation costs something measurable.

| # | evidence | cost today |
|---|---|---|
| E1 | `Quiver.ts:325` and `Particles.ts:479` carry the same `_boundsNull` flag with the same comment — *"defer framing to the surface"* | auto-limits cannot see vertex-anchored glyphs. The domain relation is written as a comment and implemented as a `null`. |
| E2 | Six `positionNode` builds — `Quiver` 367/410/455, `Line` 437/454, `Particles` 406 — each an address→position function. Quiver's three branches ARE unstructured / rectilinear-3D / rectilinear-2D. | a new coordinate system means editing every primitive |
| E3 | `xExtent`, `timepoint` and `dims` are each declared independently on five primitives | one extent per drawable, nothing checks that two layers on the same grid agree |
| E4 | `mesh-smooth.ts` is `A = (1−a)I + a·D⁻¹·adj`, applied matrix-free over CSR adjacency, and its own header says **"DOMAIN-FREE: this knows vertices and triangles, not cortices"** | a domain operation with no domain to live on |
| E5 | The two-source array/node contract is written three times — `Quiver.ts:335` (anchors), `Particles.ts:261` (primary data), `vertex-mask.ts` — with the ownership rule re-explained each time | one of six primitives accepts a plain array for its main data |
| E6 | `Axis` holds only `limits`, `label`, `tickCount`, `tickFormat`, `scale`, `tickValues()`; its node is an empty `Group` | it is CHROME — the data model for drawing a ruler — not an addressing scheme |
| E7 | `dataAspect` exists so "a circle renders as a circle" | a conformality constraint on an embedding, discovered before there was a word for it |
| E8 | Zero non-relative imports outside `three/webgpu` and `three/tsl`; "cortex" appears only in prose | extraction was packaging, not disentangling |

---

## 3. Resolutions

**R1 — A domain is intrinsic; positions are an embedding of it.**
Not "carrier + addressing". One manifold, many embeddings. This is what makes
"the same field on the folded, inflated, spherical and flat cortex" a statement
about ONE domain, and therefore what makes morphing between them valid.

**R2 — Rectilinear / curvilinear / unstructured is about TOPOLOGY, not
parametrizability.** The question is whether neighbours are computable from the
index or must be looked up. A sphere meshed lat-lon is curvilinear; the same
sphere as an icosphere is unstructured. The category describes the SAMPLING, not
the manifold. A cortex is unstructured because of how it was meshed, not because
it is Riemannian.

**R3 — Parametric domains are one type whose family is data.** Sphere,
ellipsoid, torus, cylinder, paraboloid, Möbius strip, polar, and every map
projection differ only in a `(u,v) → position` function. One type; the family is
contributed, not built in. This is the extensibility argument in miniature: a
contributor adds a geometry with three lines of maths, touching no core file,
and every existing primitive works on it immediately.

**R4 — The Laplacian unifies topology and metric.** They are the same sparse
operator at different weights:

| rung | operator | encodes |
|---|---|---|
| 1 | graph `L = D − A` | topology |
| 2 | umbrella `D⁻¹A` | topology, normalised — **what exists today** |
| 3 | cotangent `L_cot`, mass `M` | topology + induced metric |
| 4 | connection Laplacian | + tangent frames / parallel transport |

It is uniform across all three categories (a grid's is the 5-point stencil).
From it: geodesic distance (heat method), diffusion, spectral filtering,
geometric eigenmodes, curvature, gradient/divergence, harmonic flattening,
interpolation.

**The operator pays for itself twice.** Its eigenbasis is also a COMPRESSION
basis (R17), so the same machinery that provides geodesics and diffusion
provides a frame-rate decoder for modal-coefficient storage. Analysis capability
and memory capability are one investment, not two. `keepSize` exists because rung 2 ignores area; rung 3 shrinks far
less.

**R5 — The Laplacian is intrinsic and therefore cannot replace the embedding.**
It knows distances and angles, not where anything is. A flat sheet and a rolled
cylinder have the same Laplacian and must render differently. You cannot draw
from `L`.

**R6 — The Laplacian is an optional, lazy, matrix-free OPERATOR.** Not a matrix.
`apply(u) → Lu` plus a mass operator; a grid implements it as a stencil with zero
storage, a mesh from the CSR adjacency that already exists. Everything
downstream needs only matvec plus a solver — which also means it runs on the
GPU. Almost nothing needs it: painting a scalar on a surface needs no metric.
No base drawable may require it.

**R7 — Periodicity and boundary conditions are inputs to the Laplacian, not
separate properties.** A polar domain's θ-wrap is the same fact as "row nθ−1 is
adjacent to row 0". Ignore it and contours break at the seam.

**R8 — For unstructured domains the derivation runs backwards.** Parametric:
intrinsic → embedding. Unstructured: embedding → intrinsic, because cotangent
weights need positions. Consequence: `Surface.setPositions` (smoothing,
inflation) CHANGES THE METRIC and must invalidate any cached `L`.

**R9 — Glyphing is a field parametrising the embedding of a sub-domain.**
`Quiver`, `Particles`, `VertexMarkers`, `SignMarkers`, `Labels` and `Arrows` all
place a sub-geometry at the addresses of a host domain, which is one CONCEPT.

**R9a — But they are not one implementation, and this document said otherwise.**
The original claim — "six classes, ~2,300 lines, one operation with six glyph
shapes" — was made from reading class names. Measured (2026-08-23):

| shared | by |
|---|---|
| `createVertexMask`, the mask `step`, `legendEntry`, `_clim` | `Quiver`, `Particles` — and nothing else |
| camera-facing / billboard maths | `Particles` (12 sites), `Labels` (4), `Quiver` (3), `SignMarkers` (3), `Arrows` and `VertexMarkers` **none** |
| `instanceIndex`, `positionGeometry` | five of six — but that is INSTANCED RENDERING, not an abstraction |

So the real overlap is `Quiver` + `Particles`; `Arrows` builds real 3-D meshes
from `from`/`to` pairs and never places by address; `Labels` is a text atlas.
Merging all six would trade six focused classes for one with six branches — the
over-abstraction §5 warns about, reached by believing a resolution instead of
checking it.

**R9b — The duplication that IS wide is the COLORMAPPED FIELD, and it cuts across
paint and place alike.** Eight drawables carried `_clim`, seven a `clim()`, six a
`setClim` byte-identical between `Line` and `Particles`, five a `legend`. It now
lives on `Drawable`, which already owned the other half of the concern — the
`colormap` override — and splitting one concern across two levels is exactly what
let `Volume` and `Fibers` end up with a range nothing could retarget.

The hook it introduced names a distinction that was previously implicit in which
lines each copy happened to contain: **a range baked into the colour node needs
that node rebuilt; a range held in a uniform is a write that must not rebuild.**
The second is what lets an auto-clim follow the time cursor without recompiling
the shader every frame.

**R10 — Derived domains are filters, and they are the same mechanism as area
charts.** contour: scalar on a surface → a curve domain. isosurface: scalar on a
volume → a mesh domain. streamlines, threshold, and the fill region of an area
chart or streamgraph are all "a domain computed from a field". The ergonomic
requirement and the VTK-rivalling requirement resolve to ONE piece of
architecture: a domain that can be computed from a field, with the dependency
tracked so it rebuilds when the field changes.

**R11 — Time is a domain. Its distinction is that it has TWO embedding
targets.** Every other domain can embed only into space. Time can embed into
space or into the `Clock`:

```
time domain ──embed──▶ a plane's x-axis   →  spectrogram, line plot
            ──embed──▶ the Clock          →  animation
```

**Animation is therefore not a feature bolted onto charting — it is what a chart
looks like when one of its domains is embedded temporally rather than
spatially.** The two are not exclusive: `Axes.cursorX` is the SAME time domain
embedded twice at once, into x as position and into the clock as a sweeping
playhead. Under the old framing that is a special-case widget; here it is one
mechanism, shared with a marker travelling a trajectory.

This is the most-forced case in the codebase, not the least: `timepoint` is
smeared across five primitives (E3), and time already carries more machinery
than any spatial concept — `Clock` with a shared `frameUniform` owned by
`ChartSession`, `[frames × …]` as the leading dimension of every buffer,
`timeScroll.ts` at 672 lines, `cursorX`, and `capture.ts`.

**R11a — Where a dimension is embedded is what names the chart.** For
`time ⊗ space`:

| where the time axis is embedded | result |
|---|---|
| the Clock | animation |
| the x-axis of a plane | spectrogram / carpet |
| a vertical offset per row | ridgeline |
| the container's layout space | small multiples / faceting |

Small multiples are embedding a dimension into LAYOUT rather than into data
space. That is why subplots and divs belong in this picture at all.

**R11b — The Clock is an ambient space.** If animation is an embedding into the
clock, the clock is a one-dimensional temporal world into which time domains
embed, exactly as `Axes.scene` is the spatial world into which spatial domains
embed. Several figures sharing a `ChartSession` clock are several domains
co-located in one temporal ambient — structurally identical to a cortex and a
head mask co-located in one scene. Q1 must therefore be answered once for both.

**R12 — Do not generalise `Axis` into the domain concept.** Per E6 it is the
label layer for a 1-D numeric carrier. `MeshAxis extends Axis` would inherit
`tickCount` and `logTicks`, which mean nothing for a vertex set. A mesh domain
has no `Axis`; it has a scale bar, which the 3-D path already does.

**R13 — Data is a first-class shared object, with array sugar over it.** VTK's
model (reference-counted arrays that mappers point at) at VTK's scale; MATLAB's
model (`plot(x,y)` copies; mutating `x` does not change the figure) at MATLAB's
scale. Both, selected by what the caller passes:

| passed | behaviour | owner |
|---|---|---|
| a `Field` | shared by any number of drawables and figures | the `Field` |
| a raw storage node | used directly; never disposed, never written | the caller |
| a `Float32Array` | wrapped in a private `Field`; `setData()` works | the drawable |

**A hidden internal upload service is the wrong shape** — it would give three
copies of one field for three views of it, and no handle for compute. The
service must be NAMED. `Field` is this system's `vtkDataArray`: the thing filters
and mappers both point at. Its interface matters more than any chart type.

**R14 — One allocation, written by compute and read by rendering, in the same
frame.** MATLAB gathers GPU arrays back to host to plot them. VTK's dataset
model is host-memory-centric. ParaView scales by distributing across nodes. None
of them shares device memory between compute and render — this is the
differentiator, and it is already built. `asReadOnly` is what makes it safe: a
FRESH read-only view, so the producer keeps write access and the consumer cannot
retract it.

**R15 — Two API layers, designed as two on purpose.** The general model
(domains, embeddings, sections, glyphing) belongs UNDER the library. The surface
is `ridgeline()`, `streamgraph()`, `polar()` — recipes shipped as the default
experience. Generality without opinion is a construction kit, which is most of
why people who could use d3 reach for Plotly. The general model earns the
ceiling; the named charts earn the users. The moment the general model leaks into
the common path, the library acquires a reputation it will not shake.

**R16 — Extensibility is the strategy, not the polish.** The gap between a good
engine and a VTK rival is BREADTH — formats, filters, domains, chart types — and
breadth is what an ecosystem produces, never what a small team produces by
working harder. If a contributor can add a domain, a filter or a chart without
touching core, breadth accumulates without us. If they cannot, the ceiling is
however much we personally write. This is why the domain model is not a v2
concern.

**R17 — A `Field` produces values; it need not store them.** Two implementations
of one interface:

```
stored     →  a buffer; read at index
evaluated  →  a small buffer + a kernel; computed at index
```

The general form: a field of dimension `V` over `T` samples, generated by a
CONSTANT operator `G [V × C]` applied to a coefficient stream `S [C × T]`. Dense
storage is `V·T`; factored is `V·C + C·T`. Since `G` does not grow with `T`,
**the compression ratio tends to the field dimension over the operator's rank,
`V/C`.**

One instance, to fix the scale: a linear inverse operator with `V` = 40,000,
`C` = 306, `T` = 10,000 gives ~1.6 GB dense against ~61 MB factored, tending to
≈ 131×. Any constant linear generator has this shape — inverse problems,
modal syntheses, low-rank factorisations, interpolation from a coarse basis.

This generalises well beyond MEG: geometric eigenmodes (R4 — **the Laplacian
eigenbasis IS a compression basis**; 500 modes over 40,000 vertices is 80×),
SVD/PCA truncation, analytic and procedural fields, wavelet- or DCT-compressed
volumes decompressed in-shader, coarse-grid interpolation.

**TSL is what makes it structural rather than a trick.** A drawable reads
`field.at(address)` — a node. Whether that node is a buffer fetch or an inline
`Σₖ G[v,k]·S[k,t]` is invisible to it, so the decoder can be FUSED into the
consuming shader and the dense form need never exist at all.

**R17a — Fuse or materialise is a strategy, not an API difference.**

| | when it wins |
|---|---|
| fuse — decode inside the consuming shader | one reader; memory tight; decode cheap |
| materialise — one compute pass per timepoint into a dense buffer | several drawables read the same field (surface + quiver + trace over one `J`) — decode once, read many |

For a 40,000-vertex cortex that is ~12 M multiply-adds per frame to materialise:
nothing for a GPU, and clearly right when three views share the field.

This is R10 with laziness added. Derived DOMAINS are filters; derived FIELDS are
filters too, and fuse-vs-materialise is whether the filter is evaluated lazily or
eagerly.

**R17b — The memory question changes shape.** Not "how much data fits on the
device" but **"how much of a compressed representation fits, given a decoder that
runs at frame rate."** VTK and ParaView largely cannot ask this: they have
implicit functions and procedural sources at the edges, but the dataset
abstraction is materialised arrays and the pipeline moves them. A field that is a
kernel plus a small buffer, decoded on the GPU at read time, is not a thing their
model expresses. Together with R14: one allocation, written by compute and read by
rendering — **and it need not hold the data in the form being looked at.**

**R18 — Data transport is NOT this library's concern.** The boundary is `Field`.
Above it sits a loader layer — Zarr, HDF5, NIfTI, DICOM, HTTP range — that
PRODUCES Fields and ships separately. Keeping format code out of core is what
stops the core growing without bound, and it is precisely where contributors add
support without touching it (R16). Being operable in a browser must not be
mistaken for being tied to web data transfer: chunked stores work identically
over local disk and over the network.

**R19 — Distributed rendering is a different ANSWER, not a missing capability.**

How it works, so it need not be re-derived. Parallel renderers are classified by
where the sort happens (Molnar et al., 1994). **Sort-first** partitions the
SCREEN — each node owns a tile and geometry is redistributed to whoever owns the
tile it lands in; every camera move reshuffles geometry, and it balances badly.
**Sort-last** partitions the DATA — each node holds a subset, renders it to a
full-size framebuffer WITH DEPTH, and the framebuffers are merged by depth
comparison. ParaView uses sort-last (via IceT), because the data never moves —
it is already distributed, since the simulation that produced it ran on those
nodes — and the cost is independent of data size: pixels, not cells.

The composite is the clever part. Naively every node ships its framebuffer to
one merger: `O(N × pixels)` on a bottleneck. **Binary swap** instead pairs nodes
over `log₂N` rounds; each pair exchanges half its image and each node keeps and
composites only the half it owns, so per-node traffic stays roughly constant in
`N`. Radix-k tunes message count against message size; 2-3 swap handles
non-powers-of-two.

**Transparency is what makes it hard.** Opaque depth compositing is exact and
ORDER-INDEPENDENT — nearest fragment wins, so nodes merge in any order. Blending
is not commutative, so transparency needs a valid back-to-front node ordering,
which ParaView gets from a k-d tree decomposition recomputed as the camera
moves. Parallel volume rendering is mostly this problem.

**What WebGPU can and cannot do.** The per-node parts are comfortable: render to
an offscreen texture; get depth out (`depth24plus` is NOT copyable — use
`depth32float`, or write depth to an `r32float` colour attachment); composite in
a compute shader, which is ideal work for it. The between-node parts are absent:
no GPU-to-GPU communication of any kind (no NCCL, IPC, RDMA or GPUDirect), so
every exchange is GPU → CPU (`mapAsync`, ≥ a frame of latency) → network → CPU →
GPU; no MPI, leaving WebSockets/WebTransport/WebRTC. **Multi-GPU is not even
exposed on ONE machine** — `requestAdapter()` returns *an* adapter with a
`powerPreference` hint, with no enumeration. The arithmetic settles it: 1080p
RGBA8 + depth32f ≈ 16.6 MB, so binary swap over 8 nodes moves ~25 MB per node
per frame. IceT does that over InfiniBand at 100+ Gb/s with RDMA; we would do it
over WebSockets at ~1 Gb/s with a readback and a re-upload each round.

**Why we do not want it anyway.** Sort-last exists to solve one problem — the
data does not fit on one node — and there are exactly two answers:

| | |
|---|---|
| **distribute** the data and composite the images | ParaView |
| **reduce** the data until it fits and render locally | us — "fluid inside the window, page at boundaries" (§0), plus R17's decoders |

They are alternatives, not a ladder. Building distributed rendering would mean
adopting the other answer in the environment least suited to it.

**R19a — Distributed COMPUTE is the thing worth wanting.** Run the heavy work
— filtering, decimation, spectral decomposition, timestep extraction — on a
server or cluster; stream the reduced result; interact locally at uniform-write
cost. No pixel compositing at all, and it PRESERVES the advantage instead of
trading it away: ParaViewWeb streams pixels because its client cannot compute,
whereas ours can. Since WebGPU runs headless in Node via Dawn, the server-side
reduction can run THE SAME LIBRARY — one codebase, headless for reduction and
in-browser for interaction, with `Field` as the wire format between them. This
is the same requirement as the headless constraint in §5, reached from the other
direction.

**R20 — An application is a WITNESS, not a template.** `DIRECTION.md` already
states this rule about `CortexLayerState`: *"It works and should keep working; it
is not the thing to generalise from."* It applies to every part of the app,
including its compute layer, and it is easy to violate because working code is
persuasive.

What an application can supply:

- **Feasibility, with numbers.** A `[K × V]` analysis/synthesis pair measured at
  ~33 M multiply-adds in **0.04 ms** settles whether modal decode (R17) is
  viable at interactive rates. That is a fact about GPUs, not about cortices.
- **A requirement.** "Filtering in the coefficient domain and expanding only for
  display" is a general pattern; the application is where it was first needed.
- **A counter-example.** Where the app had to work around the engine, the engine
  is wrong (§2 is entirely this kind of evidence, drawn from the charts package
  itself).

What it must NOT supply:

- **Names.** An application names things for its domain — `lboAnalysis`,
  `flowModesToScalar`, `sensorsToSources`. The library's vocabulary comes from
  what scientific computing needs (R22), not from what one study needed first.
- **Organisation.** Its module boundaries follow its own screens and workflows.
- **Scope.** Which operations exist is decided by the function taxonomy, not by
  which ones happened to be written already.

So the compute work is a **design**, informed by a working proof. Existing
pipelines are a source of requirements and a test corpus — "can the general API
express this?" — never a starting structure to lift. The test in R22f is the
sorting mechanism: what can be rewritten in the public API is a toolbox, what
cannot is either a genuine primitive or an API gap.

**R21 — The graph engine has three jobs.** The engine, not the editor, is the
valuable part.

1. **Typed edges — and the type system IS the domain model.** An edge carries a
   field on a domain, so connection validity is domain compatibility, checked
   before dispatch. Over untyped buffers a graph can validate nothing.
2. **Fusion.** A naive graph is one dispatch and one buffer per node. TSL is
   already a node graph that compiles to ONE shader, so map chains must fuse and
   only genuine barriers materialise. Same choice as R17a, one level up.
3. **Dependency tracking and CSE.** `jointPower.ts` records a manual
   common-subexpression elimination: two consumers of one window "became one
   chain with two consumers. Before that they each projected and filtered their
   own identical `[800 × 1024]` window." A graph makes shared subexpressions
   structural instead of a refactor. A node has two properties: **execution
   class** (map/gather/reduce/scan/sort/global), which decides whether it fuses
   or forces a barrier, and **executor** (GPU/WASM/CPU).

**R21c — There is no "rate"; the distinction is EXPRESSION vs MATERIALISATION.**
A TSL node is an expression, not a task: it fuses into a shader and carries no
schedule. A `timepoint` is a UNIFORM, so a shader reading `buffer[t·N + i]` does
not re-run when `t` changes — it was running this frame regardless and reads a
different slice. That is the whole `timepoint` advantage (R14), and nothing in
the engine may contradict it.

Only a **materialisation point** — a compute pass that writes a buffer, which
happens only at barriers (reduce, scan, sort, FFT, gemm) — has a "when does this
run again" question, and those are few. Even there it is ordinary dependency
tracking, not a scheduler: `jointPower`'s window passes re-run rarely because
their input is `floor(t/NT)`, not `t`. **The coarsening lives in the DATA.** A
node does not declare how often it runs; it depends on what it depends on.

**R21a — Charts are the debugger for the graph.** Every intermediate is already
GPU-resident and already has a domain, so inspecting an edge IS plotting a field
— hover a wire for min/max/NaN count, a histogram, or the field rendered on its
domain. In a notebook intermediates are arrays you must fetch; in ParaView they
are pipeline outputs needing an explicit view. Here it is the native operation.

**R21b — Engine before editor; code-first with the GUI as one front-end.** A
visual editor is easily as much work as the chart engine (React Flow gives a
canvas, not a type system, layout, undo or inspection). If the compute API is
reachable only through the GUI it is a toy. Also: always ship graph → code
(Houdini's lesson), plan for subgraphs (node graphs go spaghetti past ~30 nodes),
and note that a saved graph IS a provenance record — structural, not a log.

**R22 — The function set needs TWO taxonomies.** MATLAB organises by
mathematical role because on a CPU `x+1` and `sum(x)` are both `O(n)`. On a GPU
they are utterly different — a fused map that costs nothing, versus a multi-pass
tree reduction with a barrier. So every function has a **role** (what the user
searches for) and an **execution class** (what the engine schedules on). The user
never sees the second; the engine cannot work without it.

| tier | class | functions |
|---|---|---|
| 0 construction & shape | view/map | `zeros ones full eye linspace arange rand randn` · `reshape permute transpose squeeze cat slice take flip tile` |
| 1 elementwise | map | arithmetic, comparison, logical · `sin cos exp log pow sqrt abs sign floor ceil round mod clamp where isnan` · complex `real imag conj angle` |
| 2 reductions | reduce | `sum prod min max mean median std var any all nnz argmin argmax norm` — **along an axis** |
| 3 scans | scan | `cumsum cumprod cummax diff` |
| 4 sort & select | sort | `sort argsort topk unique searchsorted histcounts` → unlocks `median percentile quantile` |
| 5 linear algebra | global | `gemv gemm` · `solve chol cg` · `eig svd` via Lanczos/LOBPCG for top-K |
| 6 signal | mixed | `fft ifft rfft fftshift conv fir hilbert envelope window stft psd coherence resample interp1` |
| 7 manifold | mixed | `laplacian gradient divergence curl geodesic heat diffuse spectralFilter eigenmodes resampleTo` |
| 8 statistics | reduce/sort | `corrcoef cov zscore regress histogram quantile` |

Tier 7 is what MATLAB does not have and where the differentiation lives. Tiers
0–4 are what everything else is written in.

**R22a — Reducing over a domain removes it from the product.** `mean(J, time)` →
a field on space; `mean(J, cortex)` → a field on time. Not sugar: it is the type
rule, it is checkable, the result's domain is DERIVED, and it is one of the
operations Q3's broadcasting rule must define. MATLAB's positional `dim` becomes
a name.

**R22b — Shape ops are lazy VIEWS.** `reshape`/`permute`/`slice`/`flip` are index
remappings folded into the consuming kernel's indexing, costing nothing until
materialised. Tier 0 appears inside everything, so it must be free.

**R22c — Hard on GPU, and worth promising carefully:** `median`/`quantile` (need
Tier 4 first); **IIR filtering** (a sequential recurrence — FIR is a convolution
and is fine; this is the one people expect and get wrong); dense `eig`/`svd` (use
Lanczos/LOBPCG for top-K); sparse direct solve (use CG); data-dependent control
flow.

**R22d — Design for what is newly CHEAP, not for parity.** Elementwise over 10⁷
elements per frame; iterated operator application (diffusion, power iteration,
relaxation) where MATLAB loops are slow; recompute instead of cache; **the whole
pipeline at 60 Hz.** Dragging a spectral kernel's parameters and watching the
cortex respond continuously is not a faster MATLAB — it is an interaction MATLAB
cannot express. Port the vocabulary; do not port the cost model.

**R22e — Naming: one convention, documented.** MATLAB semantics with MATLAB
names where they are clear, NumPy-ish where MATLAB's are cryptic (`mldivide`,
`bsxfun`). Publish the mapping table so a MATLAB user can search by the name they
know. Prefer boring names — `mul`, not `elementwiseMultiply`.

**R22f — The acceptance test for toolboxes.** A contributed function must be
INDISTINGUISHABLE from a built-in — same registration, typing, fusion,
inspectability (R16). The test:

> **Every function from Tier 2 upward must be implementable in the public API.**

If `zscore` needs private access, the API has a hole and no contributor can write
its equivalent. This also gives the migration path for the existing 7,650 lines:
what can be rewritten in the public node API becomes a TOOLBOX; what cannot is
either a genuine primitive or an API gap. Sorting the existing pipelines into
those three buckets defines Tier 0–4 faster than designing it in the abstract.

**R23 — Sparse work is a PRECOMPUTE that produces operators; the GPU applies
them over time.** C++ (WASM in the browser, a native addon in Node) does sparse
linear algebra and eigensolves; TSL does everything dense and repeated. The
boundary is principled rather than a taste call, because **what a stage depends
on decides both where it runs and how often**:

```
C++/WASM   sparse solve       depends on the mesh       → operators
GPU        project a window   depends on the selection
GPU        filter, FFT        depends on floor(t/NT)
GPU        synthesise, draw   depends on t — a uniform, so free
```

The last line is the point: it is not "frame-rate work", it is work that costs
nothing extra to redo, because its time dependence is a uniform (R21c).

Each tier hands DENSE operators down to the next. The pattern generalises:
cotangent assembly → `L`, `M`; mesh registration → a sparse interpolation matrix
applied on GPU forever after (this is how "the same field on two domains" gets
implemented); exact geodesic precompute; decimation, remeshing, flattening;
connected components and shortest paths.

**R23a — Therefore core needs NO sparse linear algebra.** `Φ` and `λ` arrive as
Fields; a WASM solver is a PRODUCER of Fields, structurally identical to a Zarr
reader (R18). Both sit above the `Field` boundary. But it needs a DEFAULT ANSWER
— if "how do I get `Φ` for my mesh" is answered with "bring your own
eigensolver", the differentiating capability has no on-ramp. An optional
companion package: not core, not absent.

**R23b — One genuine fork: factored solve versus CG.** The heat method wants
repeated solves of `(M − tL)u = b` with a fixed operator. Factor once in C++ and
back-substitute — but **triangular solve is sequential**, so that is a CPU round
trip per query. CG on the GPU needs no factorisation, only repeated spmv, which
is embarrassingly parallel. For an operator applied interactively, iterative-on-
GPU may beat factored-on-CPU precisely because the factorisation's payoff is a
sequential solve. Measure rather than assume.

**R23c — Precision is decided upstream.** Sparse solves run in f64 and the
operator is downcast to f32 for the GPU. Normally fine — the operator is already
a truncated approximation — but the accuracy budget is set at the C++ stage and
the GPU application adds accumulation error on top. Pairwise or Kahan summation
in the gemv is worth having at large `K`.

**R23d — The stack is dual-target by construction.** C++ → WASM (browser) or
native addon (Node); GPU → WebGPU (browser) or Dawn (Node). The ENTIRE pipeline
therefore runs identically in a browser tab, a notebook, and a headless batch
job. The §5 headless requirement and R19a are satisfied by the architecture
already chosen rather than as extra work. The escape hatch — an eigensolve of an
operator modified at runtime — breaks the one-way flow and needs GPU → readback →
solve → upload. Legitimate, slow, and it should be obviously expensive rather
than silently so.

---

## 4. Open questions

Deliberately undecided. Each has consequences; none should be settled by
default.

**Q1 — Is the ambient space just another domain, or a privileged terminal
object?** Uniform recursion is elegant; a terminal object is where the camera,
lighting, clipping and picking naturally live. Decides whether "world space" is
a special case in the code or merely the last link.

**Q2 — Is `place` a general field→embedding map, or a fixed set of channels
(position, offset, scale, orientation)?** The general form is what makes derived
domains possible. The channel form is what every grammar-of-graphics library
actually ships, because it is finite, documentable and typeable. This decides
whether the system reads as a research instrument or as a library.

**Q3 — What is the broadcasting rule for fields on different sub-products?**
Time being a domain (R11) is settled; PRODUCT DOMAINS are the commitment, and
this is their hard part. Not every field on a chart lives on the same product —
on an animated cortex, vertex positions are on `space`, the scalar is on
`time ⊗ space`, a mask is on `space`, a threshold is on neither. Four fields,
four sub-products, one draw. numpy and xarray solve this; we need our own
answer, and it is a design surface rather than a detail.

**Q3a — Memory layout is a policy the library cannot fix, and we already ship
both.** `[frames × channels × samples]` is time-major — one frame contiguous,
ideal for animation. `Line`'s windowed mode takes `[channels × totalSamples]` —
channel-major, ideal for drawing one channel's whole history. Same product
domain, two orderings, chosen by use case.

**Q4 — Is a domain a coordinate system or a sample set? — ANSWERED 2026-08-23.**
A plane's carrier is continuous; a mesh's vertex set is irreducibly discrete, and
interpolation makes it continuous only via a choice.

`Band` forced it, because a filled region's boundary sits BETWEEN samples at a
height the data picks. The answer is **both, and the difference is a capability**:
`Domain` keeps its three members and describes a sample set, while
`ParametricDomain` adds `positionAtUV(u, v)` for domains that can also be
addressed continuously. A lattice and a polar domain supply it trivially — polar's
`positionAt` was already a continuous function merely sampled at cell centres — and
a MESH cannot, so `Band` rejects one at construction rather than drawing something
plausible and wrong.

So the type neither papers over the distinction nor forces it on everyone: it is
checked where it matters. Answered by ADDING a capability rather than by changing
what a domain fundamentally is, which is what §5's tripwire asks for.

**Q5 — Does a domain own its GPU representation?** If it holds the vertex
buffer, lattice and extent uniforms, "same field, two domains" is cheap and the
ownership contracts consolidate — but the domain becomes a GPU resource with a
lifetime, which is much heavier than a coordinate description.

**Q6 — Is layout the same mechanism as embedding, or deliberately separate?**
R11 says subplot placement IS an embedding. But `Axes.margins` are fixed CSS
pixels, chrome reserves bands, and layout must survive a resize. Unifying them
puts pixel-margin logic inside the differential geometry.

---

## 5. Constraints and tripwires

**The three-member contract is both the design and the tripwire.** A domain is
an addressing, an optional Laplacian, and the means to embed. If a proposed
domain needs a fourth member, ask whether it belongs to the drawable instead —
colormap, opacity, glyph scale and line width will all try to migrate in. When
an interface's implementations differ in exactly one method it is real; when
they differ in fifteen it is a fiction.

**A `Field` must not assume its extent is its residency.** The library's
constraint is narrow and structural: a `Field`'s logical shape and the bytes
currently on the device are separate facts, and the API must never conflate
them. WHETHER a producer streams, pages, decodes (R17) or uploads everything at
once is that producer's business, above the `Field` boundary (R18) — the library
neither implements nor mandates a strategy. What it must do is not foreclose
one, because an API that assumes full residency cannot be retrofitted.

**Compute belongs in the library, not in the app.** "Computational toolbox with
a rendering layer" makes kernels-over-`Field`s a public API. That is VTK's
FILTER concept and it is the difference between a renderer and a system.

**Headless is a sleeper requirement.** Scripted, reproducible figure generation
is most of what ParaView's Python shell is for; browser-only locks us out of
every publication pipeline. WebGPU runs under Node via Dawn, but only if nothing
in the core assumes a DOM — and `Figure` takes an `HTMLElement`, while
`AxesOverlay` draws chrome into it. Cheap to keep clean now, expensive to unpick
later.

**Do not unify layout with data geometry** (see Q6), **do not build curvilinear
on speculation** (no real case is in hand yet; design so it obviously fits, and
let the first polar chart force it), and **do not do time yet** (Q3 is the most
tempting generalisation and the least forced).

---

## 6. What has been built, and what it settled

Recorded 2026-08-22, after the first implementation pass. This section exists so
the resolutions above can be read as TESTED or UNTESTED rather than uniformly as
intent.

### The contract held, on both categories

`Domain` shipped with exactly the three members §1.1 proposed — `count`,
`bounds()`, `positionAt(index)` — and needed no fourth across three
implementations:

| | category | `positionAt` |
|---|---|---|
| `pointsDomain` | unstructured | reads a flat-float buffer |
| `meshDomain` | unstructured + topology | delegates to `pointsDomain` |
| `gridDomain` | rectilinear | computed from strides, **allocates nothing** |
| `contrib/polar` | curvilinear | `(r, θ) → (r cos θ, r sin θ)` |

**R2 is confirmed:** all four differ only in `positionAt`. And the rectilinear
case's no-allocation property is the practical form of §1.1's claim that for a
lattice the shape IS the addressing — a 40-million-cell grid costs three numbers.

`isMovable(domain)` was added, and is a CAPABILITY CHECK rather than a fourth
member: not every domain owns writable positions.

### R16 was tested rather than asserted

`contrib/polar` is a coordinate system written entirely against the public entry,
imported by package NAME so an unexported dependency would fail the build rather
than be rescued by a deep path. **Zero files under `src/` changed**, and a
`Quiver` that predates polar by every commit draws on it.

The exercise found one real gap, since closed: the GPU harness was not exported,
so a contributor could check that they built the node graph they meant to build
but never that it evaluates correctly. `threecharts/testing` exists because of it.

### `positionAt` has ONE consumer class — which is §1.4

`Image` does not address positions per sample at all: it draws one quad and lets
the rasteriser interpolate. So the interface divides along the two operations this
document derived from theory:

| | needs | drawables |
|---|---|---|
| **paint** | `count`, `bounds()` | Image, Surface, Volume, Slice |
| **place** | `count`, `bounds()`, `positionAt()` | Quiver, Particles, Labels, Markers |

`count` and `bounds()` are universal; `positionAt` serves one half. That the split
derived from theory is the split the code asks for is the strongest evidence §1.4
is real — and it is where the interface would divide if it ever needs to.

### Two rules the implementation forced

**Infer where the shape determines the geometry; require where it does not.**
`Image` and `Volume` take `rows`/`cols` and `W`/`H`/`D` as before, inferring a
lattice, because a raster's shape is unambiguous. An `[N × 3]` anchor buffer is
not, so glyph layers must be given a domain or explicit extents.

**A drawable frees a domain it MADE and never one it was HANDED.** The rule
`Surface` already applied to geometry. The dangerous direction is the second: a
shared domain freed by any one drawable leaves the others reading a released
buffer, with the symptom appearing in a layer nobody touched.

### Still theory

R4–R8 (the Laplacian, its rungs, periodicity), R10 (derived domains), R11 (time
as a domain), R17 (generated fields), R20–R23 (the compute engine, the graph, the
function taxonomy, the sparse/dense split) are unbuilt. Q1–Q6 remain open, and
nothing built so far has forced any of them — `positionAt` still lives on the base
interface even though R1 says positions are a map OUT of a domain, because one
embedding per domain has been sufficient. That is the seam to watch.

---

## 7. Tentative decisions — recorded, NOT implemented

Reached 2026-08-23. **Nothing below is in the code.** The package is
`threecharts` (renamed from `@nxr/charts`) and `license` is still `UNLICENSED`. These are written down so they
are not re-argued from scratch, and so the reasoning survives if the conclusion
is later reversed.

### Name: **Kartos** (tentative)

From Greek *khartēs*, the root of "chart" — and in differential geometry a CHART
is precisely a coordinate map, while an ATLAS is a set of charts covering a
manifold. The name therefore states the library's central idea (§1.1: a
coordinate system is a geometry) to a reader who knows the mathematics, while
reading as an invented brand to everyone else.

Chosen against a criterion the first name did not have to meet: **it must be
trademarkable**, because a permissive open core is defended by the MARK, not by
the licence (see below). Coined words are the strongest trademark class;
descriptive names — `GPUCharts`, `SciViz` — are weak or unregistrable, and date
badly once WebGPU stops being the novel part. Note `SciChart` is an existing
commercial product in this space.

Free on npm at the time of writing, as are `chartos`, `kartix`, `cartan`,
`hodge`, `weyl`, `betti` and `foliation` — the runners-up. Scope strategy would
be `@kartos/core`, `@kartos/compute`, `@kartos/pro`, which is also the shape the
open/paid split wants.

**Outstanding before this is real:** trademark search (USPTO and EUIPO, classes 9
and 42), domain availability, and a check for collisions on PyPI, GitHub and in
the scientific-visualisation literature. npm availability is the easiest filter
to pass and the least meaningful.

### Licence: **Apache-2.0** for the open core (tentative)

Three facts decide this.

**A licence choice is free of `three`.** `three` is MIT — permissive, with no
share-alike provision — and it is a peer dependency left EXTERNAL by the build,
so `dist/index.js` (260 KB) does not contain it and the attribution obligation
never attaches to our distribution. Any licence is available to us.

**Permissive is what R16 requires.** Dual-licensing under AGPL, or going
source-available, would protect revenue better — and both reduce contribution,
which is the mechanism this document says breadth depends on. Dual-licensing
specifically mandates a **CLA**, since you can only sell licences to code you
own, and many contributors (academics especially) cannot sign one. A permissive
core needs no CLA at all.

**The patent grant is what tips Apache-2.0 over MIT**, and only because there is
an intended commercial tier. It runs both ways: the contributor-side grant stops
someone contributing code and later asserting a patent over it, which matters far
more once there is something to assert against. The cost is real and should be
stated: **Apache-2.0 is incompatible with GPLv2** (GPLv3 is fine), and the
neuroimaging neighbourhood is GPL-heavy. If downstream GPLv2 compatibility ever
matters more than patent exposure, MIT is the correct answer instead.

### The monetisation model this assumes

**Open core under a permissive licence, paid features as SEPARATE proprietary
packages** — not a restricted tier of the same code. The licence then protects
nothing about the paid layer, and does not need to: it is code that is simply not
published. Plausible seam: the engine, domains, primitives and the Tier 0–4
compute vocabulary (R22) free; the node-graph editor (R21b), the advanced
toolboxes, hosted compute and collaboration paid. Those are APPLICATIONS OVER the
library rather than the library, so they carry no tension with R16.

Two things actually protect that position, and neither is the licence: **keeping
the paid layer in its own repository from the start** (retrofitting a split is
much harder), and **the trademark** — a fork may take the code but not the name.

### Blocking check

**Institutional IP.** If this was developed under a university or hospital
appointment, the employer may own or co-own it, and many research institutions
require disclosure before open-sourcing. That matters more with a commercial tier
than without one, and it cannot be undone after publishing. Note the asymmetry
generally: future versions can always be relicensed, but anyone who received an
earlier version keeps their rights and may fork from that point — which is why
the FIRST public release is the decision that sticks.

---

## 8. API review — the approach layer

Reviewed 2026-08-23, from a user's point of view rather than a reader's. The model
underneath (§1) held up; everything here is about the layer people actually type.

### The measurement

The shortest path from a `Float32Array` to a picture, verified by running it — no
`ChartSession`, no colormap load, no `start()` needed:

```ts
import { createFigure, gridDomain } from 'threecharts'
import { attributeArray } from 'three/tsl'          // a package they did not choose

const fig = await createFigure({ container })
const ax  = fig.subplot(1, 1, 0)                     // for a SINGLE plot
ax.image(attributeArray(v, 'float'),                 // what is 'float'?
         gridDomain([cols, rows], [[0,cols],[0,rows]]))   // data is [rows][cols]
```

Eight concepts before anything appears, against `plt.imshow(v)`, `imagesc(v)`, or
`Plotly.newPlot(d, [{z: v, type: 'heatmap'}])` for the same picture. **The problem
is ceremony and leakage, not the names.**

### R24 — TSL is the implementation; it must never be the entry fee

**DONE** for `Image`, `Surface.scalar` and `Quiver`. `FieldSource` names the
contract and `resolveField` states it once; a GPU node is still ACCEPTED — that is
R14, the reason this system exists — but never REQUIRED. Two decisions are pinned
by test: a caller's array is COPIED rather than aliased (mutating it afterwards
must not silently change the chart, as MATLAB does when `plot` captures its
arguments), and `setData` refuses to write a buffer we do not own.

Still on `unknown`: `Line`, `Particles`, `Volume`, `Slice`, and the
`timepoint`/`values`/`sizes`/`rowMap` options.

### R25 — `fig.subplot(1, 1, 0)` is the wrong first step, twice over

**Zero-based**, where MATLAB's `subplot` is one-based: a MATLAB user types
`subplot(1,1,1)` and gets `RangeError: subplot index 1 out of range [0, 1)`. Loud
rather than silent, which is something, but it is the most natural thing for the
target audience to type.

**And there is no way to say "just one axes"**, because `axes` is already taken as
a GETTER returning the list. That collision is what forces grid arithmetic on
people who do not want a grid. Freeing the verb (`fig.children` for the
collection) and making `subplot` one-based are both small changes.

### R26 — six shape conventions, and one of them is transposed

```
image(buf, rows, cols)   volume(buf, W, H, D)    line(buf, channels, samples)
quiver(buf, rows, cols)  particles(buf, count)   fibers(points, nPoints)
```

Positional, unreadable at the call site, and in `Quiver`'s anchor mode `N` is
passed as `rows` with `cols = 1`. `gridDomain` compounds it by taking
`[cols, rows]` while the data is `[rows][cols]`. **Shape belongs in a named option
in DATA order** — `{ shape: [rows, cols] }` — never positional, never transposed.

### R27 — the named-chart layer does not exist

R15 calls for two layers: the general model underneath, recipes on top. Only the
bottom one was built, so every user pays research-instrument prices for a heatmap.

**R27a — "gallery" and "API" are different questions, and conflating them is a
mistake this document made.** An earlier draft claimed a tension between shipping
named charts and staying a primitives library, citing d3 as the contrast. There is
no tension. d3's gallery holds hundreds of named charts; `d3.barChart()` does not
exist. Those are RECIPES to copy and adapt — documentation, not API surface. The
real question is only WHERE the named charts live, and there are three answers:

| | strength | failure |
|---|---|---|
| **API functions** (Plotly, `plt.bar`) | discoverable, one line for the common case | each is a permanent commitment whose options accrete until the option bag is its own configuration language — and there is a CLIFF: when the function does not fit, you fall all the way back to primitives |
| **gallery recipes** (d3) | zero API surface, infinitely adaptable — you own the code | nothing is a one-liner; beginners bounce off |
| **a thin separate layer on the public API** | discoverable AND adaptable | none yet identified |

**R27a-bis — and we are already at PLOT's altitude, not d3's.** d3's own
`what-is-d3` states it plainly: *"D3 is not a charting library in the traditional
sense. It has no concept of 'charts'"*, and *"D3 makes things possible, not
necessarily easy; even simple things that should be easy are often not."* Its
stacked-area example composes a CSV parser, a time scale, a linear scale, an
ordinal scale, a stack layout, an area shape, axes and selections. Ours is
`ax.image(v, { shape })`, with axes, ticks, colormap and camera handled.

So the tiers are not `primitives → Plot`. They are:

```
low-level     author a new DRAWABLE — a visual mark that did not exist
mid-level     image / surface / quiver on domains      ≈ Plot's altitude
high-level    named charts: ridgeline, streamgraph      compositions
gallery       worked examples, forkable, no commitment
```

**The named layer is therefore less urgent than R27 implies, and its content is
different.** It is not sugar for things that are already one call — `heatmap()`
would be a pointless alias. It is for genuine COMPOSITIONS: several drawables plus
arrangement logic.

> **Decision rule: if it is already one call, it is a gallery entry. If it is a
> composition of several drawables with real arrangement logic, it is a named
> chart.**

**R27d — the LOW-LEVEL tier is the one actually missing, and it is what drives
adoption.** d3's reach comes from people building things its authors never
anticipated; that requires the bottom tier to be genuinely open. There are three
extension axes and we have evidence on only one:

| axis | question | status |
|---|---|---|
| a new GEOMETRY | can someone add a coordinate system? | **proven** — `contrib/polar`, zero core changes |
| a new DRAWABLE | can someone author a visual mark? | **untested, and known incomplete** |
| a new CHART | can someone compose one? | untested |

The second is measurably incomplete: `Drawable` is exported, but `resolveField`
and `asReadOnly` are not — so a third-party drawable can subclass the base class
and then has no way to accept a `FieldSource`. The TYPE is public and the function
that fulfils it is private, which is the same defect as declaring an option
`FieldSource` and calling `asReadOnly` on it, one tier up.

**R27b — the third is d3's own answer: Observable Plot.** Same authors, built on
d3's primitives, `Plot.barY()` / `Plot.dot()`. They did not add charts to d3; they
built a layer on top, as a separate package with its own name — after seeing the
need. That is the model to copy, and it means we are not diverging from d3 at all:
primitives plus a gallery, PLUS the layer its authors also built.

The failure mode to avoid is Plotly's: named charts placed INSIDE the core API,
where their options metastasise onto `Axes`.

**R27c — and it is a second R16 test.** `contrib/polar` answered "can someone add
a GEOMETRY from outside?". A named-chart package answers "can someone add a CHART
from outside?" — a different question, equally important, and one we currently
have no evidence on. If `ridgeline()` can be written using nothing but the public
entry, the API is sufficient for chart authors; if it cannot, that is a gap worth
finding before anyone else does.

Both are wanted, not either: a GALLERY for people who want to see what is possible
and adapt something, and a NAMED LAYER for people who want a ridgeline in one
line. d3 ships both.

**R27e — the gallery is documentation, and we can do one thing d3 cannot.** Four
properties make d3's gallery cheap: entries are FORKABLE rather than callable (so
there is no API commitment, no option surface, no version compatibility), they are
AUTHOR-maintained (community galleries rot), the PLATFORM is borrowed from
Observable, and the licence explicitly sanctions copying.

Ours is `examples/`, and it is already BUILT IN CI — so every entry provably
compiles against the current API. d3's gallery is notebooks: unversioned, untested,
and it drifts. Extending ours to "every entry renders and produces non-blank
output" is a small step from the render smoke test that already exists. **A gallery
that cannot silently rot is a real advantage and is nearly free.**

And the escape hatch is structural rather than promised: because a named chart is
written in the public API, its source IS a gallery entry. When `ridgeline()` does
not fit, you read its twenty lines and fork them — d3's forkability without giving
up the one-liner.

The one thing NOT to copy is d3's stance. It can afford "even simple things are
often not easy" because its audience is web developers who want control. Ours is
scientists who will reach for matplotlib the moment a heatmap costs fifty lines.
Being at Plot's altitude by default is the requirement, not a compromise.

### The vocabulary to aim at

```ts
const fig = await figure('#chart')                     // selector or element
const ax  = fig.axes({ aspect: 1, colormap: 'RdBu' })  // one axes, no grid arithmetic
ax.image(v, { shape: [rows, cols], x: [-3, 3], y: [-3, 3], clim: [-1, 1] })
```

with the domain kept for the case it was built for — sharing:

```ts
const g = grid({ shape: [rows, cols], x: [-3, 3], y: [-3, 3] })
ax.image(v, g); ax.quiver(vec, g)      // one lattice, provably the same
```

So a domain becomes what a user reaches for WHEN THEY HAVE A REASON, and inference
covers the rest — the infer-vs-require rule from §6, applied at the approach layer.

### What the review found was already right

The object tree (`Figure` → `Axes` → `Drawable`), the MATLAB mapping, `clim`,
`dataAspect`, the `*Domain` family, and the `attach*` family — one prefix, obvious
meaning, obvious lifetime — need no change. `AxesCube`, `AxesOverlay` and
`AxesColorbar` are internal and their names cost nobody anything.

`ChartSession`'s CONCEPT is right (one device, one clock, one loop, shared across
figures) and it is OPTIONAL — a lone `Figure` runs its own loop, verified. The
defect is documentation: the README and examples both present it as step one,
which is why it reads as mandatory.

**Folder layout is not a user-facing concern.** The `exports` map is the boundary,
and Node refuses a deep import with `ERR_PACKAGE_PATH_NOT_EXPORTED` — verified.
What folders would give is contributor legibility; what actually protects the
boundary is `publicApi.test.ts`, which pins the export list so drift is a visible
diff rather than a discovery a version later.

---

## 9. Entry paths — what d3 does that we do not

Reviewed against `d3js.org/getting-started`, 2026-08-23.

**R28 — there is no zero-install path, and d3 leads with three of them.** d3's
first suggestion is Observable (no install at all), then a one-line CDN import:

```html
<script type="module">
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
</script>
```

We cannot match that as built, because `three` is a peer dependency left EXTERNAL
— correct for npm, but a bare module script cannot resolve `three/webgpu`. Tested:
404, then it renders once an import map is added. The working form, verified in a
browser:

```html
<script type="importmap">
{ "imports": {
  "three":        "https://cdn.jsdelivr.net/npm/three@0.183/build/three.webgpu.js",
  "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.183/build/three.webgpu.js",
  "three/tsl":    "https://cdn.jsdelivr.net/npm/three@0.183/build/three.tsl.js"
}}
</script>
```

(`three.core.js` resolves relatively from within the package, so it needs no
entry.) Four lines against d3's one. The alternative is a STANDALONE build with
`three` bundled — simpler for the user, ~2 MB, and a duplicate copy on any page
that already loads three. Ship both: peer-dep for npm, standalone for the CDN
one-liner. Right now the only way to see this library work is to clone the repo,
which is a far higher bar than d3 asks of anyone.

**R29 — the device-free subset already exists and is invisible.** d3's structural
asset is not "many packages" but the specific line it draws: most modules do not
touch the DOM, so they behave identically everywhere; only `d3-selection`,
`d3-transition` and `d3-axis` compete with a framework's rendering.

Our analogue is device-free versus GPU, and it is already true: **18 of 51 source
modules never import `three`** — tick selection, envelope bucketing, limits,
layout rects, slice arithmetic, mesh smoothing, pan/zoom, time-scroll, raster
normalisation. That is what the 244 Node tests exercise in under a second with no
adapter. It runs in Node, in a worker, on a server. d3 would ship it as its own
package; we ship it as an undocumented accident.

**R30 — no framework guidance, and we own more state than d3 does.** d3 documents
React (`useRef` + `useEffect`) and Svelte explicitly, and says WHY: DOM-mutating
modules compete with the virtual DOM. We own a `<canvas>`, an animation loop, and
GPU resources with lifetimes — the same tension in a sharper form, and StrictMode's
double-invoke is exactly where it goes wrong. The application this was extracted
from has solved it; the library ships nothing.

---

## 10. Positioning ruling: a scientific DOMAIN TOOL

Decided 2026-08-23, and it settles several open items rather than adding one.

The d3/Observable structure was studied closely (§9, R27) and the conclusion is
that **it is the wrong model to imitate**. d3 is general-purpose and aimed at web
developers building team products; Observable monetises collaboration seats at
$22/editor/month and gives both libraries away. That business raised ~$46M against
single-digit-millions of estimated revenue over nine years, with the most widely
used dataviz library in the world as its funnel — which says the "give away the
library, sell the platform" route is harder than it looks, and it is not our route
regardless.

**We are a scientific domain tool.** The comparison set is VTK, ParaView, MATLAB,
Brainstorm and FieldTrip — which §0 already said, and this confirms rather than
revises.

### What that changes

**The named-chart layer should be DOMAIN charts, not generic ones (revises R27).**
A scientist does not want `barChart()`. They want a spectrogram, a source map, a
connectivity matrix, a ridgeline of trials, a joint λ×ω spectrum. Generic marks are
already one call at Plot's altitude; the value is in compositions that encode a
FIELD's conventions, and those are the ones worth writing.

**The gallery rises in importance.** Scientists evaluate by "does it do MY thing".
A gallery of neuroimaging, climate and fluid examples is the entire sales pitch;
generic bar charts prove nothing to them. `examples/` being CI-verified (R27e)
matters more here than it would for a general library.

**R28 and R30 fall in priority.** A CDN one-liner and React integration guidance are
WEB-DEVELOPER concerns. A scientist reaches for npm inside a project, or a
notebook. Zero-install still matters for EVALUATION — but as a hosted demo they can
click, not as a snippet for a page they are building.

**What rises instead:** the loader layer (R18 — NIfTI, Zarr, HDF5, DICOM), the
compute engine and its function taxonomy (R20–R23), and the Laplacian capability
(R4–R8). Those are what a scientific tool lives or dies on.

### The open question this raises, and it may be the largest

**Scientific users live in Python and MATLAB.** MNE, nilearn, SPM, Brainstorm,
FieldTrip. A browser-only JavaScript library reaches them through a web
application or a notebook widget and through nothing else. matplotlib, plotly and
VTK all have a Python front door; we have none.

That is plausibly a bigger adoption question than every entry-path item in §9 put
together, and it is unresolved. Options span a Jupyter/marimo widget, a Python API
that drives the JS engine, or an export/import boundary — with very different
costs. Nothing should be built for it on speculation, but it should not be
discovered late either.

### And it settles the business model

Institutional and per-facility licensing rather than per-seat; paid layers that
encode RESEARCH (toolboxes) rather than convenience; usage-based pricing if heavy
compute runs server-side (R19a). Plus one option §7 does not yet record:
**free-for-academic, paid-for-commercial**, which is common in this field and needs
no platform at all — at the cost of not being an OSI licence, which conflicts with
R16's contribution story. A real trade, recorded as an alternative to §7's
Apache-2.0 decision rather than a replacement for it.

---

## 11. Spike: the Python and MATLAB front doors

Probed 2026-08-23, in response to §10's open question. **Feasibility only — nothing
built.** The whole thing turns on one question that can be answered from evidence
rather than opinion: does WebGPU actually work inside the host?

### Python / Jupyter — viable, with a direct precedent

The strongest evidence is not a demo but production scientific software doing our
exact shape: **NGSolve** (finite elements, TU Wien) renders FEM fields on meshes in
Jupyter over WebGPU, via `cerbsim/webgpu` and `ngsolve_webgpu` above it. A
scientific domain tool, on WebGPU, in a notebook.

The mechanism is settled: **anywidget** — a Python class plus an ES module, working
in classic Notebook, JupyterLab and JupyterLite. `demo-jupyter-wasm-webgpu-widget`
exists on PyPI with a live Colab demo, so WebGPU in an output cell is demonstrated
rather than assumed.

Constraints, quoted from `cerbsim/webgpu`'s own README: a recent Chrome or Edge;
*"some platforms may require enabling experimental WebGPU flags"*; mobile and
non-Chromium are partial or unsupported.

### MATLAB — blocked at the host, and not by anything we control

`uihtml` runs inside CEF. Two findings, both negative:

- MATLAB R2025a ships **CEF v118**. WebGPU landed in Chromium 113, so the API
  should exist — but embedded CEF builds routinely ship without GPU access, and a
  JCEF issue reports exactly that: `navigator.gpu.requestAdapter()` returning
  **"No available adapters."** The API is present; the adapter is not.
- MATLAB users already report **software** WebGL rather than hardware in
  `uifigure`, so the GPU path is degraded before WebGPU is even reached.

We cannot fix either: MATLAB's CEF build and its flags are not ours. **Embedding is
not a viable MATLAB path.**

The fallback costs almost nothing: MATLAB's `web()` opens the SYSTEM browser,
sidestepping CEF entirely. That is a file handoff — write data, open a local page —
which is how those toolboxes already exchange data anyway.

### The ruling

**One real front door, one cheap fallback.** Python via anywidget; MATLAB via a
file handoff to the system browser. Not two integrations.

Python is where the reach is regardless: MNE and nilearn are Python, and the
MATLAB cohort (Brainstorm, SPM, FieldTrip) is large but not growing — and is the
cohort best served by a file handoff, since that is already its habit.

### This promotes R28, for a different reason

A notebook widget needs the JS to load with **no build step and no import map** —
exactly the standalone bundle R28 described. §10 demoted R28 as a web-developer
concern; the Python front door promotes it back as a PREREQUISITE. The bundle is
not a CDN nicety, it is what a widget loads.

### Three unknowns that need building to settle

1. **Data transfer at scale.** anywidget moves Python→JS through traitlets; binary
   buffers are supported, but a `[40000 × T]` field is a different problem from a
   config dict. Stream, file URL, or chunked protocol is unresolved.
2. **Colab specifically** — the highest-reach host, and the one that sandboxes
   output cells most aggressively. The demo suggests it works; that should be
   verified before anything is built on it.
3. **Flags.** *"Some platforms may require enabling experimental WebGPU flags"* is
   an adoption tax if it bites the common case. A scientist who must edit browser
   flags will leave.
