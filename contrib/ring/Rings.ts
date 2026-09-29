import { InstancedMesh, MeshBasicNodeMaterial, RingGeometry, DoubleSide } from 'three/webgpu'
// @ts-ignore — three/tsl runtime types are looser than the build-time export
import { Fn, instanceIndex, positionGeometry, vec3, float, int } from 'three/tsl'
import {
  Drawable, resolveField, resolveColormapRow,
  type Axes, type Bounds, type Domain, type FieldSource,
} from 'threecharts'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RingsOptions {
  /** Per-address radius. Omit for a constant one. */
  radii?: FieldSource
  /** Constant radius when `radii` is omitted. */
  radius?: number
}

/**
 * A visual mark that did not exist in the library: a flat ring at every address of
 * a domain, sized by a field.
 *
 * **It exists to answer a question, not because rings are important.** Three
 * extension axes matter for this library — adding a GEOMETRY, authoring a
 * DRAWABLE, composing a CHART — and `contrib/polar` only ever proved the first.
 * This proves the second: a third party can author a new mark using nothing but
 * the package's public entry.
 *
 * The parts it needs, and all of them are public: `Drawable` for the base and its
 * `dataBounds`/`invalidate` contract, `Domain.positionAt` to know where address
 * `i` sits, `resolveField` so a caller may pass a plain `Float32Array` exactly as
 * a built-in mark allows, and `resolveColormapRow` to reach the shared atlas.
 *
 * `resolveField` was NOT exported until this file was written. `Drawable` was, and
 * `FieldSource` was, so the extension point looked open and was not: a contributed
 * mark could subclass the base and then had no way to accept the data type its own
 * signature advertised.
 */
export class Rings extends Drawable {
  private readonly _material: MeshBasicNodeMaterial
  private readonly _mesh: InstancedMesh
  private readonly _domain: Domain

  constructor(axes: Axes, domain: Domain, opts: RingsOptions = {}) {
    const material = new MeshBasicNodeMaterial({ side: DoubleSide })
    material.depthWrite = false
    const mesh = new InstancedMesh(new RingGeometry(0.62, 1, 24), material, domain.count)
    mesh.frustumCulled = false
    super(axes, mesh)

    this._material = material
    this._mesh = mesh
    this._domain = domain

    const r = resolveField(opts.radii ?? new Float32Array(domain.count).fill(1), 'float')
    const scale = float(opts.radius ?? 1)

    // Place each ring at its address, scaled by that address's value.
    material.positionNode = (Fn as any)(() => {
      const i: any = instanceIndex
      const at: any = domain.positionAt(i)
      const s: any = float((r.node as any).element(int(i))).mul(scale)
      const p: any = positionGeometry
      return vec3(at.x.add(p.x.mul(s)), at.y.add(p.y.mul(s)), at.z)
    })()

    this.invalidate()
  }

  /** The domain answers this; a mark does not measure its own extent. */
  dataBounds(): Bounds { return this._domain.bounds() }

  protected onUpdate(): void {
    // Reach the shared colormap atlas the same way a built-in mark does.
    // `effectiveColormap` is protected on `Drawable` — a subclass may read it,
    // which is exactly what makes per-drawable colormap overrides authorable.
    void resolveColormapRow(this.effectiveColormap())
    this._material.needsUpdate = true
  }

  dispose(): void {
    this._material.dispose()
    ;(this._mesh.geometry as { dispose(): void }).dispose()
    super.dispose()
  }
}
