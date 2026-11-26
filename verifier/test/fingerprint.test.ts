// The scrambled copies (src/fingerprint.ts): who a document is for, cleaned, the lifelong number it
// shows, and the slow, keyed values made of them.
//
//   npm test

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { test } from 'node:test'

import { LIFELONG, SCRYPT, clean, copiesOf, lifelongOf, personOf, scrambled } from '../src/fingerprint.ts'
import { doc, passedId } from './fakes.ts'

const NOW = Date.UTC(2026, 10, 25)
const key = new Uint8Array(randomBytes(32))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
/** The CURP shape: four letters, six digits, the sex, the state, three consonants, a century character, a check digit. */
const CURP = 'RUPA900512MDFZXN09'
/** A Mexican INE as Didit reads it: two family names in last_name, its first in extra_fields, the CURP as its personal number, and its own, other, document number. */
const ine = (over: Record<string, string> = {}) =>
  doc('Ruiz Peña', { first_name: 'Ana Sofía', date_of_birth: '1990-05-12', issuing_state: 'MEX', personal_number: CURP, document_number: 'IDMEX1234567', document_type: 'Identity Card', 'extra_fields.first_surname': 'Ruiz', ...over })

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

test('who a document is for: the first given and first family name from its machine-readable zone when it has one, else from what Didit read; the birth date from what Didit read', () => {
  assert.deepEqual(personOf(passedId('ana', ine()), NOW), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-05-12', lifelong: { number: CURP, country: 'MEX' } })
  // Its zone writes the names its own way: those.
  assert.deepEqual(personOf(passedId('ana', ine(), { mrz: { given: 'ANA<SOFIA', family: 'RUIZ<PENA' } }), NOW), { firstName: 'ANA', lastName: 'RUIZ', birth: '1990-05-12', lifelong: { number: CURP, country: 'MEX' } })
  // A document that reads only a full name: its first word.
  const { first_name: _, last_name: __, ...fullOnly } = doc('Okafor', { full_name: 'Chidi Okafor' })
  assert.deepEqual(personOf(passedId('chidi', fullOnly), NOW), { firstName: 'CHIDI', lastName: '', birth: '1990-04-01', lifelong: null })
  // One name alone is a person, and no country is needed.
  const { issuing_state: ___, ...countryless } = doc('', { first_name: 'Sukarno', full_name: 'Sukarno' })
  assert.deepEqual(personOf(passedId('sukarno', countryless), NOW), { firstName: 'SUKARNO', lastName: '', birth: '1990-04-01', lifelong: null })

  // Without a birth date (a real one, in a life) or any name: no person, and no copies.
  const { date_of_birth: ____, ...ageless } = doc('Lovelace')
  for (const without of [ageless, doc('Lovelace', { date_of_birth: '1990-02-30' }), doc('Lovelace', { date_of_birth: '1850-01-01' }), doc('', { first_name: ' - ', full_name: '' })]) {
    assert.equal(personOf(passedId('ada', without), NOW), null, JSON.stringify(without))
  }
  assert.equal(personOf(passedId('ada', doc('Lovelace'), { document: null }), NOW), null)
})

test('the lifelong number: Didit’s personal number, never the document number, only for a country on the list and only in its shape; the list starts with Mexico alone', () => {
  assert.deepEqual(Object.keys(LIFELONG), ['MEX'], 'a country is added only after the legal chat has checked its rules')
  assert.deepEqual(lifelongOf(ine()), { number: CURP, country: 'MEX' })
  // As Didit's reads come: lower case, spaces, a dash.
  assert.deepEqual(lifelongOf(ine({ personal_number: ` ${CURP.toLowerCase()} ` })), { number: CURP, country: 'MEX' })
  assert.deepEqual(lifelongOf(ine({ personal_number: `${CURP.slice(0, 10)}-${CURP.slice(10)}`, issuing_state: 'mex' })), { number: CURP, country: 'MEX' })
  // The document number is never it, whatever its shape: a document's number changes with each renewal.
  const { personal_number: _, ...without } = ine({ document_number: CURP })
  assert.equal(lifelongOf(without), null)
  // Another shape is no number: an INE's elector key, a number cut short, a misread, empty.
  for (const personal_number of ['RZGRCR90051209H400', CURP.slice(0, 17), CURP + '1', 'RUPA9005I2MDFZXN09', 'RUPA900512ZDFZXN09', '', 'SAMPLE-PER-12345']) {
    assert.equal(lifelongOf(ine({ personal_number })), null, personal_number)
  }
  // Another country's number, whatever its shape: not on the list.
  for (const issuing_state of ['ESP', 'GBR', '', 'constructor', '__proto__']) assert.equal(lifelongOf(ine({ issuing_state })), null, issuing_state)
})

test('the copies: scrypt at its cost with the key as its salt, the name copy the same for the same three details from any ID of any country; the number copy the same for the same number; each with its own label, so the two never match', async () => {
  assert.deepEqual(SCRYPT, { N: 65536, r: 8, p: 1, maxmem: 134217728, bytes: 32 }, 'slow on purpose: 64 MB, about a fifth of a second')
  const copies = async (read: Record<string, string>, over = {}) => {
    const { name, number } = await copiesOf(key, personOf(passedId('ana', read, over), NOW)!)
    return { name: hex(name), number: number && hex(number) }
  }
  const mexican = await copies(ine())
  assert.equal(mexican.name.length, 64)
  assert.equal(mexican.number?.length, 64)
  // Her passport from Spain, her names written otherwise: the same name copy, and no number copy.
  const passport = await copies(doc('RUIZ', { first_name: 'ANA', issuing_state: 'ESP', document_type: 'Passport', date_of_birth: '1990-05-12' }))
  assert.equal(passport.name, mexican.name)
  assert.equal(passport.number, undefined)
  assert.equal((await copies(doc('Other', { first_name: 'Other', date_of_birth: '1990-05-12' }), { mrz: { given: 'ANA', family: 'RUIZ GARCIA' } })).name, mexican.name)
  // Her new INE: another document, another name written, the same number: the same number copy.
  const renewed = await copies(ine({ first_name: 'Ana', last_name: 'Ruiz', document_number: 'IDMEX7654321', 'extra_fields.first_surname': 'Ruiz' }))
  assert.equal(renewed.number, mexican.number)
  // Another first name, first last name or birth date: another name copy. Another number: another number copy.
  for (const other of [ine({ first_name: 'Ania' }), ine({ last_name: 'Ruis' }), ine({ date_of_birth: '1990-05-13' })]) assert.notEqual((await copies(other)).name, mexican.name, JSON.stringify(other))
  assert.notEqual((await copies(ine({ personal_number: 'RUPA900512MDFZXN18' }))).number, mexican.number)
  // Another key, other values: without it no guess can be tested.
  const person = personOf(passedId('ana', ine()), NOW)!
  const other = await copiesOf(new Uint8Array(randomBytes(32)), person)
  assert.notEqual(hex(other.name), mexican.name)
  assert.notEqual(hex(other.number!), mexican.number)

  // Each its own label: the same bytes scrambled under the two labels are two values, so a name copy and a number copy never match.
  const [asName, asNumber] = await Promise.all([scrambled(key, 'name', ['A', 'B']), scrambled(key, 'number', ['A', 'B'])])
  assert.notEqual(hex(asName), hex(asNumber))
  // No detail runs into the next.
  const [a, b] = await Promise.all([scrambled(key, 'name', ['AN', 'ARUIZ', '1990-04-01']), scrambled(key, 'name', ['ANA', 'RUIZ', '1990-04-01'])])
  assert.notEqual(hex(a), hex(b))
  // Each is what scrypt gives for its label and details, joined by 0 bytes, with the key as its salt.
  const cost = { N: 65536, r: 8, p: 1, maxmem: 134217728 }
  assert.equal(hex(b), scryptSync('name\0ANA\0RUIZ\x001990-04-01', key, 32, cost).toString('hex'))
  assert.equal(mexican.number, scryptSync(`number\0${CURP}\0MEX`, key, 32, cost).toString('hex'))
})
