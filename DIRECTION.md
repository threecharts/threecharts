# `threecharts` — direction

Principles the engine is meant to grow along. **Not a design and not a plan** — a
statement of what the pieces already are, so that the next change extends the model
rather than working around it. Recorded 2026-08-21 (Diellor's rulings).

Read `frontend/CLAUDE.md` → *Direction: general primitives, dedicated app charts*
first; this file is the layer beneath it, about the engine's own model.

---

## The mapping this engine committed to

| MATLAB | here |
|---|---|
| the workspace | `ChartSession` — one WebGPU device, one `Clock`, one loop |
| a figure window | `Figure` — one canvas via `CanvasTarget` |
| `subplot` | `Axes` at a viewport rect inside one `Figure` |
| a ruler | `Axis` — ticks, limits, scale |

Committing to that mapping was load-bearing, and the two principles below are its
unfinished consequences. Where MATLAB has an answer and we do not, **prefer
MATLAB's** — the mapping is the asset, and diverging from it costs more than the
divergence usually buys.

---

## 1. A GEOMETRY is an AXIS

**An axis is an addressing scheme for locations.** A numeric ruler addresses
positions on a line. That is not the only thing that addresses locations, and in
this engine most of them are three.js geometries:

| geometry | addresses | drawn by |
|---|---|---|
| plane | a Euclidean 2D domain — the cells of a raster | `Image` |
| volume / 3D texture | voxels | `Volume`, `Slice` |
| line | a 1D parameterised domain | `Line` |
| mesh (`BufferGeometry`) | the vertices of a manifold | `Surface`, `Quiver`, `Particles`, `Fibers` |

**A chart therefore has as many axes as it has geometries**, and a field is bound to
one of them. Today the app draws a head mask beside the cortex and treats only the
cortex as "the chart"; in truth that is a **two-axis chart** — two vertex
addressings, either of which can carry a scalar, a vector or a set of particles.
Exactly as several `Image` charts each carry their own field layers over their own
cells.

**The two arrangements.** Euclidean domains **tile** — several planes side by side
is a grid of charts, which is what `subplot` already is. Mesh domains **co-locate** —
several surfaces in one scene, overlapping in space rather than tiled. Same
structure, different arrangement; the grid analogy holds for both and only looks
subtle for the second.

### What this already explains

`app/src/render/views/types.ts` records, of its `AxisId` union:

> `voxel` arrived with `viewMri` and it is the first axis this union cannot fully
> describe: an MRI has THREE voxel axes … If a view ever needs to distinguish them
> (an oblique/MPR slice would), the id needs a component, not a second entry.

Under this principle that limitation dissolves rather than needing a workaround: the
union was naming an axis **kind** where what is wanted is an axis **instance**. A
volume is ONE domain; the slice sliders select coordinates within it, and an oblique
plane is another coordinate choice in the same domain — not a fourth id.

### What it would change, when it is built

- `Axis` today is a numeric ruler (`niceTicks`, `logTicks`, limits, scale). The
  generalisation is that a ruler is one KIND of domain, not the definition of one.
- A drawable would name the domain it is addressed on, rather than implying it by
  which drawable class it is.
- A multi-geometry chart would stop needing a "primary" geometry — the thing
  `AnatomyChart` currently has, and the reason the head mask cannot be painted on.

**Not decided, deliberately:** whether the domain is a new type beside `Axis`, a
generalisation of `Axis` itself, or a property of `Axes`. Decide that with a real
second case in hand — the head mask + cortex pair is the obvious one.

---

## 2. LAYERS are the drawable stack, and `hold` is its policy

**MATLAB already answers this and we should copy it.** `plot(x,y)` replaces;
`hold on` makes subsequent plots ADD; `hold off` returns to replacing.

```matlab
plot(x, y)      % draws
hold on
plot(x, z)      % a second layer, over the first
```

So: **layers ARE the ordered drawables of an `Axes`**, and `hold` is the policy for
what `add` does. No new container type is needed — `Axes._drawables` is already the
stack. What it lacks is identity, explicit order, per-layer visibility, and `hold`.

### Three mechanisms, and they are not interchangeable

Conflating these is the trap this section exists to prevent — they feel like one
word and are three different machines:

| mechanism | what it does | example |
|---|---|---|
| **`hold on` / `hold off`** | stack MEMBERSHIP | segments annotating a line; a quiver over a surface |
| **per-layer alpha / blend** | how a member COMPOSITES with what is beneath | a binary mask over an atlas over a T1 |
| **a composite VALUE** | two fields jointly determining one colour (bivariate) | not a layer question at all — see below |

The third is a **value type** concern, not a layering one. It belongs with
`docs/superpowers/specs/2026-08-19-categorical-value-types-design.md` — Diellor's
ruling that *categorical is a value type every primitive can hold (Surface, Image,
Line, Particles, Quiver, Volume), not a Surface option.* Layering says WHICH fields
are present and in what order; the value type says what one field MEANS. Design them
together or they will contradict each other.

### Every chart has layers, not just the cortex

`Image` should layer binary masks and categorical atlases over a raster, and carry
quivers and particles over its grid, for the same reason `Surface` carries them over
a mesh. There is no property of the mesh that makes it the layerable one — the
capability is the engine's, and today it exists in exactly one chart by accident of
where it was needed first.

### What exists today, for contrast

`CortexLayerState` (`@nxr/cortical-flow`) is **not** this. It is
`id: 'surface' | 'quiver' | 'sensors'` — three hardcoded strings — and it is a
PUBLICATION protocol: a chart emits React nodes (`menuItems`, `controls`) upward for
a rail panel to render. That is a UI contract over one chart's private layer notion,
not a graphics model. It works and should keep working; it is not the thing to
generalise from.

**When the engine grows a layer model, the Layers PANEL becomes a view of the
stack** — chart-agnostic, one panel for every chart, instead of one chart's
published list.

---

## Where this is headed

These two principles meet: **layers of GEOMETRY (axes) carrying layers of FIELDS.**
A chart is a set of domains, each with an ordered stack of fields drawn on it. The
cortex + head mask case and the MRI + atlas + mask case are the same shape, and
today they are two unrelated pieces of code.
