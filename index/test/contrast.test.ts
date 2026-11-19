// The front page's tiles: white words on each market's color. A tile's name is large text, at
// least 3:1 on every color in the palette; its counts are small, so they sit on the fade laid behind
// them, at least 4.5:1 on every color, light and dark (WCAG 2's contrast ratio, sRGB). The numbers
// are template.ts's TILE, which its stylesheet is drawn from.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PALETTE } from '../src/avatar.ts'
import { TILE } from '../src/pages/template.ts'

const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
/** A color with black laid over it at `alpha`. */
const under = (rgb: [number, number, number], alpha: number) => rgb.map((c) => c * (1 - alpha)) as [number, number, number]
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const WHITE: [number, number, number] = [1, 1, 1]

test("a tile's name is large text: 19px at weight 800, past 18.66px bold", () => {
  assert.ok(TILE.name >= 18.66 && TILE.nameWeight >= 700)
})

test('the name, white, is at least 3:1 on every color, light and dark', () => {
  for (const color of PALETTE) {
    assert.ok(ratio(WHITE, rgbOf(color)) >= 3, `${color} light: ${ratio(WHITE, rgbOf(color)).toFixed(2)}`)
    assert.ok(ratio(WHITE, under(rgbOf(color), TILE.dark)) >= 3, `${color} dark`)
  }
})

test('the counts sit on the full fade, on the least tall tile, phone and laptop', () => {
  for (const height of [TILE.height, TILE.laptopHeight]) {
    const top = ((height - TILE.pad - TILE.countsLine) / height) * 100
    assert.ok(top >= TILE.fadeFull, `the counts start at ${top.toFixed(1)}% of a ${height}px tile, above the fade's full strength at ${TILE.fadeFull}%`)
  }
})

test('the counts, white, are at least 4.5:1 on every color under the fade, light and dark', () => {
  for (const color of PALETTE) {
    const light = ratio(WHITE, under(rgbOf(color), TILE.fade))
    const dark = ratio(WHITE, under(under(rgbOf(color), TILE.dark), TILE.fade))
    assert.ok(light >= 4.5, `${color} light: ${light.toFixed(2)}`)
    assert.ok(dark >= 4.5, `${color} dark: ${dark.toFixed(2)}`)
  }
  // Without the fade, six of the ten fall short, which is why it is there.
  assert.equal(PALETTE.filter((c) => ratio(WHITE, rgbOf(c)) < 4.5).length, 6)
})
