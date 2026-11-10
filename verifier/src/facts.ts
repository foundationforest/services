// What a stamp's facts are made from, and the ID check's fingerprint.
//
// A stamp is the standard's (proofs/verification/README.md, "The stamp and the verification"): the
// person's stamp number and one field element, `facts`, signed with the standard's `signStamp`.
// This verifier makes facts by a recipe fixed for each of its two keys, for good (a new recipe is a
// new key):
//
//   face key   Poseidon([h(model), h(embedding)])
//   ID key     Poseidon([h(model), h(embedding), fieldsRoot])
//
// Poseidon is the standard's, circomlib's, through poseidon-lite 0.3.0 as keys/ uses it; h(x) is
// SHA-256 of x's bytes, read as a big-endian integer, reduced mod BN254's scalar order (`BN254_R`).
//
//   model        the face model's name, as UTF-8 (`opencv-sface-2021dec`, face.ts)
//   embedding    the 512 bytes the face model gives for the check's selfie
//   fieldsRoot   the root of a Poseidon Merkle tree of depth FIELDS_DEPTH over the document's fields
//                (didit.ts reads them): one leaf Poseidon([h(name), h(value)]) for each, in the order
//                of their names, then leaves of 0; each node Poseidon([left, right]), the pair hash
//                the standard's reputation tree uses. That tree is Semaphore's, whose depth grows
//                with its leaves, so a fixed depth is built here: every path has FIELDS_DEPTH
//                siblings, so a circuit can prove one field and show none of the others.
//
// The stamp carries `fields` beside facts (server.ts), the fields as text (`fieldsText`), so the
// person keeps what it was made from and anyone can make it again.
//
// The fingerprint is how the verifier knows a person came to the ID check before without keeping who
// they are: HMAC-SHA256, under a key derived from the verifier's seed, of the standard's canonical
// JSON of `{birth, name}`: the name Didit reads, first and last, else the full name, in Unicode NFKC,
// lower case, one space between words; the birth date as YYYY-MM-DD. A reader of the file without the
// key cannot test a guessed name against it. The country is left out on purpose: a renewed document,
// or another country's, is the same person.

import { createHash, createHmac } from 'node:crypto'

import { BN254_R, isFieldElement } from '@foundationforest/keys'
import { canonical } from '@foundationforest/folders'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import { poseidon3 } from 'poseidon-lite/poseidon3'

import type { Document } from './didit.ts'

/**
 * The fields tree's depth: 2^8 = 256 leaves. Didit documents 17 top-level text fields and about 140
 * in `extra_fields`, most of them driving-licence classes; all of them fit at once.
 */
export const FIELDS_DEPTH = 8

/** The recipes, as `GET /` names them. */
export const RECIPES = {
  face: 'Poseidon([h(model), h(embedding)])',
  id: 'Poseidon([h(model), h(embedding), fieldsRoot])',
  h: 'SHA-256 of the bytes, read as a big-endian integer, mod the BN254 scalar order',
  fieldsRoot: `the root of a Poseidon Merkle tree of depth ${FIELDS_DEPTH} over the fields beside the stamp: one leaf Poseidon([h(name), h(value)]) for each, in the order of their names, then leaves of 0; each node Poseidon([left, right])`,
} as const

/** What the ID check reads of a person, written one way: what its fingerprint is made from. */
export type Person = { name: string; birth: string }

/** h(x): SHA-256 of x's bytes (text as UTF-8), read as a big-endian integer, reduced into the field. */
export function h(x: Uint8Array | string): bigint {
  return BigInt('0x' + createHash('sha256').update(x).digest('hex')) % BN254_R
}

/** The face key's facts: Poseidon([h(model), h(embedding)]). */
export function faceFacts(model: string, embedding: Uint8Array): bigint {
  return poseidon2([h(model), h(embedding)])
}

/** The fields' names in the order their leaves take: JavaScript's sort, by UTF-16 code units, as RFC 8785 orders keys. */
const names = (fields: Document) => Object.keys(fields).sort()

/**
 * The fields as text: RFC 8785 for this one shape, a flat object of text, written out here since the
 * standard's canonical JSON takes only `[a-z][a-zA-Z0-9]*` keys and Didit's names have `_` and `.`.
 * Its keys in the leaves' order; each key and value as JSON.stringify writes a string, which is RFC
 * 8785's form.
 */
export function fieldsText(fields: Document): string {
  return `{${names(fields).map((name) => `${JSON.stringify(name)}:${JSON.stringify(fields[name])}`).join(',')}}`
}

/** The fields tree's root (RECIPES.fieldsRoot). Refuses more fields than the tree has leaves. */
export function fieldsRoot(fields: Document): bigint {
  if (names(fields).length > 2 ** FIELDS_DEPTH) throw new RangeError(`a document's fields fit in 2^${FIELDS_DEPTH} leaves`)
  let level = names(fields).map((name) => poseidon2([h(name), h(fields[name]!)]))
  // The empty subtree at each height: a leaf of 0, then the hash of two of the height below.
  let empty = 0n
  for (let height = 0; height < FIELDS_DEPTH; height++) {
    const next: bigint[] = []
    for (let i = 0; i < level.length; i += 2) next.push(poseidon2([level[i]!, level[i + 1] ?? empty]))
    level = next
    empty = poseidon2([empty, empty])
  }
  return level[0] ?? empty
}

/** The ID key's facts: Poseidon([h(model), h(embedding), fieldsRoot]). */
export function idFacts(model: string, embedding: Uint8Array, fields: Document): bigint {
  return poseidon3([h(model), h(embedding), fieldsRoot(fields)])
}

/** Days from 1970-01-01 to a YYYY-MM-DD date, or null for anything that is not a real date. */
export function daysOf(birth: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number]
  const ms = Date.UTC(y, m - 1, d)
  // Date.UTC rolls 1990-02-30 over to March, and reads a year below 100 as 1900 and up: neither comes back the same.
  return new Date(ms).toISOString().slice(0, 10) === birth ? ms / 86_400_000 : null
}

/** One way to write a name: Unicode NFKC, lower case, one space between words. */
const oneWay = (name: string) => name.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' ')

/** The person a document step read, written one way; null when the name or a real birth date is missing. */
export function person(document: Document | null): Person | null {
  if (!document) return null
  const [first = '', last = '', full = ''] = [document.first_name, document.last_name, document.full_name]
  const name = oneWay(first.trim() && last.trim() ? `${first} ${last}` : full)
  const birth = (document.date_of_birth ?? '').trim()
  if (!name || daysOf(birth) === null) return null
  return { name, birth }
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
