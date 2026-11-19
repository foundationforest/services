// The animals: the app's list and rule, so a profile is the same animal in the app and on these
// pages. Each address below is pinned to the animal the app's own src/animals.ts gives it, worked out
// from the app's file at the commit src/animals.ts names, so the two never drift: a change to the
// list, its order or the hash moves a pin. And the hash is 32-bit FNV-1a, by its published vectors.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ANIMALS, animalOf, fnv1a } from '../src/animals.ts'

test("each address is the animal the app's own file gives it", () => {
  const pins: Array<[string, string]> = [
    ['C5yW9gqAe32URgp7dpZyYQ3nQ7KsNE9vWnpdiCGMYoL7', 'ladybug'],
    ['D4sGvxFxKsf8HbPvK6711oe9kLQLBZGGJJ9ZM2ExRiKe', 'penguin'],
    ['8KgwM5aVJr3eYbJ8oN7Z1y1Jc', 'bear'],
    ['AbmjkNZy1111111111111111111111111111111111', 'crab'],
    ['4H5vL1ym1111111111111111111111111111111111', 'horse'],
    ['', 'parrot'],
  ]
  for (const [address, animal] of pins) assert.equal(animalOf(address)[0], animal, address)
})

test('forty animals, each once, in the app\'s order, each drawn on a 32 grid', () => {
  assert.equal(ANIMALS.length, 40)
  assert.equal(new Set(ANIMALS.map(([name]) => name)).size, 40)
  assert.deepEqual(ANIMALS.slice(0, 5).map(([name]) => name), ['fox', 'cat', 'dog', 'rabbit', 'bear'])
  assert.equal(ANIMALS.at(-1)![0], 'llama')
  for (const [name, paths] of ANIMALS) {
    assert.ok(paths.length > 0, name)
    for (const p of paths) assert.match(typeof p === 'string' ? p : p.d, /^M[\d.\s,MLHVCSQTAZmlhvcsqtaz-]+$/, name)
  }
})

test('the hash is 32-bit FNV-1a over UTF-8 bytes', () => {
  assert.equal(fnv1a(''), 0x811c9dc5)
  assert.equal(fnv1a('a'), 0xe40c292c)
  assert.equal(fnv1a('foobar'), 0xbf9cf968)
})
