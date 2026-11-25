// The person codes: two keyed codes of who an ID stamp is for, so the ID check counts each person once
// across stamp numbers (server.ts's `signId`). The table and its key keep the old name, `fingerprint`.
//
//   full    every given name and every family name, the birth date, the ID's country
//   short   the first given name and the first family name, the birth date, the ID's country
//
// Each code is HMAC-SHA256, under the key the verifier's secret derives under `fingerprint` (seed.ts),
// of its kind (`full` or `short`), the names, the birth date and the country, each after a 0 byte, so
// a full code is never a short one and no field runs into the next. The names are cleaned: capitals,
// no accents, an apostrophe dropped and anything else that is not a letter a space, single spaces. The
// given names are joined to the family names, so two documents that split one name differently, as
// given and family, give the same full code. Without the secret, no guess can be tested against a code;
// whoever holds it can test a guess of a name, a birth date and a country.
//
// The names come from the document's machine-readable zone when it has one, as passports and most ID
// cards do: written there without accents and in Latin letters by its own rules, they are the same on
// every such document of one person. Otherwise from what Didit read on its face. The birth date and the
// country never come from the zone: it writes the year in two digits, and some countries' codes there
// are not ISO's (Germany's is `D`); Didit's `date_of_birth` and `issuing_state` are whole, the same on
// every document. A document without a birth date, a country or any name gives no codes, and its
// check is `id_unclear`: a stamp signed without them would count nobody.

import { createHmac } from 'node:crypto'

import { type Decision, yearsOld } from './didit.ts'

/** Who an ID stamp is for, as the codes take it: the cleaned names, the birth date (YYYY-MM-DD) and the ID's country (ISO 3166-1 alpha-3). */
export type Person = { given: string; family: string; birth: string; country: string }

/** The two codes of a person: `full` and `short`. */
export type Codes = { full: Uint8Array; short: Uint8Array }

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

/** Who the document is for, from what Didit read, or null when it lacks a birth date (a real one, in a life, at `at`), a country or any name. */
export function personOf(decision: Decision, at: number): Person | null {
  const document = decision.document ?? {}
  const [given, family] = decision.mrz
    ? [decision.mrz.given, decision.mrz.family]
    : document.first_name || document.last_name
      ? [document.first_name ?? '', document.last_name ?? '']
      : [document.full_name ?? '', '']
  const person = { given: clean(given), family: clean(family), birth: (document.date_of_birth ?? '').trim(), country: (document.issuing_state ?? '').trim().toUpperCase() }
  if (!person.given && !person.family) return null
  if (yearsOld(person.birth, at) === null) return null
  if (!/^[A-Z]{3}$/.test(person.country)) return null
  return person
}

/** The person's two codes, under `key`. */
export function codesOf(key: Uint8Array, person: Person): Codes {
  const words = (names: string) => names.split(' ').filter(Boolean)
  const [given, family] = [words(person.given), words(person.family)]
  const code = (kind: string, names: string) => {
    const hmac = createHmac('sha256', key).update(kind, 'utf8')
    for (const part of [names, person.birth, person.country]) hmac.update(Uint8Array.of(0)).update(part, 'utf8')
    return new Uint8Array(hmac.digest())
  }
  return { full: code('full', [...given, ...family].join(' ')), short: code('short', [given[0], family[0]].filter(Boolean).join(' ')) }
}
