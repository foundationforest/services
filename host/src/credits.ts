// The host's credits: it sells them (forest's credits, one cent of writes each), and a credit spent
// here goes into a folder's balance, which pays for that folder's writes.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price
//   POST /credits/buy                                   a paid buy's blind signatures
//   POST /credits/spend     { folder, credits }         up to 100 credits, together, into the folder's balance
//   GET  /credits/balance/<folder>                      { folder, credits }
//
// A write costs one credit a started megabyte (MiB) of it, one at the least: every record and every
// message costs one, and bytes one a megabyte. A record or message is paid from its own folder's
// balance (a message's, the sender's); bytes from the balance of a folder whose current records name
// them. Forest's host never asks about a hosts or permissions record, so those are free.
//
// A write costs exactly its price or nothing. A record or message is claimed once, by its id, in
// the same transaction that takes its price: a second copy in flight, or the same write sent again
// after a stop, costs nothing. Bytes are stored first and charged after: their price is reserved
// from the balance before forest stores them, taken once they are stored, released if they are not.
//
// One SQLite file, its seller's: the spent list, the proofs, the bill, each folder's balance and
// each write id it took a price for. A spend holds the credits, spends them and adds them to the
// balance in one transaction. Nothing ties a credit to a folder. It logs nothing.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { base58 } from '../../standard/records/src/index.ts'
import { checkCredits } from '../../standard/credits/src/index.ts'
import { type CreditKey, type Rpc, type Seller, DIRECTORY_PATH, type SpentList, seller } from '../../standard/credits/src/service.ts'

export { DIRECTORY_PATH }

/** What one credit buys here, as the directory says it. */
export const UNIT = 'one cent of writes'
export const BUY_PATH = '/credits/buy'
export const SPEND_PATH = '/credits/spend'
export const BALANCE_PATH = '/credits/balance/'
/** The most credits one spend may carry: a 500-credit gift fills a folder in five. */
export const SPEND_MAX = 100

const MIB = 1024 * 1024
/** What a write of `bytes` costs: one credit a started megabyte, one at the least. */
export const priceOf = (bytes: number): number => Math.max(1, Math.ceil(bytes / MIB))

export type CreditConfig = {
  /** Its public origin, `https://host`: the name its credits' challenge carries. */
  origin: string
  creditKey: CreditKey
  /** Where a credit is paid, in what, and one credit's price in whole units. */
  credit: { address: string; mint: string; price: string }
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets pay for a buy here, by address. */
  sponsors: string[]
}

export type Answer = { status: number; body: unknown; type?: string }
const refuse = (error: string, status = 400, detail?: string): Answer => ({ status, body: detail === undefined ? { error } : { error, detail } })

/** A folder's name: a main key's address, base58 of 32 bytes, as forest writes it. */
function isFolder(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const bytes = base58.decode(value)
    return bytes.length === 32 && base58.encode(bytes) === value
  } catch {
    return false
  }
}

export class Credits {
  readonly seller: Seller
  readonly spent: SpentList
  readonly #config: CreditConfig
  /** Credits reserved for bytes being stored now, by folder; and each blob's reservation, by its name. */
  readonly #reserved = new Map<string, number>()
  readonly #pending = new Map<string, { folder: string; price: number }>()

  /** In `dir`, credits.sqlite, its seller's one file; or in memory when null. With no RPC, no Solana payment is checked. */
  constructor(dir: string | null, config: CreditConfig, rpc: Rpc | null) {
    if (dir) mkdirSync(dir, { recursive: true })
    this.seller = seller({ origin: config.origin, key: config.creditKey, unit: UNIT, requestUri: BUY_PATH, credit: config.credit, maxBuy: config.maxBuy, sponsors: config.sponsors, rpc, path: dir ? join(dir, 'credits.sqlite') : ':memory:' })
    this.spent = this.seller.spent
    const db = this.seller.db
    db.exec('CREATE TABLE IF NOT EXISTS balances (folder TEXT PRIMARY KEY, credits INTEGER NOT NULL) WITHOUT ROWID')
    db.exec('CREATE TABLE IF NOT EXISTS paid (id BLOB PRIMARY KEY) WITHOUT ROWID')
    this.#config = config
    // The balances a host kept in a file of their own, before it kept one file: moved in, once. A
    // credit still held then was in a spend that stopped between its two files: spent if its mark is
    // there, free again if not.
    const old = dir && join(dir, 'balances.sqlite')
    if (old && existsSync(old)) {
      db.prepare('ATTACH DATABASE ? AS old').run(old)
      this.seller.together(() => {
        db.exec('INSERT INTO balances (folder, credits) SELECT folder, credits FROM old.balances WHERE true ON CONFLICT (folder) DO UPDATE SET credits = credits + excluded.credits')
        db.exec('DELETE FROM old.balances')
        for (const { id } of this.spent.holds()) {
          if (db.prepare('SELECT 1 FROM old.landing WHERE id = ?').get(id)) this.spent.land(id)
          else this.spent.free(id)
        }
      })
      db.exec('DETACH DATABASE old')
      for (const f of [old, `${old}-journal`, `${old}-wal`, `${old}-shm`]) rmSync(f, { force: true })
    }
  }

