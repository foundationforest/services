// A connection: how one AI app reaches the person's signer through this copy. The signer makes it:
// an Ed25519 key pair, kept on the person's devices, whose public key, its 32 bytes in base64url,
// is the connection's id, saved in a rule on each profile the person chose as who: { connector:
// this copy's origin, connection: <id>, key }. This copy holds only the id. The key signs two texts, and nothing
// else here: a login, so only the signer can mint one for its connection, and a socket's challenge,
// so only the signer serves it.
//
// Ed25519 and not the standard's Baby Jubjub keys: a connection key is no profile's and no
// service's, and Ed25519 is in every browser's Web Crypto and in Node's crypto, so a signer needs
// nothing more to make one.

import { createPublicKey, verify } from 'node:crypto'
import { b64u } from '@foundationforest/records'

/** What a connection key signs for a login: this text, then the login request as this copy gave it. */
export const LOGIN = 'forest-mcp/v1/login\n'
/** What a connection key signs to register a socket: this text, this copy's origin, a newline, then the socket's challenge. */
export const REGISTER = 'forest-mcp/v1/register\n'

/** A connection's id: an Ed25519 public key, its 32 bytes in base64url, in its one spelling. */
export function isConnection(id: unknown): id is string {
  if (typeof id !== 'string' || id.length !== 43) return false
  try {
    return b64u.encode(b64u.decode(id)) === id
  } catch {
    return false
  }
}

/** Whether `sig`, 64 bytes in base64url, is the connection's Ed25519 signature on `text`. */
export function signedBy(connection: string, text: string, sig: unknown): boolean {
  if (!isConnection(connection) || typeof sig !== 'string') return false
  try {
    const bytes = b64u.decode(sig)
    if (bytes.length !== 64) return false
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: connection }, format: 'jwk' })
    return verify(null, Buffer.from(text, 'utf8'), key, bytes)
  } catch {
    return false
  }
}
