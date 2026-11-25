// The scrambled copy (src/fingerprint.ts): who a document is for, cleaned, and its row, each detail
// scrambled on its own.
//
//   npm test

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { COLUMNS, clean, cleanNumber, fingerprintOf, personOf } from '../src/fingerprint.ts'
import { doc, passedId } from './fakes.ts'

const NOW = Date.UTC(2026, 10, 25)
const key = new Uint8Array(randomBytes(32))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

test('a name cleaned: capitals, no accents, no apostrophe, anything else not a letter a space, single spaces; a personal number, its letters and digits', () => {
  assert.equal(clean('  José  María '), 'JOSE MARIA')
  assert.equal(clean("O'Neil-Smith"), 'ONEIL SMITH')
  assert.equal(clean('D’Arcy'), 'DARCY')
  assert.equal(clean('MÜLLER<<HANS'), 'MULLER HANS')
  assert.equal(clean('Straße'), 'STRASSE', 'ß in capitals, as a machine-readable zone writes it')
  assert.equal(clean('Ana2 Bo.'), 'ANA BO')
  assert.equal(clean('Søren'), 'SØREN', 'a letter with no accent to drop stays')
  assert.equal(clean(' - '), '')
  assert.equal(cleanNumber(' rupa-900512 mdf.zxn09 '), 'RUPA900512MDFZXN09')
})

test('who a document is for: the first given and first family name from its machine-readable zone when it has one, else from what Didit read; the birth date, personal number, type and country from what Didit read', () => {
  // As Didit reads a Mexican INE: two family names in last_name, its first in extra_fields, and the CURP as its personal number.
  const ine = doc('Ruiz Peña', { first_name: 'Ana Sofía', date_of_birth: '1990-05-12', issuing_state: 'mex', personal_number: 'RUPA900512MDFZXN09', document_type: 'Identity Card', 'extra_fields.first_surname': 'Ruiz' })
  assert.deepEqual(personOf(passedId('ana', ine), NOW), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-05-12', personalNumber: 'RUPA900512MDFZXN09', idType: 'IDENTITY CARD', country: 'MEX' })
  // Its zone writes the names its own way: those, and never its own two-digit year or country code.
  const zoned = passedId('ana', { ...ine, issuing_state: 'DEU' }, { mrz: { given: 'ANA<SOFIA', family: 'RUIZ<PENA' } })
  assert.deepEqual(personOf(zoned, NOW), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-05-12', personalNumber: 'RUPA900512MDFZXN09', idType: 'IDENTITY CARD', country: 'DEU' })
  // A document that reads only a full name: its first word.
  const { first_name: _, last_name: __, ...fullOnly } = doc('Okafor', { full_name: 'Chidi Okafor' })
  assert.deepEqual(personOf(passedId('chidi', fullOnly), NOW), { firstName: 'CHIDI', lastName: '', birth: '1990-04-01', personalNumber: '', idType: 'PASSPORT', country: 'GBR' })
  // One name alone is a person; a detail the ID lacks, or a country that is none, is empty.
  assert.deepEqual(personOf(passedId('sukarno', doc('', { first_name: 'Sukarno', full_name: 'Sukarno', issuing_state: 'GB', document_type: '' })), NOW), { firstName: 'SUKARNO', lastName: '', birth: '1990-04-01', personalNumber: '', idType: '', country: '' })

  // Without a birth date (a real one, in a life) or any name: no person, and no row.
  const { date_of_birth: ___, ...ageless } = doc('Lovelace')
  for (const without of [ageless, doc('Lovelace', { date_of_birth: '1990-02-30' }), doc('Lovelace', { date_of_birth: '1850-01-01' }), doc('', { first_name: ' - ', full_name: '' })]) {
    assert.equal(personOf(passedId('ada', without), NOW), null, JSON.stringify(without))
  }
  assert.equal(personOf(passedId('ada', doc('Lovelace'), { document: null }), NOW), null)
})

test('the row: each detail scrambled on its own, keyed, the same detail always the same bytes, one column’s never another’s, a detail the ID lacks empty', () => {
  const row = (read: Record<string, string>) => {
    const person = personOf(passedId('ana', read), NOW)
    assert.ok(person, JSON.stringify(read))
    return Object.fromEntries(Object.entries(fingerprintOf(key, person)).map(([column, bytes]) => [column, hex(bytes)]))
  }
  const ine = row(doc('Ruiz Peña', { first_name: 'Ana Sofía', personal_number: 'RUPA900512MDFZXN09', document_type: 'Identity Card', issuing_state: 'MEX' }))
  assert.deepEqual(Object.keys(ine), [...COLUMNS])
  for (const column of COLUMNS) assert.equal(ine[column]!.length, 64, column)
  // The same person's passport, from Spain, its name written otherwise: the same first name, first last name and birth date.
  const passport = row(doc('RUIZ', { first_name: 'ANA', document_type: 'Passport', issuing_state: 'ESP' }))
  for (const column of ['first_name', 'last_name', 'birth'] as const) assert.equal(passport[column], ine[column], column)
  assert.notEqual(passport.country, ine.country)
  assert.notEqual(passport.id_type, ine.id_type)
  assert.equal(passport.personal_number, '', 'none on it: empty')
  // Each column its own: a first name is never the same bytes as the same word as a last name.
  assert.notEqual(row(doc('Ana', { first_name: 'Ana' })).first_name, row(doc('Ana', { first_name: 'Ana' })).last_name)
  // Another key: other bytes, so without it no guess can be tested.
  const person = personOf(passedId('ana', doc('Ruiz', { first_name: 'Ana' })), NOW)!
  assert.notEqual(hex(fingerprintOf(new Uint8Array(randomBytes(32)), person).first_name), hex(fingerprintOf(key, person).first_name))
})
