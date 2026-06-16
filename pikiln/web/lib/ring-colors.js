// Per-ring colors. Used by the firing-curve chart (line colors) and the
// dashboard temperature tiles (bottom accent strip). Keeping them in one
// place ensures the operator can match a tile to its line on the chart at
// a glance — change the palette here and both surfaces update.
//
// Order matches the ring index 0..2 (= ring 1..3 in code, = bottom→top in
// Bruce's L&L wiring; see constants.RING_POSITION_LABELS).
export const RING_COLORS = [
  '#e94560',  // Ring 1 / Bottom — red-pink (matches the existing "firing" indicator)
  '#f0a020',  // Ring 2 / Mid    — orange
  '#20d0a0',  // Ring 3 / Top    — teal-green
];
