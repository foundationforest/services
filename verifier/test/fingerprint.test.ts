// The person codes (src/fingerprint.ts): who a document is for, cleaned, and the two keyed codes made
// of it.
//
//   npm test

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { clean, codesOf, personOf } from '../src/fingerprint.ts'
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

test('who a document is for: the names from its machine-readable zone when it has one, else what Didit read; the birth date and country always from what Didit read', () => {
  const read = doc('García López', { first_name: 'María José', date_of_birth: '1990-05-12', issuing_state: 'esp' })
  assert.deepEqual(personOf(passedId('maria', read), NOW), { given: 'MARIA JOSE', family: 'GARCIA LOPEZ', birth: '1990-05-12', country: 'ESP' })
  // Its zone writes the names its own way: those, and never its own two-digit year or country code.
  const zoned = passedId('maria', { ...read, issuing_state: 'DEU' }, { mrz: { given: 'MARIA<JOSE', family: 'GARCIA LOPEZ' } })
  assert.deepEqual(personOf(zoned, NOW), { given: 'MARIA JOSE', family: 'GARCIA LOPEZ', birth: '1990-05-12', country: 'DEU' })
  // A document that reads only a full name.
  const { first_name: _, last_name: __, ...fullOnly } = doc('Okafor', { full_name: 'Chidi Okafor' })
  assert.deepEqual(personOf(passedId('chidi', fullOnly), NOW), { given: 'CHIDI OKAFOR', family: '', birth: '1990-04-01', country: 'GBR' })
  // One name alone is a person.
  assert.deepEqual(personOf(passedId('sukarno', doc('', { first_name: 'Sukarno', full_name: 'Sukarno' })), NOW)?.given, 'SUKARNO')

  // Without a birth date (a real one, in a life), a country or any name: no person, and no codes.
  const { date_of_birth: ___, ...ageless } = doc('Lovelace')
  for (const without of [ageless, doc('Lovelace', { date_of_birth: '1990-02-30' }), doc('Lovelace', { date_of_birth: '1850-01-01' }), doc('Lovelace', { issuing_state: '' }), doc('Lovelace', { issuing_state: 'GB' }), doc('', { first_name: '', full_name: '' })]) {
    assert.equal(personOf(passedId('ada', without), NOW), null, JSON.stringify(without))
  }
  assert.equal(personOf(passedId('ada', doc('Lovelace'), { document: null }), NOW), null)
})

test('two codes, full and short, keyed: the same person on two documents written differently gives the same full code; a full code is never a short one', () => {
  const codes = (read: Record<string, string>, mrz?: { given: string; family: string }) => {
    const person = personOf(passedId('maria', read, mrz ? { mrz } : {}), NOW)
    assert.ok(person, JSON.stringify(read))
    const { full, short } = codesOf(key, person)
    return { full: hex(full), short: hex(short) }
  }
  const base = codes(doc('García López', { first_name: 'María José' }))
  assert.equal(base.full.length, 64)
  assert.notEqual(base.full, base.short)
  // Accents, case and spaces aside, and a name split otherwise between given and family: the same full code.
  assert.deepEqual(codes(doc('  GARCIA  lopez', { first_name: 'MARIA jose' })), base)
  assert.equal(codes(doc('José García López', { first_name: 'María' })).full, base.full)
  // A passport's zone, the same names: the same codes.
  assert.deepEqual(codes(doc('Other', { first_name: 'Other' }), { given: 'MARIA JOSE', family: 'GARCIA LOPEZ' }), base)
  // The short code is the first given name and the first family name: the same for a second name left out.
  const short = codes(doc('García', { first_name: 'María' }))
  assert.notEqual(short.full, base.full)
  assert.equal(short.short, base.short)
  // A single name of each: its short code is still not its full code.
  assert.notEqual(short.full, short.short)
  // Another birth date, another country, or another key: other codes.
  for (const other of [codes(doc('García López', { first_name: 'María José', date_of_birth: '1990-05-13' })), codes(doc('García López', { first_name: 'María José', issuing_state: 'MEX' }))]) {
    assert.notEqual(other.full, base.full)
    assert.notEqual(other.short, base.short)
  }
  const person = personOf(passedId('maria', doc('García López', { first_name: 'María José' })), NOW)!
  assert.notEqual(hex(codesOf(new Uint8Array(randomBytes(32)), person).full), base.full, 'without the key, no guess can be tested')
  // Fields never run into each other: a name that ends where a date begins is another code.
  assert.notEqual(hex(codesOf(key, { given: 'A', family: '', birth: '1990-01-01', country: 'GBR' }).full), hex(codesOf(key, { given: 'A 1990', family: '', birth: '01-01', country: 'GBR' }).full))
})
