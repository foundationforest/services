// A market's color, as this index draws its avatar: its number, from its market file, cycled through
// this index's palette of ten, so markets numbered next to each other look different and colors
// repeat only every ten numbers. The palette is this index's own: the markets give each market a
// number so that every app picks its own colors from it (the markets manual, Naming). A market the
// directory no longer lists has no number here, and takes the pages' quiet ink. This module has no
// imports, so any app may import it by path to draw markets as this index does.

/** The ten colors a market's avatar takes, the first for market 1. */
export const PALETTE = ['#3d76c9', '#b6508d', '#5a60c8', '#1e998c', '#d97a2b', '#7a5bc9', '#d4524e', '#6a9f2a', '#2f86a6', '#a0742f'] as const

/** What a market with no number is drawn in: the pages' quiet ink. */
export const NO_NUMBER = 'var(--ink3)'

/** A market's color, by its number: 1 takes the first color, 11 the first again; NO_NUMBER with none. */
export const colorFor = (number: number | undefined): string => (Number.isInteger(number) && number! >= 1 ? PALETTE[(number! - 1) % PALETTE.length]! : NO_NUMBER)
