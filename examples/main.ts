/**
 * Runnable examples — and a consumer-side smoke test.
 *
 * These import the library the way an application does, so they exercise the
 * public entry rather than the internals: anything the API fails to export shows
 * up here as a broken example rather than as a discovery after publishing.
 *
 * **Note what is absent: any import from `three/tsl`.** Field values are plain
 * `Float32Array`s. TSL is still what runs underneath, and a GPU storage node is
 * still accepted wherever data comes out of a compute pass — it is simply no
 * longer what a caller must produce to draw anything.
 *
 * They also make the library VISIBLE. A visualisation library that cannot be run
 * is hard to evaluate and harder to contribute to, and the buffer-readback suite
 * deliberately does not answer "does this look right".
 */
import { PlaneGeometry, TorusKnotGeometry } from 'three/webgpu'
import {
  ChartSession, createFigure, gridDomain, meshDomain, loadAllColormapLibraries,
  orbitLookingFrom,
} from 'threecharts'
import { polarDomain } from '../contrib/polar/polarDomain'
import { boxPlot } from '../contrib/boxplot/boxPlot'

const fail = (e: unknown) => {
  document.getElementById('err')!.textContent =
    `${e instanceof Error ? e.message : String(e)}\n\nWebGPU is required. In Chrome, check chrome://gpu.`
}

