// Forest credits, a service's side: its credit key, and its seller: the directory, a buy collected
// once a proof pays for it, the blind signatures it answers with, the proofs it took, its sponsors'
// bill, and its spent list. See README.md, "Selling credits".
//
// Node only, like records' host: the seller's one file is SQLite (node:sqlite). It talks to no
// network of its own: a Solana payment is checked through the RPC the service passes it, one call.
// privacypass-ts reads the buy and writes the answer, unchanged; each signature is Node's own RSA
// (OpenSSL), a raw `m^d mod n`, since privacypass-ts's issuer signs with JavaScript big integers,
// hundreds of milliseconds a credit. Nothing here logs what it is sent.

import { constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, verify, type KeyObject } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad } from '@scure/base'

import { CREDIT_TYPE, DIRECTORY_PATH, amountOf, referenceOf, ticketMessage } from './index.ts'

const { getPublicKeyBytes } = publicVerif

/** Bytes in an array of their own: privacypass-ts reads a view's whole underlying buffer from its start. */
const own = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))

/** A service's credit key: its RSA halves, and the bytes its directory publishes (SubjectPublicKeyInfo, RSASSA-PSS). */
export type CreditKey = { privateKey: KeyObject; publicKey: KeyObject; published: Uint8Array }

/**
 * The service's credit key from its private key, RSA-2048 in PKCS #8 (DER), as `openssl genpkey
 * -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | openssl pkcs8 -topk8 -nocrypt -outform DER` writes
 * one (genpkey's own DER is PKCS #1, which this refuses). Throws on any other size.
 */
export async function keyFrom(pkcs8: Uint8Array): Promise<CreditKey> {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('a credit key is RSA-2048')
  const publicKey = createPublicKey(privateKey)
  const spki = await crypto.subtle.importKey('spki', publicKey.export({ format: 'der', type: 'spki' }), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify'])
  return { privateKey, publicKey, published: await getPublicKeyBytes(spki) }
}

/** The directory a service serves at DIRECTORY_PATH (RFC 9578 §4), with its `forest-credit` entry. */
function directoryOf(requestUri: string, key: Uint8Array, credit: { unit: string; address: string; mint: string; price: string }): Record<string, unknown> {
  return { 'issuer-request-uri': requestUri, 'token-keys': [{ 'token-type': CREDIT_TYPE, 'token-key': base64urlnopad.encode(key) }], 'forest-credit': { ...credit } }
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

/** A JSON-RPC call to a Solana RPC the service chooses: `method` with `params`, giving the result. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
type Transaction = {
  meta: { err: unknown; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; loadedAddresses?: { writable?: string[]; readonly?: string[] } } | null
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } }
}

/** `amount`, decimal text in whole units, in units of 10^-decimals; null if it has more decimal places than that. */
function baseUnits(amount: string, decimals: number): bigint | null {
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole! + fraction.padEnd(decimals, '0'))
}

/** Every account a transaction names, in the order its balances list them: its own, then those its lookup tables load. */
function keysOf(tx: Transaction): string[] {
  const loaded = tx.meta?.loadedAddresses
  return [...tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)), ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]
}

/** What `address` gained in `mint` (or SOL) in this transaction, in base units, and the decimals they are in. */
function received(tx: Transaction, address: string, mint: string): { units: bigint; decimals: number } {
  const meta = tx.meta!
  if (mint === 'SOL') {
    const i = keysOf(tx).indexOf(address)
    if (i < 0) return { units: 0n, decimals: 9 }
    return { units: BigInt(meta.postBalances?.[i] ?? 0) - BigInt(meta.preBalances?.[i] ?? 0), decimals: 9 }
  }
  const mine = (balances: TokenBalance[] | undefined) => (balances ?? []).filter((b) => b.owner === address && b.mint === mint)
  const after = mine(meta.postTokenBalances)
  const sum = (balances: TokenBalance[]) => balances.reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n)
  return { units: sum(after) - sum(mine(meta.preTokenBalances)), decimals: after[0]?.uiTokenAmount.decimals ?? 0 }
}

/**
 * A Solana payment: does the transaction with this signature pay for the buy? Finalized, with no
 * error, naming the buy's reference among its accounts, and paying `address` at least `amount`
 * (decimal text, whole units) of `mint` (or SOL). One call through `rpc`; throws when it does.
 */
