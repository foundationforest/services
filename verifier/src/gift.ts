// The gifts: at a stamp number's first stamp from each check, the verifier gives the host credits the
// person's app buys, as their sponsor: FACE_CREDITS with the face stamp, ID_CREDITS with the ID stamp.
//
// The app makes one buy at the host, of exactly the credits the check's gift gives, and keeps what
// finishes it; it sends the verifier the buy's reference. The verifier's sponsor key signs a ticket for it
// (ticket.ts): that host, that buy, that many credits. The app collects the buy at the host with the
// ticket. The verifier sees the buy's reference, never the credits: the host signs them blind. It pays
// nothing and holds no money: the host lists the verifier's sponsor key and counts what its tickets
// paid for.

import { createHash } from 'node:crypto'

import { base58 } from '@foundationforest/folders'

import type { Check } from './didit.ts'
import type { Ed25519Key } from './seed.ts'
import { ticket, ticketMessage } from './ticket.ts'

/** The gifts: the host's origin, and how many of its credits each check's ticket gives; 0 for none. */
export type Gift = { origin: string; credits: Record<Check, number> }

function isReference(text: unknown): text is string {
  try {
    return typeof text === 'string' && base58.decode(text).length === 32 && base58.encode(base58.decode(text)) === text
  } catch {
    return false
  }
}

/**
 * A check's gift's ticket for the buy the app sent, signed by the sponsor key; `bad_gift` for anything
 * but a buy's reference. Ed25519 is deterministic: the same reference gives the same ticket.
 */
export function ticketFor(gift: Gift, check: Check, reference: unknown, sponsor: Ed25519Key): string | 'bad_gift' {
  if (!isReference(reference)) return 'bad_gift'
  const credits = gift.credits[check]
  return ticket(sponsor.address, credits, sponsor.sign(ticketMessage(gift.origin, reference, credits)))
}

/** What the file keeps of the buy a gift was given for: the SHA-256 of its reference. */
export function buyOf(reference: string): Uint8Array {
  return createHash('sha256').update(reference).digest()
}