async function main() {
  const session = new ChartSession({ backgroundColor: 0x000000 })
  await session.init()
  await loadAllColormapLibraries('/colormaps')

  /* ── A scalar field on a rectilinear lattice ─────────────────────────────── */
  {
    const R = 128, C = 128
    const v = new Float32Array(R * C)
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const x = (c / C) * 6 - 3, y = (r / R) * 6 - 3
        v[r * C + c] = Math.sin(x * 1.7) * Math.cos(y * 1.7) * Math.exp(-(x * x + y * y) / 9)
      }
    }
    const fig = await createFigure({ container: el('heatmap'), session })
    const ax = fig.axes({ dataAspect: 1 })
    ax.colormap = 'RdBu'
    ax.xAxis.label = 'x'
    ax.yAxis.label = 'y'
    // A plain Float32Array — no GPU vocabulary in the caller.
    ax.image(v, gridDomain({ nx: C, ny: R, x: [-3, 3], y: [-3, 3] }), { clim: [-1, 1] })
  }

  /* ── A scalar on a mesh — the mesh IS the coordinate system ──────────────── */
  {
    const geometry = new TorusKnotGeometry(1, 0.32, 220, 32)
    const domain = meshDomain(geometry)
    const pos = geometry.attributes.position.array as Float32Array
    const scalar = new Float32Array(domain.count)
    for (let i = 0; i < domain.count; i++) scalar[i] = pos[i * 3 + 2]   // height

    const fig = await createFigure({ container: el('surface'), session })
    const ax = fig.axes({ projection: '3d' })
    ax.colormap = 'viridis'
    ax.surface(geometry, { domain, scalar, clim: [-1.4, 1.4] })
  }

  /* ── A vector field on a domain defined OUTSIDE the library ──────────────── */
  {
    const nr = 10, nt = 48
    const polar = polarDomain([nt, nr], { radius: [0.35, 2], angle: [0, Math.PI * 2] })
    // A swirl: each arrow tangent to its circle, growing outward.
    const vec = new Float32Array(polar.count * 3)
    for (let it = 0; it < nt; it++) {
      const a = ((it + 0.5) / nt) * Math.PI * 2
      for (let ir = 0; ir < nr; ir++) {
        const r = 0.35 + ((ir + 0.5) / nr) * 1.65
        const k = it * nr + ir
        vec[k * 3] = -Math.sin(a) * r
        vec[k * 3 + 1] = Math.cos(a) * r
        vec[k * 3 + 2] = 0
      }
    }
    const fig = await createFigure({ container: el('polar'), session })
    const ax = fig.axes({ projection: '3d' })
    /* Look straight down z. The field is planar, so the default three-quarter
       orbit foreshortens the circles into ellipses and the swirl stops reading as
       one. A polar chart wants the pole facing the camera. */
    ax.orbit = orbitLookingFrom({ x: 0, y: 0, z: 1 })
    ax.scaleBar = false
    ax.colormap = 'plasma'
    ax.quiver(vec, polar.count, 1, {
      dims: 3, domain: polar, clim: [0, 2], scale: 0.16, colorBy: 'magnitude',
    })
  }

  /* ── Stacked traces: a ridgeline, using what already exists ──────────────── */
  {
    const C = 28, S = 600
    const v = new Float32Array(C * S)
    for (let c = 0; c < C; c++) {
      // A travelling burst: each channel's event arrives a little later, so the
      // stack shows propagation the way a real multi-channel recording does.
      const t0 = 0.22 + (c / C) * 0.5
      for (let s = 0; s < S; s++) {
        const t = s / S
        const env = Math.exp(-((t - t0) ** 2) / 0.0009)
        const osc = Math.sin((t - t0) * 190) * env
        const noise = (Math.sin(s * 12.9898 + c * 78.233) * 43758.5453 % 1) * 0.06
        v[c * S + s] = osc + noise
      }
    }
    const fig = await createFigure({ container: el('ridgeline'), session })
    const ax = fig.axes()
    ax.colormap = 'cividis'
    ax.xAxis.label = 'time'
    ax.yAxis.label = 'channel'
    // No yExtent: the stack's own extent is derived from channelSpacing.
    ax.line(v, C, S, { channelSpacing: 1, gain: 0.45, xExtent: [0, 1] })
  }

  /* ── A time-varying bar chart from [rows × time] data ────────────────────── */
  {
    const R = 24, T = 240
    // Values in rows, time along columns — how a recording is stored. No
    // transpose: the drawable is told the layout instead.
    const v = new Float32Array(R * T)
    for (let r = 0; r < R; r++) {
      for (let t = 0; t < T; t++) {
        const phase = (r / R) * Math.PI * 2
        v[r * T + t] = 0.15 + 0.85 * Math.abs(Math.sin(t * 0.045 + phase)) ** 2
      }
    }
    // A unit quad whose origin is at its BASE, so scaling y grows it upward.
    const bar = new PlaneGeometry(0.72, 1)
    bar.translate(0, 0.5, 0)

    const fig = await createFigure({ container: el('bars'), session })
    const ax = fig.axes()
    ax.colormap = 'magma'
    ax.xAxis.label = 'channel'
    ax.yAxis.label = 'power'
    // `baseline: 0` sits the bars ON the axis. Without it they would grow from the
    // cell CENTRE of the y extent — which is what they did until the box plot found it.
    ax.glyphs(bar, gridDomain({ nx: R, ny: 1, x: [0, R], y: [0, 1] }), {
      baseline: 0, size: v, values: v, clim: [0, 1],
      frames: T, layout: 'row-major',
    })
  }

  /* ── Bands: an area, and the SAME primitive on a polar domain ────────────── */
  {
    const N = 240
    const fig = await createFigure({ container: el('bands'), session })

    // Left: a filled area under a curve.
    const ax1 = fig.subplot(1, 2, 1)
    ax1.colormap = 'mako'
    ax1.xAxis.label = 'frequency'
    ax1.yAxis.label = 'power'
    const spec = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const f = i / N
      spec[i] = 0.06
        + 0.85 * Math.exp(-((f - 0.14) ** 2) / 0.0008)
        + 0.45 * Math.exp(-((f - 0.32) ** 2) / 0.004)
        + 0.18 * Math.exp(-((f - 0.62) ** 2) / 0.02)
    }
    ax1.band(gridDomain({ nx: N, ny: 1, x: [0, 1], y: [0, 1] }), spec, { clim: [0, 1] })

    // Right: the same primitive, a polar domain — a rose. No new code.
    const ax2 = fig.subplot(1, 2, 2, { projection: '3d' })
    ax2.orbit = orbitLookingFrom({ x: 0, y: 0, z: 1 })
    ax2.scaleBar = false
    ax2.colormap = 'magma'
    const M = 180
    const petals = new Float32Array(M)
    for (let i = 0; i < M; i++) {
      const a = (i / (M - 1)) * Math.PI * 2
      petals[i] = 0.25 + 0.75 * Math.abs(Math.cos(a * 3)) ** 0.7
    }
    ax2.band(polarDomain([M, 1], { radius: [0, 1], angle: [0, Math.PI * 2] }), petals, {
      clim: [0, 1],
    })
  }

  /* ── A box plot: a CHART composed outside the library ────────────────────── */
  {
    // Four groups, five-number summaries.
    const groups = [
      { low: 0.8, q1: 2.1, median: 2.9, q3: 3.7, high: 4.9 },
      { low: 1.4, q1: 2.9, median: 3.4, q3: 4.1, high: 5.6 },
      { low: 0.3, q1: 1.4, median: 2.2, q3: 3.4, high: 5.1 },
      { low: 2.2, q1: 3.2, median: 3.8, q3: 4.4, high: 5.3 },
      { low: 1.0, q1: 1.9, median: 2.5, q3: 3.0, high: 4.2 },
    ]
    const fig = await createFigure({ container: el('boxplot'), session })
    const ax = fig.axes()
    ax.xAxis.label = 'condition'
    ax.yAxis.label = 'response'
    boxPlot(ax, groups, { color: 0x9fd4c7 })
  }

  /* ── The SAME Image on a polar domain — a radial time-frequency map ─────── */
  {
    const nt = 220, nr = 48                     // angle × radius
    const v = new Float32Array(nr * nt)         // [radius][angle], row-major
    for (let r = 0; r < nr; r++) {
      for (let a = 0; a < nt; a++) {
        const th = (a / nt) * Math.PI * 2
        const rr = r / nr
        v[r * nt + a] = 0.5 + 0.5 * Math.sin(th * 4 + rr * 7) * Math.exp(-((rr - 0.55) ** 2) / 0.06)
      }
    }
    const fig = await createFigure({ container: el('polarraster'), session })
    const ax = fig.axes({ projection: '3d' })
    ax.orbit = orbitLookingFrom({ x: 0, y: 0, z: 1 })
    ax.scaleBar = false
    ax.colormap = 'turbo'
    ax.image(v, polarDomain([nt, nr], { radius: [0.25, 1], angle: [0, Math.PI * 2] }), {
      clim: [0, 1],
    })
  }

  session.start()
}

const el = (id: string): HTMLElement => document.getElementById(id)!

main().catch(fail)
