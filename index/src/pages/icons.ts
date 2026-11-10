// The icons: Phosphor's, as the Forest app draws them, each by Phosphor's own name. Every file is read
// once, at start, from @phosphor-icons/core, and drawn into the page as its own SVG, so a page asks no
// other site and runs no script for one. Regular for an action; filled inside an avatar, a badge or a
// rating; bold where a small one must hold its weight. Each draws in its text's color and is hidden
// from screen readers: the words beside it, or its parent's, say what it is. A name not read here
// stops the start, so a page never misses one.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ICONS } from '../avatar.ts'
import { Raw } from './html.ts'

export type Weight = 'regular' | 'fill' | 'bold'

/** Every icon a page draws, with each weight it is drawn in; every market icon is drawn filled too. */
const USED: { [weight in Weight]: string[] } = {
  regular: ['arrow-left', 'caret-down', 'caret-right', 'file-code', 'github-logo', 'info', 'magnifying-glass', 'map-pin', 'sliders-horizontal', 'sparkle', 'star'],
  fill: ['identification-card', 'smiley', 'star', ...Object.values(ICONS)],
  bold: ['arrow-up-right', 'handshake', 'paper-plane-tilt', 'x'],
}

/** One file's drawing: what is inside its `<svg>`, in Phosphor's 256-unit box. */
function read(name: string, weight: Weight): string {
  const file = fileURLToPath(import.meta.resolve(`@phosphor-icons/core/assets/${weight}/${name}${weight === 'regular' ? '' : `-${weight}`}.svg`))
  const svg = readFileSync(file, 'utf8')
  const inner = /^<svg [^>]*viewBox="0 0 256 256"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg)?.[1]
  if (!inner) throw new Error(`${file}: not a Phosphor icon in a 256-unit box`)
  return inner
}

const DRAWN = new Map(Object.entries(USED).flatMap(([weight, names]) => names.map((name) => [`${name} ${weight}`, read(name, weight as Weight)] as const)))

/** An icon by its Phosphor name, in `weight`; `xs` for the small one beside a link's words, else the size its place gives it. */
export function icon(name: string, weight: Weight = 'regular', size?: 'xs'): Raw {
  const inner = DRAWN.get(`${name} ${weight}`)
  if (inner === undefined) throw new Error(`no ${weight} icon ${name}: add it to USED in pages/icons.ts`)
  return new Raw(`<svg class="${size ? `i ${size}` : 'i'}" data-icon="${name}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`)
}
