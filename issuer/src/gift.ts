// The welcome gift: at a person's first note, the issuer gives the credits their app buys at the
// services its settings name, a few registrations at the registry payer and writes at the host, as
// their sponsor.
//
// The app makes each buy (credits/, `buy`) and keeps what finishes it; it sends the issuer
// each buy's reference. For each, the issuer's sponsor key signs a ticket (standard's
// `ticketMessage`): that service, that buy, the count the gift gives there. The app collects each
// buy at its service with its ticket. The issuer sees each buy's reference, never the credits: the
// service signs them blind. It pays nothing and holds no money: each service lists the issuer's
// sponsor key and counts what its tickets paid for.

import { createHash } from 'node:crypto'

import { ticket, ticketMessage } from '../../credits/src/index.ts'
import { base58 } from '../../standard/records/src/bytes.ts'
import type { IssuerKey } from './key.ts'

/** One service in the gift: where it is, and how many of its credits a ticket there gives. */
export type GiftService = { origin: string; credits: number }
/** The gift, by what each service is to the person's app: `registryPayer`, `host`. */
export type Gift = Record<string, GiftService>

function isReference(text: unknown): text is string {
  try {
    return typeof text === 'string' && base58.decode(text).length === 32 && base58.encode(base58.decode(text)) === text
  } catch {
    return false
  }
}

/**
 * The gift's tickets, one for each service in the gift and no other, from the buys' references the
 * app sent, signed by the sponsor key; `bad_gift` for anything else. Ed25519 is deterministic: the
 * same references give the same tickets.
 */
export function ticketsFor(gift: Gift, references: Record<string, unknown>, sponsor: IssuerKey): Record<string, string> | 'bad_gift' {
  const roles = Object.keys(gift).sort()
  if (Object.keys(references).sort().join() !== roles.join() || !roles.every((role) => isReference(references[role]))) return 'bad_gift'
  return Object.fromEntries(
    roles.map((role) => {
      const { origin, credits } = gift[role]!
      return [role, ticket(sponsor.address, credits, sponsor.sign(ticketMessage(origin, references[role] as string, credits)))]
    }),
  )
}

/** What the file keeps of the buys a gift was given for: SHA-256 of each role and its reference, in order. */
export function buysOf(references: Record<string, unknown>): Uint8Array {
  const hash = createHash('sha256')
  for (const role of Object.keys(references).sort()) hash.update(`${role} ${String(references[role])}\n`)
  return hash.digest()
}
