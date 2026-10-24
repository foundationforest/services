// The facts recipes, pinned (test/vectors.json): each value the verifier's code gives, and the same
// value made again by hand, SHA-256 from node:crypto and Poseidon from poseidon-lite directly. And
// poseidon-lite shown to be the standard's Poseidon: it gives the stamp number keys/ gives, the one
// keys/ pins in its own test vectors.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { PREFIX, nameHashOf, seedScalar, verifierSecret } from '@foundationforest/keys'
import { b64u, hex } from '@foundationforest/records'
import { poseidon1 } from 'poseidon-lite/poseidon1'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import { poseidon3 } from 'poseidon-lite/poseidon3'
import { poseidon5 } from 'poseidon-lite/poseidon5'

import { daysOf, faceFacts, h, idFacts, person } from '../src/facts.ts'

const vectors = JSON.parse(readFileSync(new URL('vectors.json', import.meta.url), 'utf8'))

/** BN254's scalar order, written out here rather than taken from keys/. */
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
/** h by hand: SHA-256, read big-endian, mod R. */
const byHand = (bytes: Uint8Array | string) => BigInt('0x' + createHash('sha256').update(bytes).digest('hex')) % R

test('h: SHA-256 read as a big-endian integer, reduced into the field', () => {
  assert.equal(h(vectors.h.model).toString(), vectors.h.value)
  assert.equal(byHand(vectors.h.model).toString(), vectors.h.value)
  assert.equal(h(new TextEncoder().encode(vectors.h.model)), h(vectors.h.model), 'text is its UTF-8 bytes')
})

test('the face key’s facts: Poseidon([h(model), h(embedding)])', () => {
  for (const v of vectors.face) {
    const embedding = b64u.decode(v.embedding)
    assert.equal(embedding.length, 512)
    assert.equal(faceFacts(v.model, embedding).toString(), v.facts)
    assert.equal(poseidon2([byHand(v.model), byHand(embedding)]).toString(), v.facts)
  }
})

test('the ID key’s facts: Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])', () => {
  assert.deepEqual(vectors.id.map((v: { countryNumeric: number }) => v.countryNumeric), [826, 724, 0], 'Kosovo, with no ISO numeric code, enters as 0')
  assert.ok(vectors.id.some((v: { birthDays: number }) => v.birthDays < 0), 'one born before 1970')
  for (const v of vectors.id) {
    const embedding = b64u.decode(v.embedding)
    const read = person(v.document)!
    assert.deepEqual(read, { name: v.name, birth: v.birth, country: v.countryNumeric }, 'the name written one way, the birth date, the country as its numeric code')
    assert.equal(daysOf(v.birth), v.birthDays)
    assert.equal(idFacts(v.model, embedding, read).toString(), v.facts)
    const days = ((BigInt(v.birthDays) % R) + R) % R
    assert.equal(poseidon5([byHand(v.model), byHand(embedding), byHand(v.name), days, BigInt(v.countryNumeric)]).toString(), v.facts)
  }
  // The name by hand: NFKC folds the full-width letters and the combining accent into one way of writing it.
  assert.equal(vectors.id[1].name, 'josé maría núñez')
  assert.equal(vectors.id[1].name, vectors.id[1].name.normalize('NFC'))
})

test('poseidon-lite is the standard’s Poseidon: it makes the stamp number keys/ makes, and pins', async () => {
  const { seed: seedHex, verifier, stampNumber } = vectors.stampNumber
  const seed = hex.decode(seedHex)
  const fromKeys = (await verifierSecret(seed, verifier)).stampNumber
  const byPoseidonLite = poseidon1([poseidon3([PREFIX.verifier, await seedScalar(seed), nameHashOf(verifier)])])
  assert.equal(fromKeys.toString(), stampNumber, "keys/'s own test vector")
  assert.equal(byPoseidonLite, fromKeys)
})
