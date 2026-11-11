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

import { FIELDS_DEPTH, faceFacts, fieldsRoot, fieldsText, h, idFacts, person, samePerson, words } from '../src/facts.ts'

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

test('who an ID check read: the words of its first and full name, NFKD, marks removed, lower case, letters only, and a real birth date', () => {
  // NFKD folds the full-width letters and splits the accents off, which go.
  assert.deepEqual(words('\uff2a\uff4f\uff53e\u0301 MAR\u00cdA'), ['jose', 'maria'])
  assert.deepEqual(words("  O'Brien-Núñez\tÅsa 3rd "), ['o', 'brien', 'nunez', 'asa', 'rd'], 'anything but a letter parts words')
  assert.deepEqual(words(null), [])
  assert.deepEqual(person({ first_name: 'María José', last_name: 'López', full_name: 'María José López', date_of_birth: '1990-04-01' }), { first: ['maria', 'jose'], full: ['maria', 'jose', 'lopez'], birth: '1990-04-01' })
  assert.deepEqual(person({ full_name: 'Besa  Krasniqi', date_of_birth: ' 1970-01-01 ', issuing_state: 'XKX' }), { first: [], full: ['besa', 'krasniqi'], birth: '1970-01-01' }, 'a full name alone will do')
  for (const birth of ['1990-02-30', '01/04/1990', '0099-01-01']) assert.equal(person({ full_name: 'Ada Lovelace', date_of_birth: birth }), null, birth)
  assert.equal(person({ last_name: 'Lovelace', date_of_birth: '1990-04-01' }), null, 'no first or full name')
  assert.equal(person({ first_name: '—', date_of_birth: '1990-04-01' }), null, 'no letter in it')
  assert.equal(person(null), null)
})

test('the same person: the same birth date, and every word of the first name in their full name, or every word of their full name in this one', () => {
  const read = (first: string, full: string, birth = '1990-01-01') => person({ first_name: first, full_name: full, date_of_birth: birth })!
  const user = (fullName: string | null, birth: string | null = '1990-01-01') => ({ fullName, birth })
  assert.equal(samePerson(read('Carlos', 'Carlos Islas Garza'), user('Carlos Islas')), true)
  assert.equal(samePerson(read('Carlos', 'Carlos Islas'), user('Carlos Islas Garza')), true)
  assert.equal(samePerson(read('Carlos', 'Carlos Islas'), user('carlos islas', ' 1990-01-01 ')), true)
  assert.equal(samePerson(read('Eva', 'Eva Islas'), user('Ana Islas')), false, 'twins')
  assert.equal(samePerson(read('María Fernanda', 'María Fernanda López'), user('María José López')), false)
  assert.equal(samePerson(read('Carlos', 'Carlos Islas', '1991-01-01'), user('Carlos Islas')), false, 'another birth date')
  assert.equal(samePerson(read('Carlos', 'Carlos Islas'), user('Carlos Islas', null)), false, 'no birth date')
  assert.equal(samePerson(read('Lena', 'Lena Ortiz'), user(null)), true, 'no name: the birth date alone')
  assert.equal(samePerson(read('Lena', 'Lena Ortiz'), user(' — ')), true, 'a name with no letter is none')
  assert.equal(samePerson(person({ full_name: 'Besa Krasniqi', date_of_birth: '1990-01-01' })!, user('Besa Krasniqi Berisha')), false, 'no first name read: only the other way')
  assert.equal(samePerson(person({ full_name: 'Besa Krasniqi Berisha', date_of_birth: '1990-01-01' })!, user('Besa Krasniqi')), true)
})

test('poseidon-lite is the standard’s Poseidon: it makes the stamp number keys/ makes, and pins', () => {
  const { seed: seedHex, verifier, stampNumber } = vectors.stampNumber
  const seed = hex.decode(seedHex)
  const fromKeys = stampNumberOf(seedNumber(seed), verifier)
  const byPoseidonLite = poseidon2([seedNumber(seed), nameHashOf(verifier)])
  assert.equal(fromKeys.toString(), stampNumber, "keys/'s own test vector")
  assert.equal(byPoseidonLite, fromKeys)
})
