// The facts lists and the vendor_data hash, pinned (test/vectors.json): each value the verifier's code
// gives, and the same value made again by hand, HMAC-SHA256 from node:crypto, each list fact by fact,
// and its facts by the standard's own factsNumber; then a stamp signed with a list, read back by the
// standard's factListOf. And who an ID check read, and whether it is the same person as a Didit user.
//
//   npm test

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { hkdf, seedNumber, stampNumberOf } from '@foundationforest/keys'
import { FACTS_LISTED, factListOf, factsNumber, signStamp } from '@foundationforest/proofs'
import { b64u, hex } from '@foundationforest/folders'

import { DOCUMENT_FIELDS, readVendorData, stampHash, vendorDataFor } from '../src/didit.ts'
import { FACE_FACTS, ID_FACTS, faceList, idList, person, saltsOf, samePerson, words } from '../src/facts.ts'
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

  // A session's vendor_data: its check, that hash, and a random id, fresh each time; read back.
  const face = vendorDataFor('face', key, BigInt(v.stampNumber))
  const id = vendorDataFor('id', key, BigInt(v.stampNumber))
  assert.match(face, new RegExp(`^face-${v.hash}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`))
  assert.match(id, new RegExp(`^id-${v.hash}-`))
  assert.notEqual(face, vendorDataFor('face', key, BigInt(v.stampNumber)), 'each session its own')
  assert.ok(face.length < 128, "under Didit's 128")
  assert.deepEqual(readVendorData(face), { check: 'face', hash: v.hash })
  assert.deepEqual(readVendorData(id), { check: 'id', hash: v.hash })
  assert.notEqual(stampHash(key, BigInt(v.stampNumber) + 1n), v.hash, 'another stamp number, another hash')
  assert.notEqual(stampHash(await hkdf(secret, 'another'), BigInt(v.stampNumber)), v.hash, 'another key, another hash')
  for (const other of ['face-c0ffee00-0000-4000-8000-000000000000', `face-${v.hash}`, `selfie-${v.hash}-c0ffee00-0000-4000-8000-000000000000`, `face-${v.hash.toUpperCase()}-c0ffee00-0000-4000-8000-000000000000`, '']) {
    assert.equal(readVendorData(other), null, other)
  }
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
