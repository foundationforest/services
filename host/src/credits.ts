// The host's credits: it sells them (credits/, one cent of writes each), and a credit spent here
// goes into a folder's balance, which pays for that folder's writes.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price, and what a write costs
//   POST /credits/buy                                   a paid buy's blind signatures
//   POST /credits/spend     { folder, credits }         up to 100 credits, together, into the folder's balance
//   GET  /credits/balance/<folder>                      { folder, credits }
//
// A write costs a floor (WRITE_PRICE) plus its bytes at a price a kilobyte (KILOBYTE_PRICE), both in
// credits, rounded up to a millionth of a credit: the unit a balance is kept in, so the fractions of a
// cent each write costs add up. A record or message is paid from its own folder's balance (a
// message's, the sender's); bytes from the balance of a folder whose current records name them.
// The standard's host never asks about a hosts or permissions record, so those are free.
//
// A write costs exactly its price or nothing. A record or message is claimed once, by its id, in
// the same transaction that takes its price: a second copy in flight, or the same write sent again
// after a stop, costs nothing. Bytes are stored first and charged after: their price is reserved
// from the balance before the standard's host stores them, taken once they are stored, released if they are not.
//
// One SQLite file, its seller's: the spent list, the proofs, the bill, each folder's balance in
// millionths of a credit and each write id it took a price for. A spend holds the credits, spends
// them and adds them to the balance in one transaction. Nothing ties a credit to a folder. It logs
// nothing.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { base58 } from '../../standard/records/src/index.ts'
import { checkCredits } from '../credits/credit.ts'
import { type CreditKey, type Rpc, type Seller, DIRECTORY_PATH, type SpentList, UNIT, seller } from '../credits/seller.ts'

export { DIRECTORY_PATH, UNIT }

export const BUY_PATH = '/credits/buy'
export const SPEND_PATH = '/credits/spend'
export const BALANCE_PATH = '/credits/balance/'
/** The most credits one spend may carry. */
export const SPEND_MAX = 100

/** A balance and a price are kept in millionths of a credit, so the fractions of a cent writes cost add up. */
export const MILLIONTHS = 1_000_000
/** A kilobyte, as the price a kilobyte counts it: 1,000 bytes. */
export const KILOBYTE = 1000

/** Credits as decimal text, such as `0.01`, at most six decimals, in millionths of a credit. Throws naming the setting. */
export function millionthsOf(name: string, text: string): number {
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,6}))?$/.exec(text.trim())
  if (!m) throw new Error(`${name} is credits as decimal text, at most six decimals, such as 0.01`)
  return Number(m[1]) * MILLIONTHS + Number((m[2] ?? '').padEnd(6, '0'))
}

/** Millionths of a credit as credits in decimal text: 10000 is `0.01`. */
export function creditsText(millionths: number): string {
  const part = String(millionths % MILLIONTHS).padStart(6, '0').replace(/0+$/, '')
  return `${Math.floor(millionths / MILLIONTHS)}${part ? `.${part}` : ''}`
}

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
  /** What a write costs, in credits as decimal text: `write` each, and `kilobyte` for each 1,000 bytes of it. */
  cost: { write: string; kilobyte: string }
}

export type Answer = { status: number; body: unknown; type?: string }
const refuse = (error: string, status = 400, detail?: string): Answer => ({ status, body: detail === undefined ? { error } : { error, detail } })

