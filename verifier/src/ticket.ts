// A sponsor's ticket: what the verifier signs to pay for a person's buy at a service that lists its
// sponsor key. The verifier is a client of credits here, not a seller: it never sees a credit, only
// the buy's reference. The wire format is the one the host checks (host/credits/).

import { b64u, base58 } from '@foundationforest/folders'

function addressBytes(text: unknown, what: string): Uint8Array {
  try {
    const bytes = base58.decode(text as string)
    if (bytes.length === 32 && base58.encode(bytes) === text) return bytes
  } catch {
    // Refused below.
  }
  throw new Error(`${what} is 32 bytes in base58`)
}

/** A service's origin, as a profile entry's `hosts` writes it: https, or http on loopback for tests. */
function checkOrigin(origin: string): void {
  const url = new URL(origin)
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('a service is an origin: https, or http on loopback for tests')
  }
}

/**
 * What a sponsor signs, with Ed25519, to pay for a buy: the service, the buy's reference and how many
 * credits it holds. So a ticket pays for that buy at that service, of that many credits, and no other.
 */
export function ticketMessage(origin: string, reference: string, credits: number): Uint8Array {
  checkOrigin(origin)
  addressBytes(reference, 'reference')
  if (!Number.isSafeInteger(credits) || credits < 1) throw new RangeError('a ticket is for one credit or more')
  return new TextEncoder().encode(`forest credit ticket\n${origin}\n${reference}\n${credits}`)
}

/** A ticket as the payment header carries it: the sponsor's address, the credits, and its signature of `ticketMessage`, base64url. */
export function ticket(sponsor: string, credits: number, signature: Uint8Array): string {
  addressBytes(sponsor, 'sponsor')
  if (signature.length !== 64) throw new Error('a signature is 64 bytes')
  return `${sponsor}.${credits}.${b64u.encode(signature)}`
}
