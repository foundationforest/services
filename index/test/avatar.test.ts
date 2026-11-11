// A market's avatar (src/avatar.ts, pages/common.ts): its color is its number cycled through the
// index's palette of ten, so neighbours differ; its icon is the one its market file names, else its
// first letter, and one this copy of Phosphor lacks never stops the index, the letter drawn instead;
// and every icon the markets accept (their build/icons.json) is in this copy of Phosphor, so a gap
// fails here, never on a page.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { loadMarkets, type Market } from '@foundationforest/markets'

import { colorFor, NO_NUMBER, PALETTE } from '../src/avatar.ts'
import { avatarHtml, colorOf } from '../src/pages/common.ts'
import { fileOf } from '../src/pages/icons.ts'
import { siteOf } from '../src/pages/template.ts'
import { MARKETS } from './world.ts'

const markets = loadMarkets(MARKETS)
const site = siteOf(markets, [])

test("a market's color is its number cycled through the palette: neighbours differ, and every ten it repeats", () => {
  assert.equal(new Set(PALETTE).size, 10)
  for (let n = 1; n <= 30; n++) {
    assert.equal(colorFor(n), PALETTE[(n - 1) % 10], `${n}`)
    assert.notEqual(colorFor(n), colorFor(n + 1), `${n} and ${n + 1}`)
  }
  assert.equal(colorFor(1), PALETTE[0])
  assert.equal(colorFor(11), colorFor(1))
  // No number, or none a market file could hold: the quiet ink.
  for (const n of [undefined, 0, -1, 1.5]) assert.equal(colorFor(n), NO_NUMBER, `${n}`)
  // Each market in the directory by its own number: wardrobe's 11 takes lessons' 1's color.
  for (const m of markets.directory.markets) assert.equal(colorOf(site, m.name), PALETTE[(m.number - 1) % 10], m.name)
  assert.equal(colorOf(site, 'wardrobe'), colorOf(site, 'lessons'))
  // A market the directory does not list has no number.
  assert.equal(colorOf(site, 'knitting'), NO_NUMBER)
})

test("a market's icon is its market file's, else its first letter; one this copy of Phosphor lacks shows the letter and stops nothing", () => {
  const drawn = (name: string) => String(avatarHtml(site, name, { size: 'lg' }))
  assert.equal(markets.market('lessons')!.icon, 'graduation-cap')
  assert.match(drawn('lessons'), new RegExp(`^<span class="av lg" style="--h:${PALETTE[0]}" aria-hidden="true"><svg class="i" data-icon="graduation-cap" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">.+</svg></span>$`))
  assert.equal(markets.market('matches')!.icon, undefined)
  assert.equal(drawn('matches'), `<span class="av lg" style="--h:${PALETTE[1]}" aria-hidden="true"><span class="letter">M</span></span>`)
  assert.equal(drawn('knitting'), `<span class="av lg" style="--h:${NO_NUMBER}" aria-hidden="true"><span class="letter">K</span></span>`)
  // A market naming an icon this copy lacks, or a name that is no icon's: the letter.
  for (const icon of ['no-such-icon', '../fill/star', 'Star']) {
    const odd: Market = { ...markets.market('lessons')!, name: 'odd', icon, number: 5 }
    const oddSite = siteOf({ ...markets, market: (name) => (name === 'odd' ? odd : markets.market(name)) }, [])
    assert.equal(String(avatarHtml(oddSite, 'odd')), `<span class="av" style="--h:${PALETTE[4]}" aria-hidden="true"><span class="letter">O</span></span>`, icon)
  }
})

test("every icon the markets accept, their build/icons.json, is in this index's copy of Phosphor, filled", () => {
  const icons = (JSON.parse(readFileSync(new URL('icons.json', import.meta.resolve('@foundationforest/markets/package.json')), 'utf8')) as { icons: string[] }).icons
  assert.ok(icons.length > 1000)
  const missing = icons.filter((name) => !existsSync(fileOf(name, 'fill')))
  assert.deepEqual(missing, [])
})
