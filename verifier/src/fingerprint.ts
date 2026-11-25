// The scrambled copy of who an ID stamp is for, so the ID check counts each person once across
// stamp numbers (server.ts's `signId`). The table and its key keep the old name, `fingerprint`.
//
// One value an ID stamp: its first name, first last name and birth date, cleaned, scrambled
// together by scrypt (RFC 7914), a scramble made slow on purpose, with the key the verifier's
// secret derives under `fingerprint` (seed.ts) as its salt: keyed, one-way, and the same three
// details always the same value, so a check finds a match by its own value alone. Two IDs of one
// person match when the three do, whatever their countries. Nothing else of the ID is kept: a rule
// that needs another detail applies to the checks after it.
//
// SCRYPT's cost, 64 MB and about a fifth of a second a check, is the point: without the secret no
// guess can be tested at all; with it, only a guessed name and birth date, one at a time. Every
// birth date in a hundred years for one known name is about two hours of one machine's time; the
// whole table, every common first name by every common last name by every birth date, thousands of
// years.
//
// The names are cleaned: capitals, no accents, an apostrophe dropped and anything else that is not
// a letter a space, single spaces; then each is its first word. They come from the document's
// machine-readable zone when it has one, as passports and most ID cards do: written there without
// accents and in Latin letters by its own rules, they are the same on every such document of one
// person. Otherwise from what Didit read on its face. The first word, not Didit's
// `extra_fields.first_surname`, which only some IDs give: a first surname of three words is one
// word on one ID and three on another, and only its first word is the same on both. The birth date
// never comes from the zone, which writes its year in two digits: Didit's `date_of_birth` is whole,
// the same on every document. A document without a birth date or any name gives no value, and its
// check is `id_unclear`: a stamp signed without one would count nobody.

import { scrypt } from 'node:crypto'

import { type Decision, yearsOld } from './didit.ts'

/** Who an ID stamp is for, as the scrambled copy takes it: the first given name and the first family name, cleaned, either empty, and the birth date. */
export type Person = { firstName: string; lastName: string; birth: string }

/** scrypt's cost: N, r and p, the memory it may take, and the length of its value. */
export const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024, bytes: 32 } as const

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

const first = (names: string) => clean(names).split(' ')[0] ?? ''

/** Who the document is for, from what Didit read, or null when it lacks a birth date (a real one, in a life, at `at`) or any name. */
export function personOf(decision: Decision, at: number): Person | null {
  const document = decision.document ?? {}
  const [given, family] = decision.mrz
    ? [decision.mrz.given, decision.mrz.family]
    : document.first_name || document.last_name
      ? [document.first_name ?? '', document.last_name ?? '']
      : [document.full_name ?? '', '']
  const person = { firstName: first(given), lastName: first(family), birth: (document.date_of_birth ?? '').trim() }
  if (!person.firstName && !person.lastName) return null
  if (yearsOld(person.birth, at) === null) return null
  return person
}

/** The person's scrambled copy, with `key` as scrypt's salt: of the first name, the first last name and the birth date, joined by 0 bytes. */
export function scrambled(key: Uint8Array, person: Person): Promise<Uint8Array> {
  const { bytes, ...cost } = SCRYPT
  const details = [person.firstName, person.lastName, person.birth].join('\0')
  return new Promise((resolve, reject) => scrypt(details, key, bytes, cost, (error, value) => (error ? reject(error) : resolve(new Uint8Array(value)))))
}
