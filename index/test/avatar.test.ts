// The avatar rule the app and the index share (src/avatar.ts): every market in the directory gets
// the color the app's own module gives it, past ten markets too; the hash is 32-bit FNV-1a over the
// name's UTF-8 bytes; each icon the table names is a Phosphor icon; a market it doesn't name shows
// its first letter.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { loadMarkets } from '@foundationforest/markets'

import { colorIn, colorsFor, fnv1a, ICONS, iconOf, PALETTE } from '../src/avatar.ts'
import { avatarHtml } from '../src/pages/common.ts'
import { siteOf } from '../src/pages/template.ts'
import * as app from './app-colors.ts'
import { MARKETS } from './world.ts'

const markets = loadMarkets(MARKETS)
const names = markets.directory.markets.map((m) => m.name)

test("every market in the directory gets the color the app's own module gives it", () => {
  assert.ok(names.length > 1)
  assert.deepEqual([...PALETTE], [...app.PALETTE])
  assert.deepEqual(colorsFor(names), app.colorsFor(names))
  for (const name of names) assert.ok(PALETTE.includes(colorsFor(names)[name] as (typeof PALETTE)[number]), name)
  // A market the directory doesn't list takes its first choice, as in the app.
  for (const name of [...names, 'knitting', 'cours-de-français']) assert.equal(colorIn(colorsFor(names), name), app.colorIn(app.colorsFor(names), name), name)
  // Past ten markets a new round of ten begins: the same as the app's, in any order.
  const many = Array.from({ length: 23 }, (_, n) => `market-${n}`)
  assert.deepEqual(colorsFor(many), app.colorsFor(many))
  assert.deepEqual(colorsFor([...names].reverse()), app.colorsFor([...names].reverse()))
})

test("each market's first choice is 32-bit FNV-1a over its name's UTF-8 bytes", () => {
  // FNV-1a's published 32-bit vectors.
  assert.equal(fnv1a(''), 0x811c9dc5)
  assert.equal(fnv1a('a'), 0xe40c292c)
  assert.equal(fnv1a('foobar'), 0xbf9cf968)
  for (const name of [...names, 'cours-de-français']) assert.equal(fnv1a(name), app.fnv1a(name), name)
})

test('each icon the table names is a Phosphor icon, regular and filled; a market it does not name shows its first letter', () => {
  for (const name of Object.values(ICONS)) {
    for (const file of [`regular/${name}.svg`, `fill/${name}-fill.svg`]) assert.ok(existsSync(fileURLToPath(import.meta.resolve(`@phosphor-icons/core/assets/${file}`))), file)
  }
  assert.equal(iconOf('tutoring'), 'graduation-cap')
  assert.equal(iconOf('knitting'), null)
  const site = siteOf(markets, [])
  assert.equal(String(avatarHtml(site, 'knitting', { size: 'lg' })), `<span class="av lg" style="--h:${PALETTE[fnv1a('knitting') % 10]}" aria-hidden="true"><span class="letter">K</span></span>`)
})
