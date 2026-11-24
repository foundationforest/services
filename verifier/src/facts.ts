// What a stamp's facts are made from, and whether an ID check read the same person as a Didit user.
//
// A stamp is the standard's (proofs/README.md, "The stamp and the verification"): the person's stamp
// number and one field element, `facts`, signed with the standard's `signStamp`. Both of this
// verifier's keys make facts by the standard's recipe for facts as a list (proofs/README.md, "Facts
// as a list"): `factsNumber` of the list the stamp carries beside it, under `factList`, so the person
// can show some of them with the standard's facts proof. Each fact is a name, a value and a salt; every
// value is text.
//
//   face key   model, the face model's name (`opencv-sface-2021dec`, face.ts), and embedding, the 512
//              bytes it gives for the check's selfie, as base64url text
//   ID key     those two, then each text field Didit read on the document, under Didit's own name
//              (didit.ts's `fieldsOf`), in the order of the names, as JavaScript sorts them
//
// The salts are the standard's kind, each a number below BN254's scalar order, but derived rather than
// drawn (`saltsOf`): the first 31 bytes, read big-endian, of HMAC-SHA256, under the key the verifier's
// secret derives under `fact-salt` (seed.ts), of the session's id, a 0 byte and the fact's name. So a
// session signed again within its hour (server.ts) gives the same list, the same facts and the same
// stamp, as the person's app lost the first answer; an ID check's face stamp, from the same selfie,
// takes the same session's salts, and the verifier tells whether the face stamp a stamp number holds
// is the one this session signed by their facts. To anyone without the
// secret they are random; whoever holds it already holds every facts number the verifier signed.
//
// Who an ID check read is how the verifier knows a person came to it before, while keeping nothing
// of who they are: Didit's face search finds the faces like this one, and the verifier compares what
// this check read with each matched face's Didit user (`samePerson`). A name alone never decides,
// so strangers with one name and birth date both pass; a face alone never decides, so twins pass.
// The country is left out on purpose: a renewed document, or another country's, is the same person.

import { createHmac } from 'node:crypto'

import { isFieldElement } from '@foundationforest/keys'
import type { Fact } from '@foundationforest/proofs'
import { b64u } from '@foundationforest/folders'

import { DOCUMENT_FIELDS, type Document, type User } from './didit.ts'

/** The face key's facts, by name, in their list's order. */
export const FACE_FACTS = ['model', 'embedding'] as const

/** The ID key's facts, by name, in their list's order: `extra_fields.<its key>` stands for each of a document's own. */
export const ID_FACTS = [...FACE_FACTS, ...[...DOCUMENT_FIELDS, 'extra_fields.<its key>'].sort()] as const

/** The recipe, as `GET /` names it. */
export const RECIPE = "the standard's facts as a list (proofs/README.md, Facts as a list): factsNumber of the list beside the stamp, under factList"

/** A session's salts, one for each fact's name (`saltsOf`). */
export type Salts = (name: string) => string

/**
 * The salts of a session's facts: for each name, the first 31 bytes of HMAC-SHA256 under `key` of the
 * session's id, a 0 byte and the name, read big-endian, so below BN254's scalar order, in decimal text.
 */
export function saltsOf(key: Uint8Array, sessionId: string): Salts {
  return (name) => BigInt('0x' + createHmac('sha256', key).update(sessionId).update(Uint8Array.of(0)).update(name).digest('hex').slice(0, 62)).toString()
}

const fact = (name: string, value: string, salts: Salts): Fact => ({ name, value, salt: salts(name) })

/** The face key's list: the face model's name, and the selfie's embedding as base64url text. */
export function faceList(model: string, embedding: Uint8Array, salts: Salts): Fact[] {
  return [fact('model', model, salts), fact('embedding', b64u.encode(embedding), salts)]
}

/** The ID key's list: the face key's two, then every field of the document, in the order of their names. */
export function idList(model: string, embedding: Uint8Array, document: Document, salts: Salts): Fact[] {
  return [...faceList(model, embedding, salts), ...Object.keys(document).sort().map((name) => fact(name, document[name]!, salts))]
}

/** Who an ID check read: the words of its first name and of its full name, and its birth date as YYYY-MM-DD. */
export type Person = { first: string[]; full: string[]; birth: string }

/** Days from 1970-01-01 to a YYYY-MM-DD date, or null for anything that is not a real date. */
export function daysOf(birth: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number]
  const ms = Date.UTC(y, m - 1, d)
  // Date.UTC rolls 1990-02-30 over to March, and reads a year below 100 as 1900 and up: neither comes back the same.
  return new Date(ms).toISOString().slice(0, 10) === birth ? ms / 86_400_000 : null
}

/** The words of a name: Unicode NFKD, its marks removed, lower case, letters only. */
export const words = (name: string | null | undefined): string[] =>
  (name ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? []

/** Who a document step read; null when it read no name, first or full, or no real birth date. */
export function person(document: Document | null): Person | null {
  if (!document) return null
  const [first, full] = [words(document.first_name), words(document.full_name)]
  const birth = (document.date_of_birth ?? '').trim()
  if ((first.length === 0 && full.length === 0) || daysOf(birth) === null) return null
  return { first, full, birth }
}

/** Every one of `some`, at least one, is among `all`. */
const within = (some: string[], all: string[]) => some.length > 0 && some.every((word) => all.includes(word))

/**
 * Whether this check read the same person as a Didit user its face matched: the same birth date, and
 * names that fit, every word of this check's first name in the user's full name, or every word of
 * the user's full name in this check's. A user with no name: the birth date alone decides.
 */
export function samePerson(person: Person, user: User): boolean {
  if (user.birth?.trim() !== person.birth) return false
  const theirs = words(user.fullName)
  return theirs.length === 0 || within(person.first, theirs) || within(theirs, person.full)
}

/** A field element as decimal text, as the apps write a stamp number: no sign, no leading zero. */
const DECIMAL = /^(0|[1-9][0-9]{0,76})$/

/** A stamp number from its decimal text, or null. */
export function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const n = BigInt(value)
  return isFieldElement(n) ? n : null
}
