/** A normalized position rect within a Figure: `{left, bottom, width, height}` in
 *  [0,1], bottom-left origin (MATLAB `axes('Position',…)` convention). */
export interface PositionRect { left: number; bottom: number; width: number; height: number }

/**
 * subplotRect — MATLAB `subplot(rows, cols, index)` as a normalized position rect,
 * including MATLAB's SPANNING form `subplot(rows, cols, [i, j, …])` (pass an index
 * array → the Axes covers the bounding box of those cells; e.g. `[1,2]` = the whole
 * top row of a 2×2, `[1,3]` = the left column).
 *
 * **1-based**, row-major, cell 1 = TOP-left — MATLAB's numbering, because this
 * function claims MATLAB's name and its documentation claims MATLAB's semantics, and
 * a `subplot` that renumbers them is a trap for exactly the audience the name is
 * aimed at. `subplot(2,2,1)` is the top-left cell here as it is there.
 *
 * It was 0-based, deliberately, with a good argument recorded: JS indexing means
 * `cells.map((c, i) => subplotRect(r, cols, i))` works directly. That argument lost
 * to the far more common case of a person typing a cell number, and the mapping case
 * costs one character — `i + 1`. Out-of-range or empty indices throw, so a stray
 * index fails loudly instead of silently misplacing a plot.
 *
 * `gutter` is EXTRA gap between cells as a fraction of a grid cell (0–1): the (possibly
 * spanned) rect is inset by `gutter/2` on every side. It DEFAULTS TO 0 — cells touch,
 * MATLAB-`subplot` style, and each Axes' own (asymmetric) chrome margins provide the
 * separation. Raise it only when you want additional visual air between cells.
 */
export function subplotRect(rows: number, cols: number, index: number | number[], gutter = 0): PositionRect {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1)
    throw new RangeError(`subplot grid must be positive integers, got ${rows}×${cols}`)
  const cellCount = rows * cols
  const indices = Array.isArray(index) ? index : [index]
  if (indices.length === 0) throw new RangeError('subplot index range is empty')

  // Bounding box (in grid coords) of every cell in the span.
  let rMin = Infinity, rMax = -Infinity, cMin = Infinity, cMax = -Infinity
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 1 || i > cellCount)
      throw new RangeError(`subplot index ${i} out of range [1, ${cellCount}] for a ${rows}×${cols} grid`)
    const r = Math.floor((i - 1) / cols), c = (i - 1) % cols   // row from TOP
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r)
    cMin = Math.min(cMin, c); cMax = Math.max(cMax, c)
  }

  const cellW = 1 / cols, cellH = 1 / rows
  const insetX = (gutter * cellW) / 2, insetY = (gutter * cellH) / 2
  return {
    left:   cMin * cellW + insetX,
    bottom: (rows - 1 - rMax) * cellH + insetY,          // bottom = the LOWEST row in the span
    width:  (cMax - cMin + 1) * cellW - 2 * insetX,
    height: (rMax - rMin + 1) * cellH - 2 * insetY,
  }
}