/** A folder's name: a main key's address, base58 of 32 bytes, as the standard writes it. */
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
  /** What a write costs, in millionths: each, and for each kilobyte. */
  readonly #cost: { write: number; kilobyte: number }
  /** Millionths reserved for bytes being stored now, by folder; and each blob's reservation, by its name. */
  readonly #reserved = new Map<string, number>()
  readonly #pending = new Map<string, { folder: string; price: number }>()

  /** In `dir`, credits.sqlite, its seller's one file; or in memory when null. With no RPC, no Solana payment is checked. */
  constructor(dir: string | null, config: CreditConfig, rpc: Rpc | null) {
    if (dir) mkdirSync(dir, { recursive: true })
    this.seller = seller({ origin: config.origin, key: config.creditKey, requestUri: BUY_PATH, credit: config.credit, maxBuy: config.maxBuy, sponsors: config.sponsors, rpc, path: dir ? join(dir, 'credits.sqlite') : ':memory:' })
    this.spent = this.seller.spent
    const db = this.seller.db
    db.exec('CREATE TABLE IF NOT EXISTS balances (folder TEXT PRIMARY KEY, millionths INTEGER NOT NULL) WITHOUT ROWID')
    db.exec('CREATE TABLE IF NOT EXISTS paid (id BLOB PRIMARY KEY) WITHOUT ROWID')
    this.#config = config
    this.#cost = { write: millionthsOf('WRITE_PRICE', config.cost.write), kilobyte: millionthsOf('KILOBYTE_PRICE', config.cost.kilobyte) }
    // Balances a host kept in whole credits, before writes cost fractions of one: counted in
    // millionths, once, in one transaction.
    if (db.prepare("SELECT 1 FROM pragma_table_info('balances') WHERE name = 'credits'").get()) {
      this.seller.together(() => {
        db.exec('ALTER TABLE balances RENAME COLUMN credits TO millionths')
        db.exec(`UPDATE balances SET millionths = millionths * ${MILLIONTHS}`)
      })
    }
    // The balances a host kept in a file of their own, before it kept one file: moved in, once. A
    // credit still held then was in a spend that stopped between its two files: spent if its mark is
    // there, free again if not.
    const old = dir && join(dir, 'balances.sqlite')
    if (old && existsSync(old)) {
      db.prepare('ATTACH DATABASE ? AS old').run(old)
      this.seller.together(() => {
        db.exec(`INSERT INTO balances (folder, millionths) SELECT folder, credits * ${MILLIONTHS} FROM old.balances WHERE true ON CONFLICT (folder) DO UPDATE SET millionths = millionths + excluded.millionths`)
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

  /** Its directory: its seller's, with what a write costs here in its `forest-credit` entry. */
  directory(): Record<string, unknown> {
    const directory = this.seller.directory() as { 'forest-credit': Record<string, unknown> }
    return { ...directory, 'forest-credit': { ...directory['forest-credit'], write: creditsText(this.#cost.write), kilobyte: creditsText(this.#cost.kilobyte) } }
  }

  /** What a write of `bytes` costs, in millionths: the floor, and the bytes at the price a kilobyte, rounded up. */
  priceOf(bytes: number): number {
    return this.#cost.write + Math.ceil((bytes * this.#cost.kilobyte) / KILOBYTE)
  }

  /** Credits, as `{ folder, credits }` lists them (the credits client's `creditList`, e2e/credits/), into that folder's balance: all of them, or none. */
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
      this.seller.db.prepare('INSERT INTO balances (folder, millionths) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET millionths = millionths + excluded.millionths').run(folder, ids.length * MILLIONTHS)
      return outcome
    })
    if (held === 'spent') return refuse('spent', 409)
    if (held === 'busy') return refuse('held', 409)
    return { status: 200, body: { folder, credits: this.balance(folder) } }
  }

  /** The credits a folder holds here: a number, with up to six decimals. */
  balance(folder: string): number {
    return this.#millionths(folder) / MILLIONTHS
  }

  #millionths(folder: string): number {
    return (this.seller.db.prepare('SELECT millionths FROM balances WHERE folder = ?').get(folder) as { millionths: number } | undefined)?.millionths ?? 0
  }

  /** What the folder holds that no bytes being stored have reserved, in millionths. */
  #free(folder: string): number {
    return this.#millionths(folder) - (this.#reserved.get(folder) ?? 0)
  }

  #short(folder: string, price: number): string {
    return `this write costs ${creditsText(price)} credit${price === MILLIONTHS ? '' : 's'}, and the folder holds ${creditsText(this.#free(folder))} here; credits are sold at ${DIRECTORY_PATH}`
  }

  /**
   * A record's or message's price, in millionths, from the folder's balance, claimed by the write's
   * id (lowercase hex) in the same transaction: null if it was paid, now or before, else what to tell
   * the writer.
   */
  charge(folder: string, price: number, id: string): string | null {
    const db = this.seller.db
    return this.seller.together(() => {
      const write = Buffer.from(id, 'hex')
      if (db.prepare('SELECT 1 FROM paid WHERE id = ?').get(write)) return null
      const reserved = this.#reserved.get(folder) ?? 0
      if (db.prepare('UPDATE balances SET millionths = millionths - ? WHERE folder = ? AND millionths - ? >= ?').run(price, folder, reserved, price).changes !== 1) return this.#short(folder, price)
      db.prepare('INSERT INTO paid (id) VALUES (?)').run(write)
      return null
    })
  }

  /** Reserves bytes' price, in millionths, on the first of `folders` that holds it, before they are stored: null if one did, else what to tell the writer. */
  reserve(name: string, folders: string[], price: number): string | null {
    const folder = folders.find((f) => this.#free(f) >= price)
    if (folder === undefined) return folders.length === 1 ? this.#short(folders[0]!, price) : `these bytes cost ${creditsText(price)} credits, and no folder whose records name them holds that much here`
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
    if (ok) this.seller.db.prepare('UPDATE balances SET millionths = millionths - ? WHERE folder = ? AND millionths >= ?').run(held.price, held.folder, held.price)
  }

  /** The answer to a balance request: `{ folder, credits }`. */
  balanceOf(folder: string): Answer {
    return isFolder(folder) ? { status: 200, body: { folder, credits: this.balance(folder) } } : refuse('bad_request')
  }

  close(): void {
    this.seller.close()
  }
}
