// The host's credits, its seller: its credit key, its directory, a buy collected once a sponsor's
// ticket pays for it, the blind signatures it answers with, the proofs it took, its sponsors' bill,
// and its spent list, in one SQLite file that also holds the host's balances (src/credits.ts). A
// spend takes a list of credits together. See README.md, "Credits".
//
// Node only: the file is SQLite (node:sqlite), and the key a file the seller makes on the volume at
// its first start. It talks to no network. privacypass-ts reads the buy and writes the answer,
// unchanged; each signature is Node's own RSA (OpenSSL), a raw `m^d mod n`, since privacypass-ts's
// issuer signs with JavaScript big integers, hundreds of milliseconds a credit. Nothing here logs
// what it is sent.

import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, verify, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad } from '@scure/base'

import { CREDIT_TYPE, DIRECTORY_PATH, referenceOf, ticketMessage } from './credit.ts'

const { getPublicKeyBytes } = publicVerif

/** What one credit buys here, as the directory says it. */
export const UNIT = 'writes at this host'

/** Bytes in an array of their own: privacypass-ts reads a view's whole underlying buffer from its start. */
const own = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))

/** A service's credit key: its RSA halves, and the bytes its directory publishes (SubjectPublicKeyInfo, RSASSA-PSS). */
export type CreditKey = { privateKey: KeyObject; publicKey: KeyObject; published: Uint8Array }