async function paysFor(rpc: Rpc, signature: string, owed: { reference: string; address: string; mint: string; amount: string }): Promise<boolean> {
  const tx = (await rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }])) as Transaction | null
  if (!tx?.meta || tx.meta.err !== null || !keysOf(tx).includes(owed.reference)) return false
  const got = received(tx, owed.address, owed.mint)
  const units = baseUnits(owed.amount, got.decimals)
  return units !== null && got.units >= units
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

/** What a request showing a credit is told: the credit is held for it now, or it was spent, or another request holds it. */
export type Hold = 'held' | 'spent' | 'busy'

/**
 * The spent list: every credit id the service took, held while its action is in flight, spent once
 * it lands, freed if it fails or can no longer land. Ids only, and, for a hold, a note the service
 * writes for itself (what to look for to know whether the action landed) and when. In its own file,
 * or in a file the service already has open, such as its seller's.
 */
export class SpentList {
  readonly #db: DatabaseSync
  readonly #own: boolean

  constructor(file: string | DatabaseSync) {
    this.#own = typeof file === 'string'
    this.#db = typeof file === 'string' ? new DatabaseSync(file) : file
    this.#db.exec('CREATE TABLE IF NOT EXISTS credits (id TEXT PRIMARY KEY, spent INTEGER NOT NULL, note TEXT, at INTEGER) WITHOUT ROWID')
  }

  /**
   * Hold `id` for a request now, or several ids together, all or none: `held` if each was free,
   * `spent` if one was spent, `busy` if another request holds one.
   */
  hold(id: string | string[], note: string | null = null, at: number = Date.now()): Hold {
    const ids = typeof id === 'string' ? [id] : id
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error('hold one id or more, each once')
    return together(this.#db, () => {
      const rows = ids.map((i) => this.#db.prepare('SELECT spent FROM credits WHERE id = ?').get(i) as { spent: number } | undefined)
      if (rows.some((r) => r?.spent)) return 'spent'
      if (rows.some((r) => r)) return 'busy'
      for (const i of ids) this.#db.prepare('INSERT INTO credits (id, spent, note, at) VALUES (?, 0, ?, ?)').run(i, note, at)
      return 'held'
    })
  }

  /** The action landed: `id`, or each of several, is spent, for good. */
  land(id: string | string[]): void {
    together(this.#db, () => {
      for (const i of typeof id === 'string' ? [id] : id) this.#db.prepare('UPDATE credits SET spent = 1, note = NULL, at = NULL WHERE id = ?').run(i)
    })
  }

  /** The action failed, or can no longer land: `id`, or each of several, is free to be shown again. A spent id stays spent. */
  free(id: string | string[]): void {
    together(this.#db, () => {
      for (const i of typeof id === 'string' ? [id] : id) this.#db.prepare('DELETE FROM credits WHERE id = ? AND spent = 0').run(i)
    })
  }

  /** Every id held now, with its note and when: what a service settles. */
  holds(): { id: string; note: string | null; at: number }[] {
    const rows = this.#db.prepare('SELECT id, note, at FROM credits WHERE spent = 0 ORDER BY at').all() as { id: string; note: string | null; at: number }[]
    return rows.map(({ id, note, at }) => ({ id, note, at }))
  }

  /** Closes its file, if it opened it. */
  close(): void {
    if (this.#own) this.#db.close()
  }
}

/** What a service sells and how: see `seller`. */
export type SellerConfig = {
  /** Its public origin, `https://host`: the name its credits' challenge carries, and that a ticket names. */
  origin: string
  key: CreditKey
  /** What one credit buys, in the service's own words. */
  unit: string
  /** Where a buy is collected, as its directory names it. */
  requestUri: string
  /** Where a credit is paid, in what, and one credit's price in whole units. */
  credit: { address: string; mint: string; price: string }
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets it takes, by address. */
  sponsors: string[]
  /** The Solana RPC a payment is checked through; null: none is checked. */
  rpc: Rpc | null
  /** Its one SQLite file, or ':memory:'. */
  path: string
}

/** A service's seller: see `seller`. */
export type Seller = {
  /** The seller's one file, open: the spent list, the proofs, the bill, and any table the service adds. */
  db: DatabaseSync
  spent: SpentList
  /** `work` in one transaction of the seller's file. */
  together<T>(work: () => T): T
  /** The directory to serve at DIRECTORY_PATH. */
  directory(): Record<string, unknown>
  /** A buy collected, with the payment header that came with it: its blind signatures, or a refusal. */
  collect(buy: Uint8Array, payment: string | undefined): Promise<Answer>
  /** How many credits each sponsor's tickets paid for. */
  bill(): Record<string, number>
  close(): void
}

