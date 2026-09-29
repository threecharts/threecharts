import type { Object3D } from 'three/webgpu'

let _id = 0

/**
 * GraphicsObject — the base for every node in the charts object tree (Figure,
 * Axes, Axis, drawables, illustrations). Owns the tree, a backing three.js
 * `node`, and the dirty/`update()` reconcile machinery. Subclasses declare typed
 * properties whose setters call `invalidate()`; the Figure loop calls `update()`
 * each frame, which runs `onUpdate()` (the subclass's props→node reconcile) only
 * when dirty, then recurses into children.
 *
 * A fresh object starts CLEAN; `add()` invalidates the child so a newly-parented
 * object builds on the next `update()`, and subclasses `invalidate()` after
 * setting initial state.
 */
export abstract class GraphicsObject {
  readonly id = `g${_id++}`
  parent: GraphicsObject | null = null
  private _children: GraphicsObject[] = []
  private _dirty = false
  private _visible = true

  constructor(readonly node: Object3D) {}

  get children(): readonly GraphicsObject[] { return this._children }

  get visible(): boolean { return this._visible }
  set visible(v: boolean) {
    if (v === this._visible) return
    this._visible = v
    this.node.visible = v
    this.invalidate()
  }

  add(child: GraphicsObject): void {
    if (child.parent) child.parent.remove(child)
    child.parent = this
    this._children.push(child)
    this.node.add(child.node)
    child.invalidate()
  }

  remove(child: GraphicsObject): void {
    const i = this._children.indexOf(child)
    if (i < 0) return
    this._children.splice(i, 1)
    this.node.remove(child.node)
    child.parent = null
  }

  /** Mark dirty; the next `update()` will reconcile this object. */
  invalidate(): void { this._dirty = true }

  /** Reconcile this object (if dirty) then all descendants — depth-first. */
  update(): void {
    if (this._dirty) { this.onUpdate(); this._dirty = false }
    for (const c of this._children) c.update()
  }

  /** Subclass hook: reconcile queued property changes into `node`. */
  protected onUpdate(): void {}

  dispose(): void {
    for (const c of [...this._children]) c.dispose()
    if (this.parent) this.parent.remove(this)
  }
}