/** The credit key from its private key, RSA-2048 in PKCS #8 (DER). Throws on any other kind or size. */
export async function keyFrom(pkcs8: Uint8Array): Promise<CreditKey> {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('a credit key is RSA-2048')
  const publicKey = createPublicKey(privateKey)
  const spki = await crypto.subtle.importKey('spki', publicKey.export({ format: 'der', type: 'spki' }), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify'])
  return { privateKey, publicKey, published: await getPublicKeyBytes(spki) }
}

/**
 * The credit key in the file at `path`: made there at the first start, RSA-2048 in PKCS #8 (DER),
 * and read on every start after. The file is the only place it is kept: `wx`, so a key already
 * there is never written over, and 0600, so only the host's own user reads it.
 */
export async function keyAt(path: string): Promise<CreditKey> {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(path, privateKey.export({ format: 'der', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
  }
  return keyFrom(new Uint8Array(readFileSync(path)))
}

/** The directory the host serves at DIRECTORY_PATH (RFC 9578 §4), with its `forest-credit` entry: what a credit buys and its price. */
function directoryOf(requestUri: string, key: Uint8Array, price: string): Record<string, unknown> {
  const forest = { unit: UNIT, price }
  return { 'issuer-request-uri': requestUri, 'token-keys': [{ 'token-type': CREDIT_TYPE, 'token-key': base64urlnopad.encode(key) }], 'forest-credit': forest }
}

/** How many credits a buy asks for: its requests, each one credit. Throws on bytes that are not a batch of requests. */
function countOf(buy: Uint8Array): number {
  let requests: genericBatched.TokenRequest[]
  try {
    requests = [...genericBatched.BatchedTokenRequest.deserialize(own(buy))]
  } catch {
    throw new Error('not a buy')
  }
  if (!requests.length) throw new Error('a buy holds one credit or more')
  return requests.length
}

/** RFC 9474's BlindSign: `s = m^d mod n`, then `s^e mod n` must give `m` back. Throws on a message the key cannot sign. */
function blindSign(key: CreditKey, blinded: Uint8Array): Uint8Array {
  const s = privateDecrypt({ key: key.privateKey, padding: constants.RSA_NO_PADDING }, blinded)
  if (!publicEncrypt({ key: key.publicKey, padding: constants.RSA_NO_PADDING }, s).equals(blinded)) throw new Error('signing failure')
  return new Uint8Array(s)
}

/** The service's answer to a paid buy: a blind signature for each request under `key`, an empty slot for any other. Deterministic: the same buy gets the same answer. */
export async function answer(buy: Uint8Array, key: CreditKey): Promise<Uint8Array> {
  const id = (await sha256(key.published)).at(-1)
  const responses: genericBatched.OptionalTokenResponse[] = []
  for (const request of genericBatched.BatchedTokenRequest.deserialize(own(buy))) {
    let response = null
    if (request.tokenType === CREDIT_TYPE && request.truncatedTokenKeyId === id) {
      try {
        response = new publicVerif.TokenResponse(blindSign(key, (request.tokenRequest as InstanceType<typeof publicVerif.TokenRequest>).blindedMsg))
      } catch {
        // A blinded message the key cannot sign: an empty slot, as for any other request.
      }
    }
    responses.push(new genericBatched.OptionalTokenResponse(response))
  }
  return new genericBatched.GenericBatchTokenResponse(responses).serialize()
}

/** An ed25519 public key's DER prefix, for node:crypto. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

function bytesOf(text: string, base: 'base58' | 'base64url', length: number): Uint8Array | null {
  try {
    const bytes = base === 'base58' ? base58.decode(text) : base64urlnopad.decode(text)
    const again = base === 'base58' ? base58.encode(bytes) : base64urlnopad.encode(bytes)
    return bytes.length === length && again === text ? bytes : null
  } catch {
    return null
  }
}

/** A ticket's parts, as `ticket` writes it: `<sponsor>.<credits>.<signature>`; null for anything else. */
function readTicket(text: string): { sponsor: string; key: Uint8Array; credits: number; signature: Uint8Array } | null {
  const [sponsor = '', credits = '', signature = '', ...rest] = text.split('.')
  const key = bytesOf(sponsor, 'base58', 32)
  const sig = bytesOf(signature, 'base64url', 64)
  if (rest.length || !key || !sig || !/^[1-9][0-9]{0,8}$/.test(credits)) return null
  return { sponsor, key, credits: Number(credits), signature: sig }
}

/** What a service answers: a status, a body (JSON, or bytes with their type). */
export type Answer = { status: number; body: unknown; type?: string }
const refuse = (error: string, status = 400, detail?: string): Answer => ({ status, body: detail === undefined ? { error } : { error, detail } })

/** `work` in one transaction: all of it, or, if it throws, none. Inside one already open, it is part of that one. */
function together<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work()
  db.exec('BEGIN IMMEDIATE')
  try {
    const done = work()
    db.exec('COMMIT')
    return done
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * The spent list, in the seller's file: every credit id the host took, and nothing else. A spend
 * marks its credits spent in the transaction that adds them to a folder's balance (src/credits.ts).
 */
export class SpentList {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
    this.#db.exec('CREATE TABLE IF NOT EXISTS spent (id TEXT PRIMARY KEY) WITHOUT ROWID')
  }

  /** Marks each of `ids` spent, all or none: false, and none marked, if one was spent already. */
  spend(ids: string[]): boolean {
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error('spend one id or more, each once')
    return together(this.#db, () => {
      if (ids.some((id) => this.#db.prepare('SELECT 1 FROM spent WHERE id = ?').get(id))) return false
      for (const id of ids) this.#db.prepare('INSERT INTO spent (id) VALUES (?)').run(id)
      return true
    })
  }
}

/** How the host sells its credits: see `seller`. */
export type SellerConfig = {
  /** Its public origin, `https://host`: the name its credits' challenge carries, and that a ticket names. */
  origin: string
  key: CreditKey
  /** Where a buy is collected, as its directory names it. */
  requestUri: string
  /** One credit's price, in whole dollars as decimal text. */
  price: string
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets it takes, by address. */
  sponsors: string[]
  /** Its one SQLite file, or ':memory:'. */
  path: string
}

/** The host's seller: see `seller`. */
export type Seller = {
  /** The seller's one file, open: the spent list, the proofs, the bill, and the host's balances. */
  db: DatabaseSync
  spent: SpentList
  /** `work` in one transaction of the seller's file. */
  together<T>(work: () => T): T
  /** The directory to serve at DIRECTORY_PATH. */
  directory(): Record<string, unknown>
  /** A buy collected, with the PAYMENT_HEADER that came with it: its blind signatures, or a refusal. */
  collect(buy: Uint8Array, header: string | undefined): Promise<Answer>
  /** How many credits each sponsor's tickets paid for. */
  bill(): Record<string, number>
  close(): void
}

/**
 * The host's seller of credits, in one SQLite file: its directory; each buy collected once a
 * sponsor's ticket pays for it (`ticket <ticket>`, in the PAYMENT_HEADER); the proofs it took, each
 * for one buy's reference only; how many credits each sponsor's tickets paid for (its bill, counted,
 * never capped); and the spent list. Other ways to pay are this host's to add.
 */
export function seller(config: SellerConfig): Seller {
  for (const s of config.sponsors) if (!bytesOf(s, 'base58', 32)) throw new Error('a sponsor is an address: an Ed25519 key, 32 bytes in base58')
  const sponsors = new Set(config.sponsors)
  const db = new DatabaseSync(config.path)
  db.exec('CREATE TABLE IF NOT EXISTS proofs (proof TEXT PRIMARY KEY, reference TEXT NOT NULL) WITHOUT ROWID')
  db.exec('CREATE TABLE IF NOT EXISTS bill (sponsor TEXT PRIMARY KEY, credits INTEGER NOT NULL) WITHOUT ROWID')
  const spent = new SpentList(db)
  const { origin, key, price, maxBuy } = config

  async function collect(buy: Uint8Array, header: string | undefined): Promise<Answer> {
    let count: number
    try {
      count = countOf(buy)
    } catch {
      return refuse('not_a_buy')
    }
    if (count > maxBuy) return refuse('too_many', 400, `at most ${maxBuy} credits a buy`)
    const reference = await referenceOf(buy)
    const owed = 'a ticket from a sponsor this host takes'
    if (!header?.trim()) return refuse('not_paid', 402, owed)
    const [kind, value = '', ...rest] = header.trim().split(' ')
    const t = kind === 'ticket' && !rest.length ? readTicket(value) : null
    if (!t) return refuse('bad_payment', 400, 'the forest-payment header is `ticket <ticket>`')
    const signed = verify(null, ticketMessage(origin, reference, count), { key: Buffer.concat([ED25519_SPKI, t.key]), format: 'der', type: 'spki' }, t.signature)
    if (!sponsors.has(t.sponsor) || t.credits !== count || !signed) return refuse('not_paid', 402, owed)
    const proof = `ticket ${t.sponsor} ${value.split('.')[2]}`
    const sponsor = t.sponsor
    // A proof pays for one buy: taken by another, it is refused; for this one again, the same answer,
    // and the bill counts it once.
    const usedElsewhere = together(db, () => {
      const taken = db.prepare('SELECT reference FROM proofs WHERE proof = ?').get(proof) as { reference: string } | undefined
      if (taken) return taken.reference !== reference
      db.prepare('INSERT INTO proofs (proof, reference) VALUES (?, ?)').run(proof, reference)
      db.prepare('INSERT INTO bill (sponsor, credits) VALUES (?, ?) ON CONFLICT (sponsor) DO UPDATE SET credits = credits + excluded.credits').run(sponsor, count)
      return false
    })
    if (usedElsewhere) return refuse('proof_used', 409)
    return { status: 200, body: await answer(buy, key), type: 'application/private-token-generic-batch-response' }
  }

  return {
    db,
    spent,
    together: (work) => together(db, work),
    directory: () => directoryOf(config.requestUri, key.published, price),
    collect,
    bill: () => Object.fromEntries((db.prepare('SELECT sponsor, credits FROM bill').all() as { sponsor: string; credits: number }[]).map((r) => [r.sponsor, r.credits])),
    close: () => db.close(),
  }
}

export { DIRECTORY_PATH }
