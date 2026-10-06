// Records, messages and pulls signed through the key store. forest's own accessRecord, signMessage
// and pullRequest take a key's private bytes; the key store never gives them out (keys.ts), so the
// same shapes are built here and only their signing input goes to the store. A record and a message
// pass forest's own shape check before they are signed; hosts check all three again.

import {
  type Body,
  type SignedMessage,
  type SignedPull,
  type SignedRecord,
  type UnsignedMessage,
  type UnsignedPull,
  type UnsignedRecord,
  b64u,
  checkMessageShape,
  checkShape,
  messageSigningInput,
  pullSigningInput,
  sealedTo,
  signingInput,
} from '../../forest/records/src/index.ts'
import { makePrivate } from '../../forest/records/src/private.ts'

import type { KeyStore } from './keys.ts'

/** A connection's key store, and the connection. */
export type Signer = { keys: KeyStore; connection: string }

const sig = async (s: Signer, address: string, bytes: Uint8Array) => b64u.encode(await s.keys.sign(s.connection, address, bytes))

/** A record by the write key at `address`, into `profile`'s folder. */
export async function accessRecord(s: Signer, address: string, profile: string, path: string, body: Body | null, time: number): Promise<SignedRecord> {
  const unsigned: UnsignedRecord = { v: 1, profile, path, time, body, by: address }
  checkShape(unsigned, false)
  return { ...unsigned, sig: await sig(s, address, signingInput(unsigned)) }
}

/** A pull of `profile`'s inbox, by the message key at `address`. */
export async function pullRequest(s: Signer, address: string, profile: string, after: number, time: number): Promise<SignedPull> {
  const unsigned: UnsignedPull = { v: 1, profile, after, time, key: address }
  return { ...unsigned, sig: await sig(s, address, pullSigningInput(unsigned)) }
}

/**
 * A message to `to`, sealed to its card's inbox key and readers, signed by the message key at
 * `address` for `from`, naming `host`, one of from's hosts.
 */
export async function message(s: Signer, address: string, from: string, host: string, to: string, body: Body, time: number, card: Body): Promise<SignedMessage> {
  const unsigned: UnsignedMessage = { v: 1, to, from, time, body: await makePrivate(body, sealedTo(card)), key: address, host }
  checkMessageShape(unsigned, false)
  return { ...unsigned, sig: await sig(s, address, messageSigningInput(unsigned)) }
}
