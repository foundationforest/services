// The facts lists and the vendor_data hash, pinned (test/vectors.json): each value the verifier's code
// gives, and the same value made again by hand, HMAC-SHA256 from node:crypto, each list fact by fact,
// and its facts by the standard's own factsNumber; then a stamp signed with a list, read back by the
// standard's factListOf.
//
//   npm test

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { hkdf, seedNumber, stampNumberOf } from '@foundationforest/keys'
import { FACTS_LISTED, factListOf, factsNumber, signStamp } from '@foundationforest/proofs'
import { b64u, hex } from '@foundationforest/folders'

import { DOCUMENT_FIELDS, stampHash } from '../src/didit.ts'
import { FACE_FACTS, ID_FACTS, faceList, idList, saltsOf } from '../src/facts.ts'
import { INFO } from '../src/seed.ts'

const vectors = JSON.parse(readFileSync(new URL('vectors.json', import.meta.url), 'utf8'))
const secret = hex.decode(vectors.secret)

/** BN254's scalar order, written out here rather than taken from keys/. */
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
/** A salt by hand: HMAC-SHA256 of the session's id, a 0 byte and the name; its first 31 bytes, big-endian. */
const saltByHand = (key: Uint8Array, sessionId: string, name: string) =>
  BigInt('0x' + createHmac('sha256', key).update(Buffer.concat([Buffer.from(sessionId, 'utf8'), Buffer.of(0), Buffer.from(name, 'utf8')])).digest().subarray(0, 31).toString('hex')).toString()
type Fact = { name: string; value: string; salt: string }

test("the vendor_data hash: HMAC-SHA256 of the stamp number's 32 bytes, under the key derived as vendor-data", async () => {
  const v = vectors.vendorData
  // The stamp number is the standard's, keys/'s own test vector.
  assert.equal(stampNumberOf(seedNumber(hex.decode(v.seed)), v.verifier).toString(), v.stampNumber)
  const key = await hkdf(secret, INFO.vendorData)
  assert.equal(INFO.vendorData, 'vendor-data')
  assert.equal(hex.encode(key), v.key)
  const bytes = Buffer.from(BigInt(v.stampNumber).toString(16).padStart(64, '0'), 'hex')
  assert.equal(createHmac('sha256', key).update(bytes).digest('hex'), v.hash, 'by hand')
  assert.equal(stampHash(key, BigInt(v.stampNumber)), v.hash)

  // Every session's vendor_data, face or ID: that hash, 64 hex characters, under Didit's 128.
  assert.match(stampHash(key, BigInt(v.stampNumber)), /^[0-9a-f]{64}$/)
  assert.notEqual(stampHash(key, BigInt(v.stampNumber) + 1n), v.hash, 'another stamp number, another hash')
  assert.notEqual(stampHash(await hkdf(secret, 'another'), BigInt(v.stampNumber)), v.hash, 'another key, another hash')
})

test("the salts: the first 31 bytes of HMAC-SHA256 of the session's id, a 0 byte and the fact's name, under the key derived as fact-salt", async () => {
  const v = vectors.salts
  const key = await hkdf(secret, INFO.salt)
  assert.equal(INFO.salt, 'fact-salt')
  assert.equal(hex.encode(key), v.key)
  const salts = saltsOf(key, v.sessionId)
  for (const [name, salt] of Object.entries(v.salts as Record<string, string>)) {
    assert.equal(saltByHand(key, v.sessionId, name), salt, `${name}, by hand`)
    assert.equal(salts(name), salt, name)
    assert.ok(BigInt(salt) < R, "below BN254's scalar order")
  }
  assert.notEqual(saltsOf(key, 'another session')('model'), v.salts.model, 'another session, other salts')
  assert.notEqual(salts('modelx'), v.salts.model)
})

