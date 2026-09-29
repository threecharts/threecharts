# threecharts

A **scientific visualisation and analysis system** for the browser, built on
three.js and WebGPU.

Two halves over one substrate: charts that draw fields on geometries, and TSL
compute that operates on those same GPU-resident buffers. A field lives on the
device once — compute writes it, charts read it, animation indexes it — with no
copies and no readback.

> **Status: pre-1.0 and unstable.** The public API is still moving, and this
> README describes what exists rather than what is planned. There is no published
> package yet.

## Why this rather than a charting library

Charting libraries visualise results. This is meant to be where the analysis
happens.

|  | typical answer | here |
|---|---|---|
| change the time step | re-read, re-filter, re-upload | write one uniform |
| where analysis runs | elsewhere, then plot the output | on the same buffer the chart reads |
| coordinate systems | a fixed set of chart types | geometries you can add yourself |

The nearest neighbours are VTK, ParaView and MATLAB rather than d3 or Plotly —
and where d3's modules fit (`d3-scale`, `d3-array`), the intent is to consume them
rather than reimplement them.

## Install

```sh
npm install threecharts three
```

`three` is a peer dependency. A browser with **WebGPU** is required.

> The package name is **not settled**. `threecharts` replaced the `@nxr/charts`
> name inherited from the application this was extracted from, and the library
> is more than charts. Expect it to change before anything is published.

## Quick start

```ts
import { ChartSession, createFigure, meshDomain, loadAllColormapLibraries } from 'threecharts'

// One device, one clock, one animation loop — shared by every figure.
const session = new ChartSession()
await session.init()

// Colormaps are served by the host; the package ships the atlas under
// `threecharts/colormaps/*`, and you tell the loader where you put it.
await loadAllColormapLibraries('/colormaps')

const figure = await createFigure({ container: document.querySelector('#chart')!, session })
const axes = figure.axes({ projection: '3d' })   // or figure.subplot(2, 2, 1) for a grid

// A domain is what a field is defined on. Several drawables can share one.
const cortex = meshDomain(geometry)

axes.surface(geometry, { domain: cortex, scalar, clim: [0, 1e-10] })
axes.quiver(vectors, cortex.count, 1, { dims: 3, domain: cortex })

// Field values are a plain `Float32Array`, or a GPU storage node when the data
// came out of a compute pass. TSL is the implementation, never the entry fee.
// `shape` is the ARRAY's order — [rows, cols] — so it reads the way your data does.
axes.image(values, { shape: [rows, cols], xExtent: [-3, 3], yExtent: [-3, 3] })

session.start()
```

Both layers read the same vertices, so `cortex.setPositions(...)` moves the
surface and its arrows together.

## The core idea: domains

A **domain** is what a field is defined on — a set of addresses and where each
one sits. It is three members:

```ts
interface Domain {
  readonly count: number                 // how many addresses
  bounds(): Bounds                       // the extent, for auto-limits
  positionAt(index: Node): Node          // address → vec3, as a shader node
}
```

Rectilinear, curvilinear and unstructured geometries differ **only in
`positionAt`** — computed from strides, or read from a buffer. That is why a new
coordinate system does not need a new chart type:

| | |
|---|---|
| `gridDomain({ nx, ny })` | a lattice. Allocates nothing; positions are computed. |
| `meshDomain(geometry)` | a triangulated surface's vertices. |
| `pointsDomain(xyz)` | an unstructured point set. |

Any drawable that places things at addresses works on any of them.

## Adding a geometry

You should not have to modify this library to add a coordinate system. **A worked
example lives in [`contrib/polar`](contrib/polar/polarDomain.ts)** — a polar
lattice written entirely against the public API, which existing primitives draw on
without a line of core changing.

Its test uses `threecharts/testing`, which exports a GPU harness so a contributed
domain can be verified on a real device rather than merely inspected:

```ts
import { gpuHarness, readback } from 'threecharts/testing'
```

See [`docs/FOUNDATIONS.md`](docs/FOUNDATIONS.md) for the model this is built on,
and [`DIRECTION.md`](DIRECTION.md) for what the engine's pieces already are.

## Running the examples

```sh
npm run dev
```

Three panels sharing one device, one clock and one loop: a scalar field on a
rectilinear lattice, a scalar on a mesh, and a vector field on the **polar domain
defined in `contrib/`** — outside the library, drawn by a primitive that predates
it.

## Development

```sh
npm run typecheck    # strict TypeScript
npm test             # unit suite — pure logic, no device, ~0.7s
npm run test:gpu     # GPU suite — headless Chromium against a real device
npm run build        # ESM + type declarations
npm run dev          # examples, at http://localhost:5173
npm run check        # typecheck, both suites, build
```

The GPU suite asserts on **buffer readbacks, not pixels**: rasterisation varies by
driver, and the questions worth asking are numbers — where a vertex landed, what a
reduction summed to. `WEBGPU_SOFTWARE=1` runs it against SwiftShader, which is how
CI covers it on machines with no GPU.

## Licence

Not yet chosen — see the note in `package.json`. Until one is added, no licence is
granted.
