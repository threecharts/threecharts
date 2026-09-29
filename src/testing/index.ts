/**
 * `threecharts/testing` — what an extension needs to test itself on a real device.
 *
 * Shipped as part of the public API on purpose. If contributions are how this
 * library gains breadth (FOUNDATIONS R16), then the ability to VERIFY a
 * contribution is not a convenience — a contributor who cannot run their domain on
 * a GPU can only check that they built the node graph they meant to build, never
 * that it evaluates correctly. That gap was found by writing `contrib/polar` as an
 * outside contributor would: everything else it needed came from the package entry;
 * this did not, and it was the one import a real contributor could not have written.
 *
 * Depends on no test runner, so it works under vitest, jest, or a plain script.
 */
export { gpuHarness, hasWebGPU, readback, assertWebGPU } from './gpu'
export type { GpuHarness } from './gpu'
