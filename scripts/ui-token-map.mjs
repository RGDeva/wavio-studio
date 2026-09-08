/**
 * P3-1d — the single, reviewable mapping from ad-hoc `text-white/NN` opacities
 * onto the semantic text hierarchy.
 *
 * Exported (not inlined in a one-off sed) so a test can pin it: the contrast
 * repair below is a deliberate product decision, not an incidental refactor.
 *
 * Everything at or below 35% opacity was rendering MEANINGFUL text — labels,
 * timestamps, counts — at a contrast ratio that fails on near-black. Those all
 * land on `fg-quaternary` (46%), which is a visible lift. `fg-disabled` is
 * reserved for genuinely inert affordances and is applied by hand, never by
 * this map, so nothing silently stays unreadable.
 */
export const TEXT_MAP = {
  100: 'text-fg', 95: 'text-fg', 90: 'text-fg', 85: 'text-fg',
  80: 'text-fg-secondary', 75: 'text-fg-secondary', 70: 'text-fg-secondary',
  65: 'text-fg-tertiary', 60: 'text-fg-tertiary', 55: 'text-fg-tertiary', 50: 'text-fg-tertiary',
  // ── contrast repair below this line ──
  45: 'text-fg-quaternary', 40: 'text-fg-quaternary', 35: 'text-fg-quaternary',
  30: 'text-fg-quaternary', 25: 'text-fg-quaternary', 20: 'text-fg-quaternary',
  15: 'text-fg-quaternary', 10: 'text-fg-quaternary',
};

/** Opacities whose contrast this migration deliberately raises. */
export const CONTRAST_REPAIRED = [45, 40, 35, 30, 25, 20, 15, 10];

/** Ad-hoc sizes that are below comfortable reading size on a desktop surface. */
export const SIZE_MAP = {
  'text-[8px]': 'text-meta',
  'text-[9px]': 'text-meta',
  'text-[10px]': 'text-meta',
  'text-[11px]': 'text-meta',
};
