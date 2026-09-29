import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Every plotting factory must PARENT the drawable it builds.
 *
 * `Axes.slice()` shipped as `return new Slice(this, …)` — it built the material,
 * the uniforms and the quad, handed the caller a fully working object, and never
 * added it to the scene. Nothing threw and nothing warned: the MRI viewer drew
 * its surfaces and none of its six slices, which reads as a volume that failed to
 * load rather than as a drawable that was never attached.
 *
 * A unit test of the drawable cannot see this — parenting is the AXES' job — and
 * a render test needs a WebGPU device. So the gate is on the SOURCE, and it keys
 * on the CONSTRUCTION rather than on a list of method names: any factory that
 * says `new <Drawable>(this` is covered the day it is written, including ones
 * that do not exist yet.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('./Axes.ts', import.meta.url)), 'utf8')

/** The `// ── plotting functions ──` section, up to `// ── drawables ──`. */
function plottingSection(): string {
  const from = SRC.indexOf('── plotting functions ──')
  const to = SRC.indexOf('── drawables ──')
  expect(from, 'the plotting-functions marker moved').toBeGreaterThan(0)
  expect(to, 'the drawables marker moved').toBeGreaterThan(from)
  return SRC.slice(from, to)
}

/** Each 2-space-indented method in the section, as `[name, body]`. */
function methods(section: string): [string, string][] {
  const out: [string, string][] = []
  const head = /^ {2}([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^]*?\)\s*:\s*[^{]*\{$/gm
  let m: RegExpExecArray | null
  while ((m = head.exec(section)) !== null) {
    /* The body runs to the first line that is exactly a 2-space-indented `}` —
       the method's own closing brace, since everything nested is deeper. */
    const rest = section.slice(head.lastIndex)
    const end = rest.search(/^ {2}\}$/m)
    out.push([m[1], end < 0 ? rest : rest.slice(0, end)])
  }
  return out
}

describe('Axes plotting factories', () => {
  const found = methods(plottingSection())

  it('finds the factories at all — a silent zero would pass every case below', () => {
    const building = found.filter(([, body]) => /new\s+[A-Z]\w*\(\s*this\b/.test(body))
    expect(building.length).toBeGreaterThanOrEqual(8)
    expect(building.map(([n]) => n)).toContain('slice')
    expect(building.map(([n]) => n)).toContain('surface')
  })

  it.each(found.filter(([, body]) => /new\s+[A-Z]\w*\(\s*this\b/.test(body)))(
    '%s() parents its drawable through addDrawable',
    (_name, body) => {
      expect(body).toMatch(/addDrawable\s*\(/)
    },
  )
})
