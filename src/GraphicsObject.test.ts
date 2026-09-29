import { describe, it, expect } from 'vitest'
import { Group } from 'three/webgpu'
import { GraphicsObject } from './GraphicsObject'

class Probe extends GraphicsObject {
  updated = 0
  constructor() { super(new Group()) }
  protected onUpdate() { this.updated++ }
}

describe('GraphicsObject', () => {
  it('parents children and mirrors into the three.js node', () => {
    const a = new Probe(), b = new Probe()
    a.add(b)
    expect(b.parent).toBe(a)
    expect(a.children).toContain(b)
    expect(a.node.children).toContain(b.node)
  })
  it('update() runs onUpdate only when dirty', () => {
    const a = new Probe()
    a.update(); expect(a.updated).toBe(0)       // clean → no work
    a.invalidate(); a.update(); expect(a.updated).toBe(1)
    a.update(); expect(a.updated).toBe(1)        // cleared
  })
  it('remove() detaches from both trees', () => {
    const a = new Probe(), b = new Probe()
    a.add(b); a.remove(b)
    expect(b.parent).toBeNull()
    expect(a.children).not.toContain(b)
    expect(a.node.children).not.toContain(b.node)
  })
})
