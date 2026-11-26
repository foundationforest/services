// The scrambled copies of who an ID stamp is for, so the ID check counts each person once across
// stamp numbers (server.ts's `signId`). The table and its key keep the old name, `fingerprint`.
//
// Up to two copies an ID stamp, each one value, each scrambled by scrypt (RFC 7914), a scramble
// made slow on purpose, with the key the verifier's secret derives under `fingerprint` (seed.ts) as
// its salt: keyed, one-way, and the same details always the same value, so a check finds a match by
// its own value alone.
//
//   name copy     the first given name, the first family name and the birth date, cleaned; every ID
//   number copy   the ID's personal number and its country; only an ID that shows a number meant to
//                 last a lifetime, and only for a country on LIFELONG
//
// Each copy has its own label inside the scramble, `name` or `number`, so the two can never match
// each other. Two IDs of one person match by the name copy when their three details do, whatever
// their countries, and by the number copy when they show the same number. Nothing else of the ID is
// kept: a rule that needs another detail applies to the checks after it. Both copies of a stamp
// number go five years after Didit first kept its face (store.ts, server.ts's `sweep`).
//
// SCRYPT's cost, 64 MB and about a fifth of a second a copy, is the point: without the secret no
// guess can be tested at all; with it, only a guessed name and birth date, or number, one at a
// time. Every birth date in a hundred years for one known name is about two hours of one machine's
// time; the whole table, every common first name by every common last name by every birth date,
// thousands of years.
//
// The names are cleaned: capitals, no accents, an apostrophe dropped and anything else that is not
// a letter a space, single spaces; then each is its first word. They come from the document's
// machine-readable zone when it has one, as passports and most ID cards do: written there without
// accents and in Latin letters by its own rules, they are the same on every such document of one
// person. Otherwise from what Didit read on its face. The first word, not Didit's
// `extra_fields.first_surname`, which only some IDs give: a first surname of three words is one
// word on one ID and three on another, and only its first word is the same on both. The birth date
// never comes from the zone, which writes its year in two digits: Didit's `date_of_birth` is whole,
// the same on every document. A document without a birth date or any name gives no copy, and its
// check is `id_unclear`: a stamp signed without one would count nobody.
//
// The number is Didit's `personal_number`, never its `document_number`, which changes with each new
// renewal. Mexico's, the CURP, is 18 characters, and Didit's INE read gave it there, in that shape;
// a value of any other shape is no number, and the ID gets only its name copy. A country is added
// to LIFELONG only after the legal chat has checked its rules.

import { scrypt } from 'node:crypto'

import { type Decision, yearsOld } from './didit.ts'

/**
 * The countries whose ID shows a personal number meant to last a lifetime, by Didit's `issuing_state`
 * (ISO 3166-1 alpha-3), each with the shape the number is read in: Mexico's CURP, four letters, six
 * digits (the birth date), the sex, the state, three consonants, a character that tells the century,
 * and a check digit. A number of another shape is not kept, so a misread one is no copy, not a wrong
 * one. To switch the number copy off, empty this list.
 */
export const LIFELONG: Readonly<Record<string, RegExp>> = { MEX: /^[A-Z]{4}\d{6}[HMX][A-Z]{2}[A-Z]{3}[A-Z0-9]\d$/ }

/** Who an ID stamp is for, as the copies take it: the first given name and the first family name, cleaned, either empty, the birth date, and the lifelong number with its country when the ID shows one. */
export type Person = { firstName: string; lastName: string; birth: string; lifelong: { number: string; country: string } | null }

/** An ID stamp's copies: the name copy, and the number copy when the ID shows a lifelong number. */
export type Copies = { name: Uint8Array; number?: Uint8Array }

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

/** The lifelong number the document shows, in capitals and with nothing but letters and digits, with its country, or null for an ID of a country off the list, with none, or in another shape. */
export function lifelongOf(document: Record<string, string>): Person['lifelong'] {
  const country = (document.issuing_state ?? '').trim().toUpperCase()
  const shape = Object.hasOwn(LIFELONG, country) ? LIFELONG[country] : undefined
  const number = (document.personal_number ?? '').toUpperCase().replace(/[\s-]+/g, '')
  return shape?.test(number) ? { number, country } : null
}

/** Who the document is for, from what Didit read, or null when it lacks a birth date (a real one, in a life, at `at`) or any name. */
export function personOf(decision: Decision, at: number): Person | null {
  const document = decision.document ?? {}
  const [given, family] = decision.mrz
    ? [decision.mrz.given, decision.mrz.family]
    : document.first_name || document.last_name
      ? [document.first_name ?? '', document.last_name ?? '']
      : [document.full_name ?? '', '']
  const person = { firstName: first(given), lastName: first(family), birth: (document.date_of_birth ?? '').trim(), lifelong: lifelongOf(document) }
  if (!person.firstName && !person.lastName) return null
  if (yearsOld(person.birth, at) === null) return null
  return person
}

/** One copy: scrypt of the label and the details, joined by 0 bytes, with `key` as its salt. */
export function scrambled(key: Uint8Array, label: 'name' | 'number', details: string[]): Promise<Uint8Array> {
  const { bytes, ...cost } = SCRYPT
  return new Promise((resolve, reject) => scrypt([label, ...details].join('\0'), key, bytes, cost, (error, value) => (error ? reject(error) : resolve(new Uint8Array(value)))))
}

/** The person's copies, made at once. */
export async function copiesOf(key: Uint8Array, person: Person): Promise<Copies> {
  const [name, number] = await Promise.all([
    scrambled(key, 'name', [person.firstName, person.lastName, person.birth]),
    person.lifelong ? scrambled(key, 'number', [person.lifelong.number, person.lifelong.country]) : undefined,
  ])
  return number ? { name, number } : { name }
}
