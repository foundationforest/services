// The scrambled copy of who an ID stamp is for, so the ID check counts each person once across stamp
// numbers (server.ts's `signId`). The table and its key keep the old name, `fingerprint`.
//
// One row an ID stamp, each detail scrambled on its own:
//
//   first_name        the first given name
//   last_name         the first family name
//   birth             the birth date, YYYY-MM-DD
//   personal_number   the ID's personal number, when it has one (Mexico's CURP)
//   id_type           the ID's type, as Didit names it (`Passport`, `Identity Card`)
//   country           the ID's country
//
// A row matches another when its first name, first last name and birth date all do (store.ts). The
// country is not part of it, so the same person's ID from a second country is found too; the others
// are kept for rules to come.
//
// Each detail is HMAC-SHA256, under the key the verifier's secret derives under `fingerprint`
// (seed.ts), of its column's name, a 0 byte and the detail: keyed and one-way, the same detail always
// the same bytes, and one column's never another's. A detail the ID lacks is kept empty. Without the
// secret no guess can be tested against one. Whoever holds it can try every value of a detail, one
// detail at a time: every birth date, every country and type, a list of names.
//
// The names are cleaned: capitals, no accents, an apostrophe dropped and anything else that is not a
// letter a space, single spaces; then each is its first word. They come from the document's
// machine-readable zone when it has one, as passports and most ID cards do: written there without
// accents and in Latin letters by its own rules, they are the same on every such document of one
// person. Otherwise from what Didit read on its face. The first word, not Didit's
// `extra_fields.first_surname`, which only some IDs give: a first surname of three words is one word
// on one ID and three on another, and only its first word is the same on both. The
// birth date and the country never come from the zone: it writes the year in two digits, and some
// countries' codes there are not ISO's (Germany's is `D`); Didit's `date_of_birth` and `issuing_state`
// are whole, the same on every document. A personal number keeps its letters and digits, in
// capitals, and nothing else. A document without a birth date or any name gives no row, and its check
// is `id_unclear`: a stamp signed without them would count nobody.

import { createHmac } from 'node:crypto'

import { type Decision, yearsOld } from './didit.ts'

/** Who an ID stamp is for, as the row takes it: each detail cleaned, or empty for one the ID lacks. */
export type Person = { firstName: string; lastName: string; birth: string; personalNumber: string; idType: string; country: string }

/** The row's columns, in its order, each its scrambled detail, or empty bytes for one the ID lacks. */
export const COLUMNS = ['first_name', 'last_name', 'birth', 'personal_number', 'id_type', 'country'] as const

/** One ID stamp's row: each column's detail, scrambled. */
export type Fingerprint = Record<(typeof COLUMNS)[number], Uint8Array>

/** A name cleaned: capitals, no accents, no apostrophe, and anything else not a letter a space, single spaces. */
export function clean(name: string): string {
  return name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’ʼ`´]/gu, '')
    .replace(/\P{L}+/gu, ' ')
    .trim()
}

/** A personal number cleaned: capitals, no accents, its letters and digits and nothing else. */
export const cleanNumber = (number: string) => number.toUpperCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '')

const first = (names: string) => clean(names).split(' ')[0] ?? ''

/** Who the document is for, from what Didit read, or null when it lacks a birth date (a real one, in a life, at `at`) or any name. */
export function personOf(decision: Decision, at: number): Person | null {
  const document = decision.document ?? {}
  const [given, family] = decision.mrz
    ? [decision.mrz.given, decision.mrz.family]
    : document.first_name || document.last_name
      ? [document.first_name ?? '', document.last_name ?? '']
      : [document.full_name ?? '', '']
  const country = (document.issuing_state ?? '').trim().toUpperCase()
  const person = {
    firstName: first(given),
    lastName: first(family),
    birth: (document.date_of_birth ?? '').trim(),
    personalNumber: cleanNumber(document.personal_number ?? ''),
    idType: clean(document.document_type ?? ''),
    country: /^[A-Z]{3}$/.test(country) ? country : '',
  }
  if (!person.firstName && !person.lastName) return null
  if (yearsOld(person.birth, at) === null) return null
  return person
}

/** The person's row, under `key`. */
export function fingerprintOf(key: Uint8Array, person: Person): Fingerprint {
  const details: Record<(typeof COLUMNS)[number], string> = {
    first_name: person.firstName,
    last_name: person.lastName,
    birth: person.birth,
    personal_number: person.personalNumber,
    id_type: person.idType,
    country: person.country,
  }
  const scrambled = (column: string, detail: string) =>
    detail === '' ? new Uint8Array(0) : new Uint8Array(createHmac('sha256', key).update(column, 'utf8').update(Uint8Array.of(0)).update(detail, 'utf8').digest())
  return Object.fromEntries(COLUMNS.map((column) => [column, scrambled(column, details[column])])) as Fingerprint
}