test("the face key's list: the face model's name and the selfie's embedding as base64url text, and its facts the standard's factsNumber", async () => {
  const v = vectors.face
  const salts = saltsOf(await hkdf(secret, INFO.salt), vectors.salts.sessionId)
  const embedding = b64u.decode(v.embedding)
  assert.equal(embedding.length, 512)
  const byHand = FACE_FACTS.map((name) => ({ name, value: name === 'model' ? v.model : v.embedding, salt: saltByHand(hex.decode(vectors.salts.key), vectors.salts.sessionId, name) }))
  assert.deepEqual(FACE_FACTS, ['model', 'embedding'])
  assert.deepEqual(byHand, v.list)
  assert.deepEqual(faceList(v.model, embedding, salts), v.list)
  assert.equal(factsNumber(v.list).toString(), v.facts)

  // Signed with the list beside it, the standard reads the list back from the stamp.
  const stamp = signStamp(new Uint8Array(32).fill(7), { stampNumber: 5n, facts: BigInt(v.facts), verifierName: 'verifier-a.example', factList: v.list })
  assert.deepEqual(factListOf(stamp), v.list)
})

test("the ID key's list: those two, then every field Didit read on the document, under Didit's names, in the order of the names", async () => {
  const salts = saltsOf(await hkdf(secret, INFO.salt), vectors.salts.sessionId)
  const embedding = b64u.decode(vectors.face.embedding)
  for (const v of vectors.id) {
    const fields = v.fields as Record<string, string>
    const names = ['model', 'embedding', ...Object.keys(fields).sort()]
    assert.deepEqual(v.list.map((f: Fact) => f.name), names, 'model and embedding, then the fields in the order of their names')
    const value = (name: string) => (name === 'model' ? vectors.face.model : name === 'embedding' ? vectors.face.embedding : fields[name])
    assert.deepEqual(v.list, names.map((name) => ({ name, value: value(name), salt: saltByHand(hex.decode(vectors.salts.key), vectors.salts.sessionId, name) })), 'by hand')
    assert.deepEqual(idList(vectors.face.model, embedding, fields, salts), v.list)
    assert.equal(factsNumber(v.list).toString(), v.facts)
  }
  // Text is its UTF-8 bytes: a name in another script, and a key Didit writes with a space.
  assert.ok(vectors.id.some((v: { list: Fact[] }) => v.list.some((f) => f.value === 'Айна Иванова')))
  assert.ok(vectors.id.some((v: { list: Fact[] }) => v.list.some((f) => f.name === 'extra_fields.DL Class')))

  // The names GET / gives: every field Didit reads, and a document's own, in the order the lists take.
  assert.deepEqual(ID_FACTS, ['model', 'embedding', ...[...DOCUMENT_FIELDS, 'extra_fields.<its key>'].sort()])
  assert.equal(ID_FACTS.indexOf('extra_fields.<its key>'), ID_FACTS.indexOf('expiration_date') + 1)
})

test('the fields: their order does not matter, a missing one is simply absent, and no more than the list holds', async () => {
  const salts = saltsOf(await hkdf(secret, INFO.salt), vectors.salts.sessionId)
  const embedding = b64u.decode(vectors.face.embedding)
  const { fields } = vectors.id[0] as { fields: Record<string, string> }
  const shuffled = Object.fromEntries(Object.entries(fields).reverse())
  assert.deepEqual(idList('m', embedding, shuffled, salts), idList('m', embedding, fields, salts))
  const { document_number: _, ...rest } = fields
  assert.equal(idList('m', embedding, rest, salts).some((f) => f.name === 'document_number'), false)
  assert.notEqual(factsNumber(idList('m', embedding, rest, salts)), factsNumber(idList('m', embedding, fields, salts)))
  assert.notEqual(factsNumber(idList('m', embedding, { ...fields, document_number: 'AB1234568' }, salts)), factsNumber(idList('m', embedding, fields, salts)), 'one character of one field changes it')

  const full = Object.fromEntries(Array.from({ length: FACTS_LISTED - 2 }, (_, i) => [`extra_fields.f${String(i).padStart(3, '0')}`, String(i)]))
  assert.equal(idList('m', embedding, full, salts).length, FACTS_LISTED, 'every leaf full')
  assert.ok(factsNumber(idList('m', embedding, full, salts)))
  assert.throws(() => factsNumber(idList('m', embedding, { ...full, first_name: 'Ada' }, salts)), RangeError, 'one more than the list holds')
})
