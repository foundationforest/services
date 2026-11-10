// The app's own color rule, for test/avatar.test.ts alone: foundationforest/app's src/colors.ts at
// 2e16052, copied unchanged below this note, since this repo's checks have no checkout of the app.
// The index draws with ../src/avatar.ts, the one module the app can import in its place.

// A market's color, from a palette of ten. Each market's first choice is its name's, by a small
// stable hash (FNV-1a), so no color is tied to a name. The directory is walked in its order, and
// each market takes its first choice, or the next color after it not yet taken; once all ten are
// taken, a new round of ten begins, so colors repeat only past ten markets. Everyone has the same
// directory, so every device gives a market the same color. A market the directory doesn't list
// takes its first choice. Its own module, with no drawing in it, so a test reads it as it is.

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
