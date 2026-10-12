// Colours for the pane: a tinted tile with a matching edge per state.
// Every value is a theme key, not a hex colour: the drawing surface resolves keys for
// the app's own light or dark mode, which a plugin cannot read. Chosen from a live probe
// of the desktop app in both modes (2026-10-05). The theme has no soft amber, so
// "needs you" uses a neutral tile with an amber edge and title.
export type Tone = 'needs' | 'working' | 'done' | 'failed' | 'neutral' | 'ok' | 'warn' | 'off'
export type Swatch = { bg: string; edge: string; text: string }
export type Palette = Record<Tone, Swatch> & { dim: string; accent: string }

const needs = { bg: 'userMessageBackground', edge: 'warning', text: 'warning' }
const working = { bg: 'background', edge: 'suggestion', text: 'suggestion' }
const done = { bg: 'diffAddedDimmed', edge: 'success', text: 'success' }
const failed = { bg: 'diffRemovedDimmed', edge: 'error', text: 'error' }
const neutral = { bg: 'userMessageBackground', edge: 'promptBorder', text: 'text' }

const KEYED: Palette = { needs, working, done, failed, neutral, ok: done, warn: needs, off: neutral, dim: 'inactive', accent: 'claude' }

// Kept as two names so callers that pick by theme still work; both resolve per mode.
export const PALETTES: { dark: Palette; light: Palette } = { dark: KEYED, light: KEYED }
