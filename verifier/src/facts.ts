// What a stamp's facts are made from.
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

import { createHmac } from 'node:crypto'

import { isFieldElement } from '@foundationforest/keys'
import type { Fact } from '@foundationforest/proofs'
import { b64u } from '@foundationforest/folders'

import { DOCUMENT_FIELDS, type Document } from './didit.ts'

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

/** A field element as decimal text, as the apps write a stamp number: no sign, no leading zero. */
const DECIMAL = /^(0|[1-9][0-9]{0,76})$/

/** A stamp number from its decimal text, or null. */
export function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const n = BigInt(value)
  return isFieldElement(n) ? n : null
}
