// Where a connection's keys live, behind one interface. The service never asks for a private half
// back: it asks the store to sign bytes with a key it holds, or to open an envelope with a read key
// it holds. So a later driver, a signer inside an enclave, fits the same interface without ever
// letting a key out.
//
// FileKeys is the first driver: each connection's grants in one row of the service's SQLite file,
// encrypted with AES-256-GCM under a key HKDF-SHA256 mixes from KEYHOLDER_SECRET, a new random
// nonce for each write, and the connection's id as associated data, so a row copied under another
// connection does not open. The secret is in no file.

import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { identityToRecipient } from 'age-encryption'

import { type Body, type Grant, b64u, keyFromPrivate } from '../../forest/records/src/index.ts'
import { openPrivate } from '../../forest/records/src/private.ts'

/** A grant without its private half: `address` is the key's address, or a read key's `age1pq1…` recipient. */
export type Held = Omit<Grant, 'key'> & { address: string }

export interface KeyStore {
  /** Keep a connection's grants. */
  put(connection: string, grants: Grant[]): Promise<void>
  /** What a connection holds, public halves only; empty when it holds nothing. */
  held(connection: string): Promise<Held[]>
  /** Sign bytes with the write or message key at this address. */
  sign(connection: string, address: string, bytes: Uint8Array): Promise<Uint8Array>
  /** Open an envelope with the read key whose recipient this is. Throws if it was not made for it. */
  open(connection: string, recipient: string, body: Body): Promise<Body>
  /** Forget a connection's keys. */
  drop(connection: string): Promise<void>
}

/** The address an access key is listed under: a read key's recipient, or any other key's address. */
export async function addressOf(grant: Grant): Promise<string> {
  return grant.scope === 'read' ? identityToRecipient(grant.key) : keyFromPrivate(b64u.decode(grant.key)).address
}

/** An ed25519 private key as node:crypto takes it: its 32 bytes behind PKCS #8's fixed prefix. */
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const NONCE = 12
const TAG = 16

export class FileKeys implements KeyStore {
  readonly #db: DatabaseSync
  readonly #key: Buffer

  constructor(db: DatabaseSync, secret: string) {
    this.#db = db
    this.#key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'forest/keyholder/v1', 32))
    db.exec('CREATE TABLE IF NOT EXISTS keys (connection TEXT PRIMARY KEY, box BLOB NOT NULL)')
  }

  async put(connection: string, grants: Grant[]): Promise<void> {
    const nonce = randomBytes(NONCE)
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce).setAAD(Buffer.from(connection, 'utf8'))
    const box = Buffer.concat([nonce, cipher.update(JSON.stringify(grants), 'utf8'), cipher.final(), cipher.getAuthTag()])
    this.#db.prepare('INSERT OR REPLACE INTO keys (connection, box) VALUES (?, ?)').run(connection, box)
  }

  #grants(connection: string): Grant[] {
    const row = this.#db.prepare('SELECT box FROM keys WHERE connection = ?').get(connection)
    if (!row) return []
    const box = Buffer.from(row.box as Uint8Array)
    const decipher = createDecipheriv('aes-256-gcm', this.#key, box.subarray(0, NONCE)).setAAD(Buffer.from(connection, 'utf8'))
    decipher.setAuthTag(box.subarray(box.length - TAG))
    return JSON.parse(Buffer.concat([decipher.update(box.subarray(NONCE, box.length - TAG)), decipher.final()]).toString('utf8')) as Grant[]
  }

  async #find(connection: string, address: string): Promise<Grant> {
    for (const g of this.#grants(connection)) if ((await addressOf(g)) === address) return g
    throw new Error(`this connection holds no key ${address}`)
  }

  async held(connection: string): Promise<Held[]> {
    return Promise.all(
      this.#grants(connection).map(async (grant) => {
        const { key: _key, ...rest } = grant
        return { ...rest, address: await addressOf(grant) }
      }),
    )
  }

  async sign(connection: string, address: string, bytes: Uint8Array): Promise<Uint8Array> {
    const grant = await this.#find(connection, address)
    if (grant.scope === 'read') throw new Error('a read key does not sign')
    const key = createPrivateKey({ key: Buffer.concat([PKCS8, b64u.decode(grant.key)]), format: 'der', type: 'pkcs8' })
    return new Uint8Array(sign(null, bytes, key))
  }

  async open(connection: string, recipient: string, body: Body): Promise<Body> {
    const grant = await this.#find(connection, recipient)
    if (grant.scope !== 'read') throw new Error('only a read key opens')
    return openPrivate(body, grant.key)
  }

  async drop(connection: string): Promise<void> {
    this.#db.prepare('DELETE FROM keys WHERE connection = ?').run(connection)
  }
}
