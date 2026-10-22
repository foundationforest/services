// The welcome gift: at a note number's first face note, the issuer gives the host credits the
// person's app buys, as their sponsor.
//
// The app makes one buy at the host, of exactly the credits the gift gives, and keeps what finishes
// it; it sends the issuer the buy's reference. The issuer's sponsor key signs a ticket for it
// (ticket.ts): that host, that buy, that many credits. The app collects the buy at the host with the
// ticket. The issuer sees the buy's reference, never the credits: the host signs them blind. It pays
// nothing and holds no money: the host lists the issuer's sponsor key and counts what its tickets
// paid for.

import { createHash } from 'node:crypto'

import { base58 } from '@foundationforest/records'

import type { Ed25519Key } from './seed.ts'
import { ticket, ticketMessage } from './ticket.ts'

/** The gift: the host's origin, and how many of its credits the ticket gives. */
export type Gift = { origin: string; credits: number }

function isReference(text: unknown): text is string {
  try {
    return typeof text === 'string' && base58.decode(text).length === 32 && base58.encode(base58.decode(text)) === text
  } catch {
    return false
  }
}

/**
 * The gift's ticket for the buy the app sent, signed by the sponsor key; `bad_gift` for anything but
 * a buy's reference. Ed25519 is deterministic: the same reference gives the same ticket.
 */
export function ticketFor(gift: Gift, reference: unknown, sponsor: Ed25519Key): string | 'bad_gift' {
  if (!isReference(reference)) return 'bad_gift'
  return ticket(sponsor.address, gift.credits, sponsor.sign(ticketMessage(gift.origin, reference, gift.credits)))
}

/** What the file keeps of the buy a gift was given for: the SHA-256 of its reference. */
export function buyOf(reference: string): Uint8Array {
  return createHash('sha256').update(reference).digest()
}
