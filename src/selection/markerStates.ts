/**
 * What an interaction marker LOOKS like, per role and per state.
 *
 * Two channels, not one. `base` is the diffuse colour and `glow` is the emissive, and
 * the reason they differ is the surface underneath: a marker sits on a colormapped
 * cortex where the bright end of `inferno` is brighter than any UI colour, so a
 * marker tinted with the role colour disappears into it. Resting markers are
 * therefore DARK — a contrast well — and read as the role through their emissive rim.
 * That inversion is the one non-obvious thing here, and it is why this file exists
 * rather than the call site picking a colour.
 *
 * The M3 state-layer model from `@nxr/tokens` deliberately does NOT transcribe: a
 * translucent overlay on top of a colour is a DOM compositing trick, and a three
 * material swaps the colour itself.
 *
 * Tokens are read if present (`--threecharts-marker-*`, the Tier-2 chart vocabulary)
 * and otherwise fall back to the values below, so this works in a host that has not
 * defined them and improves silently in one that has.
 */

import { readCssColorHex } from '../css'

export type MarkerRole = 'primary' | 'secondary' | 'error'
export type MarkerState = 'rest' | 'hover' | 'pressed' | 'disabled'

/** Fallbacks — the resting BASE is near-black on purpose (see the header). */
const FALLBACK_BASE: Record<MarkerRole, Record<MarkerState, number>> = {
  primary: { rest: 0x0a0c10, hover: 0x7ce7c4, pressed: 0x4fd1a5, disabled: 0x2a2e36 },
  secondary: { rest: 0x0a0c10, hover: 0x7fd4ff, pressed: 0x4fb8ef, disabled: 0x2a2e36 },
  error: { rest: 0x0a0c10, hover: 0xff9a9a, pressed: 0xef6b6b, disabled: 0x2a2e36 },
}
const FALLBACK_GLOW: Record<MarkerRole, Record<MarkerState, number>> = {
  primary: { rest: 0x33e0a1, hover: 0x8affd0, pressed: 0x22b37f, disabled: 0x40454f },
  secondary: { rest: 0x35a7e0, hover: 0x8ad8ff, pressed: 0x2280b3, disabled: 0x40454f },
  error: { rest: 0xe05a5a, hover: 0xff9a9a, pressed: 0xb33c3c, disabled: 0x40454f },
}

/** The diffuse colour for a marker in this role and state. */
export function markerBaseHex(role: MarkerRole, state: MarkerState): number {
  return readCssColorHex(`--threecharts-marker-${role}-base-${state}`, FALLBACK_BASE[role][state])
}

/** The emissive colour — what makes the marker findable against a bright colormap. */
export function markerGlowHex(role: MarkerRole, state: MarkerState): number {
  return readCssColorHex(`--threecharts-marker-${role}-glow-${state}`, FALLBACK_GLOW[role][state])
}

/** `0xRRGGBB` → normalized `[r, g, b]`, for a buffer a shader reads. */
export function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255]
}
