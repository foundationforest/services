// README.md says what the code holds: the codes its Its API lists are CODES, and its table of bands
// is BANDS. Each is read from the README as a person reads it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CODES } from '../src/codes.ts'
import { BANDS } from '../src/places.ts'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test("the codes README.md's Its API lists are CODES, each once", () => {
  const errors = README.slice(README.indexOf('Errors are `{ "error": "<code>" }`'), README.indexOf('## How we run it'))
  const listed = [...errors.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, code]) => code!)
  assert.equal(new Set(CODES).size, CODES.length, 'no code twice in the list')
  assert.deepEqual(listed, [...CODES])
})

test("README.md's bands are BANDS: from how many people, and each radius", () => {
  const table = [...README.matchAll(/^ {2}\| (under [\d,]+|[\d,]+ to [\d,]+|[\d,]+ and over) \| (\d) \| (\d+) \|$/gm)]
  assert.deepEqual(
    table.map(([, people, band, km]) => ({ people: people!.startsWith('under') ? 0 : Number(people!.split(' ')[0]!.replaceAll(',', '')), band: Number(band), km: Number(km) })),
    BANDS.map((b, band) => ({ ...b, band })),
  )
})
