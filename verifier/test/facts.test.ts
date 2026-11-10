// The facts recipes, pinned (test/vectors.json): each value the verifier's code gives, and the same
// value made again by hand, SHA-256 from node:crypto and Poseidon from poseidon-lite directly, the
// fields tree with every one of its leaves. And poseidon-lite shown to be the standard's Poseidon: it
// gives the stamp number keys/ gives, the one keys/ pins in its own test vectors.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { nameHashOf, seedNumber, stampNumberOf } from '@foundationforest/keys'
import { b64u, hex } from '@foundationforest/folders'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import { poseidon3 } from 'poseidon-lite/poseidon3'

import { FIELDS_DEPTH, faceFacts, fieldsRoot, fieldsText, h, idFacts, person } from '../src/facts.ts'

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

/** The fields tree by hand: all 2^8 leaves, one per field in the order of their names and the rest 0, hashed in pairs up to the root. */
function rootByHand(fields: Record<string, string>): bigint {
  const names = Object.keys(fields).sort()
  let level = Array.from({ length: 2 ** 8 }, (_, i) => (i < names.length ? poseidon2([byHand(names[i]!), byHand(fields[names[i]!]!)]) : 0n))
  while (level.length > 1) level = Array.from({ length: level.length / 2 }, (_, i) => poseidon2([level[2 * i]!, level[2 * i + 1]!]))
  return level[0]!
}

test('the ID key’s facts: Poseidon([h(model), h(embedding), fieldsRoot]), over the fields as their text lists them', () => {
  assert.equal(FIELDS_DEPTH, 8)
  for (const v of vectors.id) {
    const embedding = b64u.decode(v.embedding)
    assert.equal(fieldsText(v.fields), v.text)
    assert.deepEqual(JSON.parse(v.text), v.fields, 'the text is the fields')
    assert.deepEqual(Object.keys(JSON.parse(v.text)), Object.keys(v.fields).sort(), 'listed in the order of their names')
    assert.equal(fieldsRoot(v.fields).toString(), v.fieldsRoot)
    assert.equal(rootByHand(v.fields).toString(), v.fieldsRoot)
    assert.equal(idFacts(v.model, embedding, v.fields).toString(), v.facts)
    assert.equal(poseidon3([byHand(v.model), byHand(embedding), BigInt(v.fieldsRoot)]).toString(), v.facts)
  }
  // Text is its UTF-8 bytes: a name in another script, and a key Didit writes with a space.
  assert.ok(vectors.id.some((v: { text: string }) => v.text.includes('Айна') && !v.text.includes('\\u')))
  assert.ok(vectors.id.some((v: { fields: object }) => 'extra_fields.DL Class' in v.fields))
})

test('the fields: their order does not matter, a missing one is simply absent, and no more than the tree holds', () => {
  const { fields } = vectors.id[0] as { fields: Record<string, string> }
  const shuffled = Object.fromEntries(Object.entries(fields).reverse())
  assert.equal(fieldsText(shuffled), fieldsText(fields))
  assert.equal(fieldsRoot(shuffled), fieldsRoot(fields))

  // Without its document number: not in the text, and the root is the tree of the rest.
  const { document_number: _, ...rest } = fields
  assert.equal(fieldsText(rest).includes('document_number'), false)
  assert.equal(fieldsRoot(rest), rootByHand(rest))
  assert.notEqual(fieldsRoot(rest), fieldsRoot(fields))
  assert.notEqual(fieldsRoot({ ...fields, document_number: 'AB1234568' }), fieldsRoot(fields), 'one character of one field changes it')

  const full = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`extra_fields.f${i}`, String(i)]))
  assert.equal(fieldsRoot(full), rootByHand(full), 'every leaf full')
  assert.throws(() => fieldsRoot({ ...full, first_name: 'Ada' }), RangeError, 'one more than 2^8')
})

test('the person, for the fingerprint: the name read first and last, else in full, written one way, and a real birth date', () => {
  // NFKC folds the full-width letters and the combining accent into one way of writing it.
  assert.deepEqual(person({ first_name: '\uff2a\uff4f\uff53e\u0301', last_name: 'MAR\u00cdA  N\u00fa\u00f1ez', date_of_birth: '1990-04-01' }), { name: 'josé maría núñez', birth: '1990-04-01' })
  assert.deepEqual(person({ first_name: ' Ada ', full_name: 'Augusta Ada King', date_of_birth: '1815-12-10' }), { name: 'augusta ada king', birth: '1815-12-10' }, 'no last name: the full name')
  assert.deepEqual(person({ full_name: 'Besa  Krasniqi', date_of_birth: '1970-01-01', issuing_state: 'XKX' }), { name: 'besa krasniqi', birth: '1970-01-01' })
  for (const birth of ['1990-02-30', '01/04/1990', '0099-01-01']) assert.equal(person({ full_name: 'Ada Lovelace', date_of_birth: birth }), null, birth)
  assert.equal(person({ date_of_birth: '1990-04-01' }), null, 'no name')
  assert.equal(person(null), null)
})

test('poseidon-lite is the standard’s Poseidon: it makes the stamp number keys/ makes, and pins', () => {
  const { seed: seedHex, verifier, stampNumber } = vectors.stampNumber
  const seed = hex.decode(seedHex)
  const fromKeys = stampNumberOf(seedNumber(seed), verifier)
  const byPoseidonLite = poseidon2([seedNumber(seed), nameHashOf(verifier)])
  assert.equal(fromKeys.toString(), stampNumber, "keys/'s own test vector")
  assert.equal(byPoseidonLite, fromKeys)
})
