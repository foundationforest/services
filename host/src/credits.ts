// The host's credits: it sells them (credits/), and a credit spent here goes into a folder's
// balance, which pays for that folder's writes.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price, and what a write costs
//   POST /credits/buy                                   a paid buy's blind signatures
//   POST /credits/spend     { folder, credits }         up to 100 credits, together, into the folder's balance
//   GET  /credits/balance/<folder>                      { folder, credits }
//
// A write costs a floor (WRITE_FLOOR) plus what it stores at a price a kilobyte (PER_KB), both in
// credits, rounded up to a millionth of a credit: the unit a balance is kept in, so the fractions of
// a cent each write costs add up. A write is an entry or a file's bytes. A delete costs the floor. A
// folder's first profile entry is a write like any other; a later profile entry and inbox entries
// are free (src/host.ts).
//
// An entry is claimed once, by its id, in the same transaction that takes its price: a second copy
// in flight, or the same one sent again, costs nothing. A file's bytes are stored first and charged
// after: their price is reserved from a balance before the plug stores them, taken once they are
// stored, released if they are not.
//
// One SQLite file, its seller's: the spent list, the proofs, the bill, each folder's balance in
// millionths of a credit and each entry's id it took a price for. A spend marks its credits spent
// and adds them to the balance in one transaction. Nothing ties a credit to a folder. It logs
// nothing.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { base58 } from '@scure/base'

import { amountOf, checkCredits } from '../credits/credit.ts'
import { type CreditKey, DIRECTORY_PATH, type Payment, type Seller, type SpentList, UNIT, seller } from '../credits/seller.ts'

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
  /** One credit's price, in US cents: at face value, `cents / 100` of a dollar. */
  priceCents: number
  /** Where a credit is paid on Solana; null: only tickets buy. */
  payment: Payment | null
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets pay for a buy here, by address. */
  sponsors: string[]
  /** What a write costs, in credits as decimal text: `floor` each, and `perKb` for each 1,000 bytes it stores. */
  cost: { floor: string; perKb: string }
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
  /** What a write costs, in millionths: the floor, and each kilobyte. */
  readonly #cost: { floor: number; perKb: number }
  /** Millionths reserved for bytes being stored now, by folder; and each reservation, by the bytes' name. */
  readonly #reserved = new Map<string, number>()
  readonly #pending = new Map<string, { folder: string; price: number }>()

  /** In `dir`, credits.sqlite, its seller's one file. */
  constructor(dir: string, config: CreditConfig) {
    mkdirSync(dir, { recursive: true })
    const price = amountOf('0.01', config.priceCents)
    this.seller = seller({ origin: config.origin, key: config.creditKey, requestUri: BUY_PATH, price, payment: config.payment, maxBuy: config.maxBuy, sponsors: config.sponsors, path: join(dir, 'credits.sqlite') })
    this.spent = this.seller.spent
    const db = this.seller.db
    db.exec('CREATE TABLE IF NOT EXISTS balances (folder TEXT PRIMARY KEY, millionths INTEGER NOT NULL) WITHOUT ROWID')
    db.exec('CREATE TABLE IF NOT EXISTS paid (id BLOB PRIMARY KEY) WITHOUT ROWID')
    this.#config = config
    this.#cost = { floor: millionthsOf('WRITE_FLOOR', config.cost.floor), perKb: millionthsOf('PER_KB', config.cost.perKb) }
  }

  /** Its directory: its seller's, with what a write costs here in its `forest-credit` entry. */
  directory(): Record<string, unknown> {
    const directory = this.seller.directory() as { 'forest-credit': Record<string, unknown> }
    return { ...directory, 'forest-credit': { ...directory['forest-credit'], write: creditsText(this.#cost.floor), kilobyte: creditsText(this.#cost.perKb) } }
  }

  /** What a delete costs, in millionths: the floor. */
  get floor(): number {
    return this.#cost.floor
  }

  /** What a write that stores `bytes` costs, in millionths: the floor, and the bytes at the price a kilobyte, rounded up. */
  priceOf(bytes: number): number {
    return this.#cost.floor + Math.ceil((bytes * this.#cost.perKb) / KILOBYTE)
  }

  /** Credits, as `{ folder, credits }` lists them, each base64url, into that folder's balance: all of them, or none. */
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
    // Spent and in the balance in one transaction: all of it, or none.
    const landed = this.seller.together(() => {
      if (!this.spent.spend(ids)) return false
      this.seller.db.prepare('INSERT INTO balances (folder, millionths) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET millionths = millionths + excluded.millionths').run(folder, ids.length * MILLIONTHS)
      return true
    })
    if (!landed) return refuse('spent', 409)
    return { status: 200, body: { folder, credits: this.balance(folder) } }
  }

  /** The credits a folder holds here: a number, with up to six decimals. */
  balance(folder: string): number {
    return this.#millionths(folder) / MILLIONTHS
  }

  #millionths(folder: string): number {
    return (this.seller.db.prepare('SELECT millionths FROM balances WHERE folder = ?').get(folder) as { millionths: number } | undefined)?.millionths ?? 0
  }

  /** What the folder holds that nothing in flight has reserved, in millionths. */
  #free(folder: string): number {
    return this.#millionths(folder) - (this.#reserved.get(folder) ?? 0)
  }

  #short(folder: string, price: number): string {
    return `this write costs ${creditsText(price)} credit${price === MILLIONTHS ? '' : 's'}, and the folder holds ${creditsText(this.#free(folder))} here; credits are sold at ${DIRECTORY_PATH}`
  }

  /**
   * An entry's price, in millionths, from the folder's balance, claimed by its id
   * (lowercase hex) in the same transaction: null if it was paid, now or before, else what to tell
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

  /** Reserves `price`, in millionths, on `folder` for the bytes named `name`, before they are stored: null if the folder holds it, else what to tell the writer. */
  reserve(name: string, folder: string, price: number): string | null {
    if (this.#free(folder) < price) return this.#short(folder, price)
    this.#reserved.set(folder, (this.#reserved.get(folder) ?? 0) + price)
    this.#pending.set(name, { folder, price })
    return null
  }

  /** The bytes named `name` were stored, or were not: their reserved price is taken, or released. Nothing if none was reserved. */
  settle(name: string, done: boolean): void {
    const held = this.#pending.get(name)
    if (!held) return
    this.#pending.delete(name)
    const left = (this.#reserved.get(held.folder) ?? 0) - held.price
    if (left > 0) this.#reserved.set(held.folder, left)
    else this.#reserved.delete(held.folder)
    if (done) this.seller.db.prepare('UPDATE balances SET millionths = millionths - ? WHERE folder = ? AND millionths >= ?').run(held.price, held.folder, held.price)
  }

  /** The answer to a balance request: `{ folder, credits }`. */
  balanceOf(folder: string): Answer {
    return isFolder(folder) ? { status: 200, body: { folder, credits: this.balance(folder) } } : refuse('bad_request')
  }

  close(): void {
    this.seller.close()
  }
}