/**
 * A service's seller of credits, in one SQLite file: its directory; each buy collected once a proof
 * pays for it, a Solana payment (`solana <signature>`) or a sponsor's ticket (`ticket <ticket>`),
 * in the PAYMENT_HEADER; the proofs it took, each for one buy's reference only; how many credits
 * each sponsor's tickets paid for (its bill, counted, never capped); and the spent list.
 */
export function seller(config: SellerConfig): Seller {
  for (const s of config.sponsors) if (!bytesOf(s, 'base58', 32)) throw new Error('a sponsor is a Solana address')
  const sponsors = new Set(config.sponsors)
  const db = new DatabaseSync(config.path)
  db.exec('CREATE TABLE IF NOT EXISTS proofs (proof TEXT PRIMARY KEY, reference TEXT NOT NULL) WITHOUT ROWID')
  db.exec('CREATE TABLE IF NOT EXISTS bill (sponsor TEXT PRIMARY KEY, credits INTEGER NOT NULL) WITHOUT ROWID')
  const spent = new SpentList(db)
  const { origin, key, credit, maxBuy, rpc } = config

  async function collect(buy: Uint8Array, payment: string | undefined): Promise<Answer> {
    let count: number
    try {
      count = countOf(buy)
    } catch {
      return refuse('not_a_buy')
    }
    if (count > maxBuy) return refuse('too_many', 400, `at most ${maxBuy} credits a buy`)
    const reference = await referenceOf(buy)
    const amount = amountOf(credit.price, count)
    const owed = `${amount} to ${credit.address} in ${credit.mint}, the transaction naming the buy's reference ${reference}, finalized; or a ticket from a sponsor this service takes`
    if (!payment?.trim()) return refuse('not_paid', 402, owed)
    const [kind, value = '', ...rest] = payment.trim().split(' ')
    let proof: string
    let sponsor: string | null = null
    if (kind === 'solana' && !rest.length && bytesOf(value, 'base58', 64)) {
      if (!rpc) return refuse('payment_check_unavailable', 503)
      let paid: boolean
      try {
        paid = await paysFor(rpc, value, { reference, address: credit.address, mint: credit.mint, amount })
      } catch {
        return refuse('payment_check_unavailable', 503)
      }
      if (!paid) return refuse('not_paid', 402, owed)
      proof = `solana ${value}`
    } else if (kind === 'ticket' && !rest.length && readTicket(value)) {
      const t = readTicket(value)!
      const signed = verify(null, ticketMessage(origin, reference, count), { key: Buffer.concat([ED25519_SPKI, t.key]), format: 'der', type: 'spki' }, t.signature)
      if (!sponsors.has(t.sponsor) || t.credits !== count || !signed) return refuse('not_paid', 402, owed)
      proof = `ticket ${t.sponsor} ${value.split('.')[2]}`
      sponsor = t.sponsor
    } else {
      return refuse('bad_payment', 400, 'the forest-payment header is `solana <signature>` or `ticket <ticket>`')
    }
    // A proof pays for one buy: taken by another, it is refused; for this one again, the same answer,
    // and the bill counts it once.
    const usedElsewhere = together(db, () => {
      const row = db.prepare('SELECT reference FROM proofs WHERE proof = ?').get(proof) as { reference: string } | undefined
      if (row) return row.reference !== reference
      db.prepare('INSERT INTO proofs (proof, reference) VALUES (?, ?)').run(proof, reference)
      if (sponsor) db.prepare('INSERT INTO bill (sponsor, credits) VALUES (?, ?) ON CONFLICT (sponsor) DO UPDATE SET credits = credits + excluded.credits').run(sponsor, count)
      return false
    })
    if (usedElsewhere) return refuse('proof_used', 409)
    return { status: 200, body: await answer(buy, key), type: 'application/private-token-generic-batch-response' }
  }

  return {
    db,
    spent,
    together: (work) => together(db, work),
    directory: () => directoryOf(config.requestUri, key.published, { unit: config.unit, ...credit }),
    collect,
    bill: () => Object.fromEntries((db.prepare('SELECT sponsor, credits FROM bill').all() as { sponsor: string; credits: number }[]).map((r) => [r.sponsor, r.credits])),
    close: () => db.close(),
  }
}

export { DIRECTORY_PATH, amountOf }
