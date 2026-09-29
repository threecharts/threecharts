/**
 * GPU test helpers — how a test observes what the library actually produced.
 *
 * The library's output is numbers written into GPU buffers by shaders. The unit
 * suite cannot see any of them: it runs in Node with no device, so it can only
 * check the arithmetic that happens to live on the CPU. Everything downstream of
 * a `positionNode` or a compute pass is invisible to it.
 *
 * `readback` closes that gap. It copies a storage buffer back to the host so a
 * test can assert on exact values — where a vertex landed, what a reduction
 * summed to, what a decoder expanded. Those comparisons are exact, unlike a
 * screenshot, and they fail with a number rather than with an image diff.
 */

/** A device plus its renderer, torn down together. */
export interface GpuHarness {
  renderer: import('three/webgpu').WebGPURenderer
  device: GPUDevice
  dispose(): void
}

/**
 * Refuse a silent fallback, and return the device.
 *
 * `WebGPURenderer` DEGRADES to its WebGL2 backend when a device cannot be created:
 * it warns to the console and otherwise carries on. A suite named `gpu` will then
 * pass happily against a renderer it was never meant to exercise, which is worse
 * than failing — it reports coverage that does not exist.
 *
 * Not hypothetical. Wiring CI, a SwiftShader flag combination left `ChartSession`'s
 * renderer on WebGL2 while all 14 tests went green; the only evidence was one
 * console warning scrolling past. **Every test that constructs a renderer must call
 * this**, which is why it is exported rather than folded into `gpuHarness` — the
 * fallback happened in a test that builds its own `ChartSession`.
 */
export function assertWebGPU(renderer: import('three/webgpu').WebGPURenderer): GPUDevice {
  const backend = (renderer as unknown as {
    backend?: { device?: GPUDevice; isWebGPUBackend?: boolean }
  }).backend
  if (!backend?.isWebGPUBackend || !backend.device) {
    throw new Error(
      'assertWebGPU: the renderer fell back to a non-WebGPU backend. The test would ' +
      'have passed without exercising WebGPU at all.',
    )
  }
  return backend.device
}

/**
 * An initialised WebGPU renderer for a test.
 *
 * Asks for nothing above the spec's guaranteed floor, so this fails only where
 * the library itself would fail — a test that quietly requires a better GPU than
 * the library does would pass on the development machine and mislead.
 */
export async function gpuHarness(): Promise<GpuHarness> {
  const { WebGPURenderer } = await import('three/webgpu')
  const { REQUIRED_STORAGE_BUFFERS } = await import('../deviceLimits')
  const renderer = new WebGPURenderer({
    antialias: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: REQUIRED_STORAGE_BUFFERS },
  } as ConstructorParameters<typeof WebGPURenderer>[0])
  await renderer.init()

  return { renderer, device: assertWebGPU(renderer), dispose: () => renderer.dispose() }
}

/** Is there a usable WebGPU adapter at all? Lets a suite skip with a clear
 *  reason rather than failing with a null-dereference deep inside three. */
export async function hasWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false
  try { return (await navigator.gpu.requestAdapter()) != null } catch { return false }
}

/**
 * Copy floats out of a storage-buffer node and return them.
 *
 * **The buffer must have been USED first** — by a compute dispatch or a render.
 * three creates device resources lazily, so a node nothing has touched has no
 * `GPUBuffer` behind it yet and this throws rather than returning zeros. That is
 * the right shape for a test anyway: reading back a buffer nothing produced
 * asserts nothing.
 */
export async function readback(
  h: GpuHarness,
  node: unknown,
  count: number,
): Promise<Float32Array> {
  const attribute = (node as { value?: unknown }).value ?? node
  const buf = await (h.renderer as unknown as {
    getArrayBufferAsync(a: unknown): Promise<ArrayBuffer>
  }).getArrayBufferAsync(attribute)
  return new Float32Array(buf).subarray(0, count)
}
