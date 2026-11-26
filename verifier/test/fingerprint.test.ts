// The scrambled copy (src/fingerprint.ts): who a document is for, cleaned, and the one slow, keyed
// value made of it.
//
//   npm test

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { test } from 'node:test'

import { SCRYPT, clean, copyOf, personOf, scrambled } from '../src/fingerprint.ts'
import { doc, passedId } from './fakes.ts'

const NOW = Date.UTC(2026, 10, 25)
const key = new Uint8Array(randomBytes(32))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

test('a name cleaned: capitals, no accents, no apostrophe, anything else not a letter a space, single spaces', () => {
  assert.equal(clean('  José  María '), 'JOSE MARIA')
  assert.equal(clean("O'Neil-Smith"), 'ONEIL SMITH')
  assert.equal(clean('D’Arcy'), 'DARCY')
  assert.equal(clean('MÜLLER<<HANS'), 'MULLER HANS')
  assert.equal(clean('Straße'), 'STRASSE', 'ß in capitals, as a machine-readable zone writes it')
  assert.equal(clean('Ana2 Bo.'), 'ANA BO')
  assert.equal(clean('Søren'), 'SØREN', 'a letter with no accent to drop stays')
  assert.equal(clean(' - '), '')
})

test('who a document is for: the first given and first family name from its machine-readable zone when it has one, else from what Didit read; the birth date from what Didit read; nothing else of the ID', () => {
  // As Didit reads an ID with two family names in last_name, its first also in extra_fields, and a personal number and a document number the copy never takes.
  const ine = doc('Ruiz Peña', { first_name: 'Ana Sofía', date_of_birth: '1990-05-12', issuing_state: 'MEX', personal_number: 'RUPA900512MDFZXN09', document_number: 'IDMEX1234567', 'extra_fields.first_surname': 'Ruiz' })
  assert.deepEqual(personOf(passedId('ana', ine), NOW), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-05-12' })
  // Its zone writes the names its own way: those.
  assert.deepEqual(personOf(passedId('ana', ine, { mrz: { given: 'ANA<SOFIA', family: 'RUIZ<PENA' } }), NOW), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-05-12' })
  // A document that reads only a full name: its first word.
  const { first_name: _, last_name: __, ...fullOnly } = doc('Okafor', { full_name: 'Chidi Okafor' })
  assert.deepEqual(personOf(passedId('chidi', fullOnly), NOW), { firstName: 'CHIDI', lastName: '', birth: '1990-04-01' })
  // One name alone is a person, and no country is needed.
  const { issuing_state: ___, ...countryless } = doc('', { first_name: 'Sukarno', full_name: 'Sukarno' })
  assert.deepEqual(personOf(passedId('sukarno', countryless), NOW), { firstName: 'SUKARNO', lastName: '', birth: '1990-04-01' })

  // Without a birth date (a real one, in a life) or any name: no person, and no copy.
  const { date_of_birth: ____, ...ageless } = doc('Lovelace')
  for (const without of [ageless, doc('Lovelace', { date_of_birth: '1990-02-30' }), doc('Lovelace', { date_of_birth: '1850-01-01' }), doc('', { first_name: ' - ', full_name: '' })]) {
    assert.equal(personOf(passedId('ada', without), NOW), null, JSON.stringify(without))
  }
  assert.equal(personOf(passedId('ada', doc('Lovelace'), { document: null }), NOW), null)
})

test('the copy: scrypt at its cost with the key as its salt, the same for the same three details from any ID of any country, another for any other; its label is inside the scramble', async () => {
  assert.deepEqual(SCRYPT, { N: 65536, r: 8, p: 1, maxmem: 134217728, bytes: 32 }, 'slow on purpose: 64 MB, about a fifth of a second')
  const copy = async (read: Record<string, string>, over = {}) => hex(await copyOf(key, personOf(passedId('ana', read, over), NOW)!))
  const first = await copy(doc('Ruiz Peña', { first_name: 'Ana Sofía', date_of_birth: '1990-05-12', issuing_state: 'MEX', personal_number: 'RUPA900512MDFZXN09' }))
  assert.equal(first.length, 64)
  // Her passport from Spain, her names written otherwise, with no personal number: the same copy.
  assert.equal(await copy(doc('RUIZ', { first_name: 'ANA', issuing_state: 'ESP', document_type: 'Passport', date_of_birth: '1990-05-12' })), first)
  assert.equal(await copy(doc('Other', { first_name: 'Other', date_of_birth: '1990-05-12' }), { mrz: { given: 'ANA', family: 'RUIZ GARCIA' } }), first)
  // Another personal number or document number changes nothing: the copy is of the name and the birth date alone.
  assert.equal(await copy(doc('Ruiz', { first_name: 'Ana', date_of_birth: '1990-05-12', personal_number: 'OTHER', document_number: 'CD7654321' })), first)
  // Another first name, first last name or birth date: another copy.
  for (const other of [doc('Ruiz', { first_name: 'Ania', date_of_birth: '1990-05-12' }), doc('Ruis', { first_name: 'Ana', date_of_birth: '1990-05-12' }), doc('Ruiz', { first_name: 'Ana', date_of_birth: '1990-05-13' })]) {
    assert.notEqual(await copy(other), first, JSON.stringify(other))
  }
  // No detail runs into the next.
  const [a, b] = await Promise.all([scrambled(key, 'name', ['AN', 'ARUIZ', '1990-04-01']), scrambled(key, 'name', ['ANA', 'RUIZ', '1990-04-01'])])
  assert.notEqual(hex(a), hex(b))
  // Another key, another copy: without it no guess can be tested.
  assert.notEqual(hex(await copyOf(new Uint8Array(randomBytes(32)), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-04-01' })), hex(b))
  // It is what scrypt gives for the kind's label and the details, joined by 0 bytes, with the key as its salt.
  const cost = { N: 65536, r: 8, p: 1, maxmem: 134217728 }
  assert.equal(hex(b), scryptSync('name\0ANA\0RUIZ\x001990-04-01', key, 32, cost).toString('hex'))
  assert.equal(hex(await copyOf(key, { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-04-01' })), hex(b))
})
