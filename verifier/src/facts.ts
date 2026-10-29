// What a stamp's facts are made from, and the ID check's fingerprint.
//
// A stamp is the standard's (proofs/verification/README.md, "The stamp and the verification"): the
// person's stamp number and one field element, `facts`, signed with the standard's `signStamp`.
// This verifier makes facts by a recipe fixed for each of its two keys, for good (a new recipe is a
// new key):
//
//   face key   Poseidon([h(model), h(embedding)])
//   ID key     Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])
//
// Poseidon is the standard's, circomlib's, through poseidon-lite 0.3.0 as keys/ uses it; h(x) is
// SHA-256 of x's bytes, read as a big-endian integer, reduced mod BN254's scalar order (`BN254_R`).
//
//   model            the face model's name, as UTF-8 (`opencv-sface-2021dec`, face.ts)
//   embedding        the 512 bytes the face model gives for the check's selfie
//   name             the name Didit reads on the document, first and last, else the full name; NFKC,
//                    lower case, one space between words; as UTF-8
//   birthDays        days from 1970-01-01 to the birth date (YYYY-MM-DD), negative before it, reduced
//                    into the field as h is
//   countryNumeric   the document's country, Didit's `issuing_state` (ISO 3166-1 alpha-3), as its ISO
//                    3166-1 numeric code; 0 when it has none (Kosovo) or none was read, so a gap in
//                    the table never turns a person away
//
// The stamp carries these fields beside facts (server.ts), so the person keeps what it was made
// from and anyone can make it again.
//
// The fingerprint is how the verifier knows a person came to the ID check before without keeping who
// they are: HMAC-SHA256, under a key mixed from the verifier's seed, of the standard's canonical JSON of
// `{birth, name}`, written as above. A reader of the file without the key cannot test a guessed name
// against it. The country is left out on purpose: a renewed document, or another country's, is the
// same person.

import { createHash, createHmac } from 'node:crypto'

import { BN254_R, isFieldElement } from '@foundationforest/keys'
import { canonical } from '@foundationforest/folders'
import countries from 'i18n-iso-countries'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import { poseidon5 } from 'poseidon-lite/poseidon5'

import type { Document } from './didit.ts'

/** The recipes, as `GET /` names them. */
export const RECIPES = {
  face: 'Poseidon([h(model), h(embedding)])',
  id: 'Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])',
  h: 'SHA-256 of the bytes, read as a big-endian integer, mod the BN254 scalar order',
} as const

/** What the ID check reads of a person, written one way: what its facts and fingerprint are made from. */
export type Person = { name: string; birth: string; country: number }

/** h(x): SHA-256 of x's bytes (text as UTF-8), read as a big-endian integer, reduced into the field. */
export function h(x: Uint8Array | string): bigint {
  return BigInt('0x' + createHash('sha256').update(x).digest('hex')) % BN254_R
}

/** The face key's facts: Poseidon([h(model), h(embedding)]). */
export function faceFacts(model: string, embedding: Uint8Array): bigint {
  return poseidon2([h(model), h(embedding)])
}

/** Days from 1970-01-01 to a YYYY-MM-DD date, or null for anything that is not a real date. */
export function daysOf(birth: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number]
  const ms = Date.UTC(y, m - 1, d)
  // Date.UTC rolls 1990-02-30 over to March, and reads a year below 100 as 1900 and up: neither comes back the same.
  return new Date(ms).toISOString().slice(0, 10) === birth ? ms / 86_400_000 : null
}

/** The ID key's facts: Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric]). */
export function idFacts(model: string, embedding: Uint8Array, person: Person): bigint {
  const days = BigInt(daysOf(person.birth)!)
  return poseidon5([h(model), h(embedding), h(person.name), ((days % BN254_R) + BN254_R) % BN254_R, BigInt(person.country)])
}

/** One way to write a name: Unicode NFKC, lower case, one space between words. */
const oneWay = (name: string) => name.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' ')

/** An ISO 3166-1 alpha-3 code's numeric code, as a number; 0 for none. */
export function countryNumeric(alpha3: string): number {
  const code = alpha3.trim().toUpperCase()
  const numeric = /^[A-Z]{3}$/.test(code) ? countries.alpha3ToNumeric(code) : undefined
  return numeric ? Number(numeric) : 0
}

/** The person a document step read, written one way; null when the name or a real birth date is missing. */
export function person(document: Document | null): Person | null {
  if (!document) return null
  const name = oneWay(document.firstName.trim() && document.lastName.trim() ? `${document.firstName} ${document.lastName}` : document.fullName)
  const birth = document.birth.trim()
  if (!name || daysOf(birth) === null) return null
  return { name, birth, country: countryNumeric(document.country) }
}

/** The fingerprint of a person: HMAC-SHA256 under `key` of canonical `{birth, name}`. */
export function fingerprint(key: Uint8Array, person: Person): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(canonical({ birth: person.birth, name: person.name })).digest())
}

/** A field element as decimal text, as the apps write a stamp number: no sign, no leading zero. */
const DECIMAL = /^(0|[1-9][0-9]{0,76})$/

/** A stamp number from its decimal text, or null. */
export function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const n = BigInt(value)
  return isFieldElement(n) ? n : null
}
