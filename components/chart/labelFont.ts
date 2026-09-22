/**
 * The font used by the canvas-drawn labels (on-chart pip labels, fib level
 * labels, the position R:R block).
 *
 * Tailwind classes cannot reach text painted into a canvas, so the family and
 * size are resolved here instead. `next/font` hashes the Ubuntu family
 * name at build time and exposes it as the CSS variable `--font-mono-ui`, so
 * the only way to get the real family is to read the computed style at runtime.
 *
 * That read forces a style recalculation, so it is done once and cached — never
 * per label, which would mean a layout flush inside the draw loop.
 */

/** Matches `--text-small` (13px). Multiply by the pixel ratio at paint time. */
export const LABEL_FONT_PX = 13;

/** Used before the webfont resolves, and on the server. */
const FALLBACK_FAMILY = 'Ubuntu, ui-sans-serif, system-ui, sans-serif';

let cached: string | null = null;

/**
 * The `font-family` list for canvas labels, e.g.
 * `"__Ubuntu_abc123", Ubuntu, …`.
 *
 * An empty variable (SSR, or a paint before the font CSS has been applied) is
 * deliberately NOT cached: the fallback is returned and the next frame tries
 * again, so the labels pick up Ubuntu as soon as it exists.
 */
export function labelFontFamily(): string {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') return FALLBACK_FAMILY;
  const name = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono-ui')
    .trim();
  if (name === '') return FALLBACK_FAMILY;
  cached = `${name}, ${FALLBACK_FAMILY}`;
  return cached;
}
