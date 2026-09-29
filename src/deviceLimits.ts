/**
 * DEVICE LIMITS — what the charts ask a GPU for, in one place.
 *
 * `deviceLimits`, not `limits`: that name is taken by the AXIS limits
 * (`Limits`/`Bounds`/`unionBounds`), which are data ranges on a chart and have
 * nothing to do with GPU capabilities.
 *
 * Its own module rather than living beside `ChartSession` because `Figure` needs
 * the same number and must NOT import `ChartSession` at runtime — the
 * `FigureSession` interface exists precisely to keep that dependency type-only.
 * A shared leaf module is how both get one source of truth without either
 * importing the other.
 */

/**
 * Storage buffers per shader stage the charts' device must provide.
 *
 * **8 IS THE WEBGPU DEFAULT, AND THAT IS THE POINT (2026-08-16).** A device
 * request is refused outright when ANY required limit exceeds what the adapter
 * offers, and every adapter provides the defaults — so asking for exactly 8 is
 * a request that cannot be refused, on any GPU, in any browser.
 *
 * It was **10** until an audit found nothing that needs it. The 10 was measured,
 * but against a `computeDivergence` kernel in `charts-mesh` — a package archived
 * 2026-07-28, whose successor was deliberately rebuilt as two passes. The number
 * outlived the kernel and was carried forward verbatim, and the commit that
 * carried it said so plainly: the development Mac reports exactly 10, so the app
 * asked for precisely its own hardware's ceiling with no headroom, on hardware
 * nobody else was guaranteed to have. Mobile adapters commonly report exactly 8,
 * which made this a real "the app does not start" rather than a theoretical one.
 *
 * **The live maximum is 8**, in `app/src/toolbox/differential/flowField.ts`'s
 * vertex-gather pass (`vfAreaSum`, `vfOffsets`, `vfIndices`, `areas`, `divF`,
 * `curlF` read; `div`, `curl` written). Everything else is ≤7. The budget is
 * therefore EXACTLY spent, which is why `deviceLimits.test.ts` pins it rather
 * than trusting this prose: a ninth buffer in one kernel is a validation error
 * on every GPU, and it should fail in CI rather than on someone's phone.
 *
 * If a kernel ever genuinely needs more, PACK rather than raise this — `div`+
 * `curl` and `divF`+`curlF` as `vec2` take those two passes to 6 and 5
 * (`storageMatrix` already accepts `'vec2'`, and the tree already does exactly
 * this with `'vec3'`).
 */
export const REQUIRED_STORAGE_BUFFERS = 8

/**
 * The WebGPU spec's guaranteed floor for `maxStorageBuffersPerShaderStage`.
 *
 * Not a knob — the number every adapter must provide. It is here so the test can
 * state the rule as "we never ask for more than the guaranteed floor" instead of
 * comparing one magic number against another.
 */
export const WEBGPU_DEFAULT_STORAGE_BUFFERS = 8
