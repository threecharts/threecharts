# Contributing

## The one thing to know

**Adding a geometry, a chart or an operation should not require changing this
library.** If it does, that is a bug in the library's boundaries rather than a
step you should take — please open an issue describing what you could not reach,
because that gap is more valuable than the workaround.

The worked example is [`contrib/polar`](contrib/polar/polarDomain.ts): a polar
coordinate system written entirely against the public API, on which existing
primitives draw without a line of core changing. Copy its shape.

## The three extension axes

|  | worked example | what it proves |
|---|---|---|
| a new **geometry** | [`contrib/polar`](contrib/polar/polarDomain.ts) | a coordinate system, on which existing marks draw |
| a new **drawable** | [`contrib/ring`](contrib/ring/Rings.ts) | a visual mark the library does not contain |
| a new **chart** | — | a composition of several drawables |

Both existing examples import the package **by name** and reach into `src/` for
nothing. If yours cannot, that is the bug described above.

## Adding a drawable

Subclass `Drawable`, implement `dataBounds()`, and build a three.js node whose
`positionNode` asks the domain where each address sits. `contrib/ring` is ~70
lines and uses only `Drawable`, `Domain.positionAt`, `resolveField` and
`resolveColormapRow`.

Two things to get right:

- **Ask the domain for your extent** — `dataBounds()` should return
  `domain.bounds()`, not a measurement of your own. A mark that measures
  separately can disagree with the surface it sits on.
- **Accept a `FieldSource`, not a GPU node.** `resolveField(values, 'float')`
  handles both, so a caller may pass a plain `Float32Array` exactly as they can to
  a built-in mark. Requiring a node would make your mark second-class.

## Adding a domain

A domain is three members — `count`, `bounds()`, `positionAt(index)`. Implement
them and every drawable that places things at addresses works on your geometry
immediately.

Two rules that are easy to miss:

- **Samples sit at cell CENTRES**, `(k + ½)/n` across the extent. Using the corner
  biases the whole field half a cell toward the origin and leaves a visible gutter
  on two edges.
- **Bound what you actually occupy.** A 90° polar wedge bounded as a full disc
  frames with three quadrants of empty space. `contrib/polar` shows the sector
  case, including the axis crossings that no corner records.

If you find yourself wanting a fourth member, ask first whether it belongs to the
drawable instead. Colormap, opacity, glyph scale and line width all look like
domain properties and are not.

## Testing

Assert on **buffer readbacks, not pixels**. A shader node's correctness is a
question about numbers, and `threecharts/testing` exists so you can ask it:

```ts
import { gpuHarness, readback, hasWebGPU } from 'threecharts/testing'
```

Two hazards worth knowing before you spend an afternoon on them:

- **WebGPU needs a secure context.** `navigator.gpu` is undefined on
  `about:blank` no matter what flags you pass; `http://localhost` qualifies.
- **`.compute(n)` dispatches whole workgroups**, so `compute(8)` runs 64 threads,
  and WGSL *clamps* an out-of-range storage write to the last valid index rather
  than dropping it. Guard your index or the symptom is a single wrong value at the
  end of a buffer — which reads as a rounding bug, not a dispatch bug.

## Before you open a pull request

```sh
npm run check    # typecheck, both suites, build
```

Comments here explain **why**, including alternatives that were rejected and the
failure that motivated a decision. That is the codebase's most valuable property
and the hardest to retrofit — please match it. A comment saying what the next line
does is worth less than one saying what happens if you change it.
