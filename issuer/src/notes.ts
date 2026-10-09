// Notes as they travel between the issuer and a person's app, and the fingerprint of a document.
//
// A note is forest's (standard/registry/README.md, "The note and the person proof"): the person's note
// number, a face embedding, the model that made it and a tier, signed by the issuer's note key with
// forest's `signNote`. As JSON, every number is decimal text, the embedding base64url, and the
// issuer's key 128 hex characters, x then y, as a registry row holds it:
//
//   {"embedding":"<base64url>","issuer":"<128 hex>","model":"opencv-sface-2021dec","noteNumber":"<decimal>",
//    "signature":{"R8":["<decimal>","<decimal>"],"S":"<decimal>"},"tier":"1"}
//
// The fingerprint is how the issuer knows a document's person came before without keeping who they
// are: HMAC-SHA256 under a key mixed from the issuer's seed, of the name, the birth date and the
// document's country, each written one way. A reader of the file without the key cannot test a
// guessed name against it.

import { createHmac } from 'node:crypto'

import { b64u, hex } from '../../standard/records/src/bytes.ts'
import { canonical } from '../../standard/records/src/canonical.ts'
import { fromBytes32, isFieldElement } from '../../standard/registry/client/src/field.ts'
import type { IssuerKey, SignedNote } from '../../standard/registry/client/src/person.ts'
import { issuerKeyBytes } from '../../standard/registry/client/src/program.ts'
import type { Document } from './didit.ts'

/** The two tiers this issuer signs: 1 after the face check, 2 after the document check. */
export const TIER = { face: 1n, id: 2n } as const

/** The largest embedding a note shown to this issuer may carry. */
const MAX_EMBEDDING_BYTES = 2048
/** A field element as decimal text, as the issuer and the apps write one: no sign, no leading zero. */
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

export type NoteJson = {
  embedding: string
  issuer: string
  model: string
  noteNumber: string
  signature: { R8: [string, string]; S: string }
  tier: string
}

/** An issuer's key as 128 hex characters, x then y: how rows, inboxes and the index name it. */
export const issuerHex = (key: IssuerKey): string => hex.encode(issuerKeyBytes(key))

export function noteToJson(note: SignedNote): NoteJson {
  return {
    embedding: b64u.encode(note.embedding),
    issuer: issuerHex(note.issuer),
    model: note.model,
    noteNumber: note.noteNumber.toString(),
    signature: { R8: [note.signature.R8[0].toString(), note.signature.R8[1].toString()], S: note.signature.S.toString() },
    tier: note.tier.toString(),
  }
}

/** A field element from its decimal text, or null. */
export function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const n = BigInt(value)
  return isFieldElement(n) ? n : null
}

/** A note from its JSON, in exactly that shape, or null. Whether its issuer signed it is `noteSigned`'s to say. */
export function noteFromJson(value: unknown): SignedNote | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join() !== 'embedding,issuer,model,noteNumber,signature,tier') return null
  const sig = v.signature as Record<string, unknown> | null
  if (typeof sig !== 'object' || sig === null || Object.keys(sig).sort().join() !== 'R8,S' || !Array.isArray(sig.R8) || sig.R8.length !== 2) return null
  const numbers = [v.noteNumber, v.tier, sig.R8[0], sig.R8[1], sig.S].map(decimal)
  if (numbers.some((n) => n === null)) return null
  const [noteNumber, tier, r8x, r8y, s] = numbers as bigint[]
  if (typeof v.issuer !== 'string' || !/^[0-9a-f]{128}$/.test(v.issuer)) return null
  if (typeof v.model !== 'string' || v.model === '' || v.model.length > 128) return null
  if (typeof v.embedding !== 'string' || !/^[A-Za-z0-9_-]*$/.test(v.embedding) || v.embedding.length > (MAX_EMBEDDING_BYTES * 4) / 3 + 4) return null
  let embedding: Uint8Array
  try {
    embedding = b64u.decode(v.embedding)
  } catch {
    return null
  }
  if (b64u.encode(embedding) !== v.embedding) return null
  const key = hex.decode(v.issuer)
  return {
    noteNumber: noteNumber!,
    embedding,
    model: v.model,
    tier: tier!,
    issuer: [fromBytes32(key.subarray(0, 32)), fromBytes32(key.subarray(32))],
    signature: { R8: [r8x!, r8y!], S: s! },
  }
}

/** One way to write a name: Unicode NFKC, lower case, one space between words. */
const oneWay = (name: string) => name.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' ')

/**
 * The document's fingerprint: HMAC-SHA256 under `key` of the name (first and last, else the full
 * name), the birth date (YYYY-MM-DD) and the document's country (ISO 3166-1 alpha-3). Null when any
 * of the three is missing.
 */
export function fingerprint(key: Uint8Array, document: Document | null): Uint8Array | null {
  if (!document) return null
  const name = oneWay(document.firstName && document.lastName ? `${document.firstName} ${document.lastName}` : document.fullName)
  const birth = document.birth.trim()
  const country = document.country.trim().toUpperCase()
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(birth) || !/^[A-Z]{3}$/.test(country)) return null
  return new Uint8Array(createHmac('sha256', key).update(canonical({ birth, country, name })).digest())
}
