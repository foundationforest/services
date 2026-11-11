// The icons: Phosphor's, as the Forest app draws them, each by Phosphor's own name. Each file is read
// once, from @phosphor-icons/core, and drawn into the page as its own SVG, so a page asks no
// other site and runs no script for one. Regular for an action; filled inside an avatar, a badge or a
// rating; bold where a small one must hold its weight. Each draws in its text's color and is hidden
// from screen readers: the words beside it, or its parent's, say what it is. A name the pages use
// that is not read here stops the start, so a page never misses one. A market's icon is its market
// file's, read the first time a page draws it; one this copy of Phosphor lacks is never drawn, and
// never stops the start: the market's avatar shows its first letter (common.ts), and the index's
// tests fail on any icon the markets accept that this copy lacks.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Raw } from './html.ts'

export type Weight = 'regular' | 'fill' | 'bold'

/** Every icon a page draws, but the markets', with each weight it is drawn in. */
const USED: { [weight in Weight]: string[] } = {
  regular: ['arrow-left', 'caret-down', 'caret-right', 'file-code', 'github-logo', 'info', 'magnifying-glass', 'map-pin', 'sliders-horizontal', 'sparkle', 'star'],
  fill: ['identification-card', 'smiley', 'star'],
  bold: ['arrow-up-right', 'handshake', 'paper-plane-tilt', 'x'],
}

/** Where an icon's file is in @phosphor-icons/core. */
export const fileOf = (name: string, weight: Weight) => fileURLToPath(import.meta.resolve(`@phosphor-icons/core/assets/${weight}/${name}${weight === 'regular' ? '' : `-${weight}`}.svg`))

/** One file's drawing: what is inside its `<svg>`, in Phosphor's 256-unit box. */
function read(name: string, weight: Weight): string {
  const file = fileOf(name, weight)
  const svg = readFileSync(file, 'utf8')
  const inner = /^<svg [^>]*viewBox="0 0 256 256"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg)?.[1]
  if (!inner) throw new Error(`${file}: not a Phosphor icon in a 256-unit box`)
  return inner
}

const DRAWN = new Map(Object.entries(USED).flatMap(([weight, names]) => names.map((name) => [`${name} ${weight}`, read(name, weight as Weight)] as const)))

const svgOf = (name: string, inner: string, size?: 'xs') =>
  new Raw(`<svg class="${size ? `i ${size}` : 'i'}" data-icon="${name}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`)

/** An icon by its Phosphor name, in `weight`; `xs` for the small one beside a link's words, else the size its place gives it. */
export function icon(name: string, weight: Weight = 'regular', size?: 'xs'): Raw {
  const inner = DRAWN.get(`${name} ${weight}`)
  if (inner === undefined) throw new Error(`no ${weight} icon ${name}: add it to USED in pages/icons.ts`)
  return svgOf(name, inner, size)
}

/** Each market icon read so far, by its name: its drawing, or null when this copy of Phosphor has none. */
const MARKETS = new Map<string, string | null>()

/** A market's icon, filled, by the name its market file gives; null when this copy of Phosphor has no such icon. */
export function marketIconOf(name: string): Raw | null {
  if (!MARKETS.has(name)) {
    let inner: string | null = null
    // A name is lowercase words joined by hyphens, as the markets' check holds it, so it names a file in the package and nothing else.
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      try {
        inner = read(name, 'fill')
      } catch {
        // Not in this copy of Phosphor: the avatar shows the market's first letter.
      }
    }
    MARKETS.set(name, inner)
  }
  const inner = MARKETS.get(name)!
  return inner === null ? null : svgOf(name, inner)
}
