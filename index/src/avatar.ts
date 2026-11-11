// A market's avatar, one rule for the Forest app and the index: its icon on its color. A profile's
// avatar is solid when its role's listings are offers and light when they are requests; that part is
// each one's own drawing. This module has no imports, so the app imports it by path from its checkout
// of services, as it imports the host's credits client.
//
// A market's color comes from a palette of ten. Each market's first choice is its name's place in
// it, by a small stable hash (32-bit FNV-1a), so no color is tied to a name. The directory is walked
// in its order, and each market takes its first choice, or the next color after it not yet taken;
// once all ten are taken, a new round of ten begins, so colors repeat only past ten markets. Every
// copy of the directory gives a market the same color. A market the directory doesn't list takes its
// first choice. Its icon comes from a small table of Phosphor's names, a nicety: a market the table
// doesn't list shows its name's first letter. The table may hold names the directory no longer has,
// and miss new ones.

/** The ten colors a market's avatar takes. */
export const PALETTE = ['#3d76c9', '#b6508d', '#5a60c8', '#1e998c', '#d97a2b', '#7a5bc9', '#d4524e', '#6a9f2a', '#2f86a6', '#a0742f'] as const

/** 32-bit FNV-1a over the UTF-8 bytes of `text`. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash
}

/** A market's first choice: its name's place in the palette. */
const firstChoice = (market: string) => fnv1a(market) % PALETTE.length

/** Each market's color, by name, for a directory's markets in its order. */
export function colorsFor(markets: readonly string[]): Record<string, string> {
  const colors: Record<string, string> = {}
  let taken = new Set<number>()
  for (const market of markets) {
    if (Object.hasOwn(colors, market)) continue
    if (taken.size === PALETTE.length) taken = new Set()
    let at = firstChoice(market)
    while (taken.has(at)) at = (at + 1) % PALETTE.length
    taken.add(at)
    colors[market] = PALETTE[at]!
  }
  return colors
}

/** A market's color among `colors` (colorsFor's), else its first choice. */
export const colorIn = (colors: Record<string, string>, market: string): string => (Object.hasOwn(colors, market) ? colors[market]! : PALETTE[firstChoice(market)]!)

/** The markets with an icon of their own, each by its Phosphor name. */
export const ICONS: Readonly<Record<string, string>> = {
  'freelance-design': 'palette',
  'freelance-software': 'code',
  'freelance-video': 'film-strip',
  goods: 'tag',
  'home-cleaning': 'broom',
  'home-repair': 'wrench',
  'language-exchange': 'translate',
  'sports-coaching': 'soccer-ball',
  'stays-free': 'couch',
  'stays-work': 'barn',
  tours: 'map-trifold',
  tutoring: 'graduation-cap',
}

/** A market's icon, by its Phosphor name, or null: its avatar then shows its first letter. */
export const iconOf = (market: string): string | null => (Object.hasOwn(ICONS, market) ? ICONS[market]! : null)