  directory(): Record<string, unknown> {
    return this.seller.directory()
  }

  /** Credits, as `{ folder, credits }` lists them (forest's `creditList`), into that folder's balance: all of them, or none. */
  async spend(body: unknown): Promise<Answer> {
    const shown = typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).sort().join() === 'credits,folder' ? (body as { folder: unknown; credits: unknown }) : undefined
    if (!shown || !isFolder(shown.folder)) return refuse('bad_request')
    const { folder, credits } = shown as { folder: string; credits: unknown }
    if (!Array.isArray(credits) || credits.length < 1 || credits.length > SPEND_MAX) return refuse('bad_request', 400, `from 1 to ${SPEND_MAX} credits`)
    let ids: string[]
    try {
      ids = await checkCredits(credits, { origin: this.#config.origin, keys: [this.#config.creditKey.published] }, SPEND_MAX)
    } catch (error) {
      // Forest's own words for what does not hold: no credit's bytes are in them.
      return refuse('credit', 402, (error as Error).message)
    }
    // Held, spent and in the balance in one transaction: all of it, or none.
    const held = this.seller.together(() => {
      const outcome = this.spent.hold(ids)
      if (outcome !== 'held') return outcome
      this.spent.land(ids)
      this.seller.db.prepare('INSERT INTO balances (folder, credits) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET credits = credits + excluded.credits').run(folder, ids.length)
      return outcome
    })
    if (held === 'spent') return refuse('spent', 409)
    if (held === 'busy') return refuse('held', 409)
    return { status: 200, body: { folder, credits: this.balance(folder) } }
  }

  /** The credits a folder holds here. */
  balance(folder: string): number {
    return (this.seller.db.prepare('SELECT credits FROM balances WHERE folder = ?').get(folder) as { credits: number } | undefined)?.credits ?? 0
  }

  /** What the folder holds that no bytes being stored have reserved. */
  #free(folder: string): number {
    return this.balance(folder) - (this.#reserved.get(folder) ?? 0)
  }

  #short(folder: string, price: number): string {
    return `this write costs ${price} credit${price === 1 ? '' : 's'}, and the folder holds ${this.#free(folder)} here; credits are sold at ${DIRECTORY_PATH}`
  }

  /**
   * A record's or message's price, from the folder's balance, claimed by the write's id (lowercase
   * hex) in the same transaction: null if it was paid, now or before, else what to tell the writer.
   */
  charge(folder: string, price: number, id: string): string | null {
    const db = this.seller.db
    return this.seller.together(() => {
      const write = Buffer.from(id, 'hex')
      if (db.prepare('SELECT 1 FROM paid WHERE id = ?').get(write)) return null
      const reserved = this.#reserved.get(folder) ?? 0
      if (db.prepare('UPDATE balances SET credits = credits - ? WHERE folder = ? AND credits - ? >= ?').run(price, folder, reserved, price).changes !== 1) return this.#short(folder, price)
      db.prepare('INSERT INTO paid (id) VALUES (?)').run(write)
      return null
    })
  }

  /** Reserves bytes' price on the first of `folders` that holds it, before they are stored: null if one did, else what to tell the writer. */
  reserve(name: string, folders: string[], price: number): string | null {
    const folder = folders.find((f) => this.#free(f) >= price)
    if (folder === undefined) return folders.length === 1 ? this.#short(folders[0]!, price) : `these bytes cost ${price} credits, and no folder whose records name them holds that many here`
    this.#reserved.set(folder, (this.#reserved.get(folder) ?? 0) + price)
    this.#pending.set(name, { folder, price })
    return null
  }

  /** The bytes named `name` were stored, or were not: their reserved price is taken, or released. Nothing if none was reserved. */
  stored(name: string, ok: boolean): void {
    const held = this.#pending.get(name)
    if (!held) return
    this.#pending.delete(name)
    const left = (this.#reserved.get(held.folder) ?? 0) - held.price
    if (left > 0) this.#reserved.set(held.folder, left)
    else this.#reserved.delete(held.folder)
    if (ok) this.seller.db.prepare('UPDATE balances SET credits = credits - ? WHERE folder = ? AND credits >= ?').run(held.price, held.folder, held.price)
  }

  /** The answer to a balance request: `{ folder, credits }`. */
  balanceOf(folder: string): Answer {
    return isFolder(folder) ? { status: 200, body: { folder, credits: this.balance(folder) } } : refuse('bad_request')
  }

  close(): void {
    this.seller.close()
  }
}
