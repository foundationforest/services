// The host's credits: it sells them (credits/), and a credit spent here goes into a folder's
// balance, which pays for that folder's writes.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price, and what a kilobyte costs
//   POST /credits/buy                                   a paid buy's blind signatures: paid by a sponsor's
//                                                       ticket, or from a folder's balance here
//   POST /credits/spend     { folder, credits }         up to 100 credits, together, into the folder's balance
//   GET  /credits/balance/<folder>                      { folder, credits }
//
// A write is priced by what it stores, counted as at least a kilobyte, at the rate of where it is
// kept: an entry or an inbox entry on the host's disk (ENTRY_PER_KB), a file's bytes in the bucket
// (FILE_PER_KB), both in credits, rounded up to a millionth of a credit: the unit a balance is kept
// in, so the fractions of a cent each write costs add up. A delete is free. A folder's first profile
// entry is a write like any other; a later profile entry is free (src/host.ts). An inbox entry
// carries one credit of its own: the host keeps its price, and the rest goes into the recipient
// folder's balance.
//
// An entry is claimed once, by its id, in the same transaction that takes its price: a second copy
// in flight, or the same one sent again, costs nothing. A file's bytes are stored first and charged
// after: their price is reserved from a balance before the plug stores them, taken once they are
// stored, released if they are not.
//
// One SQLite file, its seller's: the spent list, the buys paid for, the bill, each folder's balance
// in millionths of a credit and each entry's id it took a price for. A spend marks its credits spent
// and adds them to the balance in one transaction. Nothing ties a credit to a folder. It logs
// nothing.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { base58 } from '@scure/base'

import { PAYMENT_HEADER, SPEND_PATH, amountOf, checkCredit, checkCredits } from '../credits/credit.ts'
import { type Answer, type CreditKey, DIRECTORY_PATH, type Seller, type SpentList, UNIT, refuse, seller } from '../credits/seller.ts'

export { type Answer, DIRECTORY_PATH, SPEND_PATH, UNIT }

export const BUY_PATH = '/credits/buy'
export const BALANCE_PATH = '/credits/balance/'
/** The most credits one spend may carry. */
export const SPEND_MAX = 100

/** A balance and a price are kept in millionths of a credit, so the fractions of a cent writes cost add up. */
export const MILLIONTHS = 1_000_000
/** A kilobyte, as a price counts it: 1,000 bytes, and the least a write is counted as. */
export const KILOBYTE = 1000

/** Credits as decimal text, such as `0.003`, at most six decimals, in millionths of a credit. Throws naming the setting. */
export function millionthsOf(name: string, text: string): number {
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,6}))?$/.exec(text.trim())
  if (!m) throw new Error(`${name} is credits as decimal text, at most six decimals, such as 0.003`)
  return Number(m[1]) * MILLIONTHS + Number((m[2] ?? '').padEnd(6, '0'))
}

/** Millionths of a credit as credits in decimal text: 3000 is `0.003`. */
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
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The sponsors whose tickets pay for a buy here, by address. */
  sponsors: string[]
  /** What a kilobyte costs, in credits as decimal text: `entry` on the disk, `file` in the bucket. */
  rates: { entry: string; file: string }
  /** Whether `key` may pay for a buy from `folder`'s balance: its main key, or an access key its profile entry here lists with message. */
  keyCounts(folder: string, key: string): boolean
}

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

const plural = (millionths: number) => `${creditsText(millionths)} credit${millionths === MILLIONTHS ? '' : 's'}`

export class Credits {
  readonly seller: Seller
  readonly spent: SpentList
  readonly #config: CreditConfig
  /** What a kilobyte costs, in millionths: on the disk, and in the bucket. */
  readonly #rates: { entry: number; file: number }
  /** Millionths reserved for bytes being stored now, by folder; and each reservation, by the bytes' name. */
  readonly #reserved = new Map<string, number>()
  readonly #pending = new Map<string, { folder: string; price: number }>()

  /** In `dir`, credits.sqlite, its seller's one file. */
  constructor(dir: string, config: CreditConfig) {
    mkdirSync(dir, { recursive: true })
    const price = amountOf('0.01', config.priceCents)
    const balance = { counts: config.keyCounts, take: (folder: string, credits: number) => this.#take(folder, credits * MILLIONTHS) }
    this.seller = seller({ origin: config.origin, key: config.creditKey, requestUri: BUY_PATH, price, maxBuy: config.maxBuy, sponsors: config.sponsors, path: join(dir, 'credits.sqlite'), balance })
    this.spent = this.seller.spent
    const db = this.seller.db
    db.exec('CREATE TABLE IF NOT EXISTS balances (folder TEXT PRIMARY KEY, millionths INTEGER NOT NULL) WITHOUT ROWID')
    db.exec('CREATE TABLE IF NOT EXISTS paid (id BLOB PRIMARY KEY) WITHOUT ROWID')
    this.#config = config
    this.#rates = { entry: millionthsOf('ENTRY_PER_KB', config.rates.entry), file: millionthsOf('FILE_PER_KB', config.rates.file) }
  }

  /** Its directory: its seller's, with what a kilobyte costs here, on the disk and in the bucket, in its `forest-credit` entry. */
  directory(): Record<string, unknown> {
    const directory = this.seller.directory() as { 'forest-credit': Record<string, unknown> }
    return { ...directory, 'forest-credit': { ...directory['forest-credit'], entry: creditsText(this.#rates.entry), file: creditsText(this.#rates.file) } }
  }

  /** What an entry or an inbox entry of `bytes` costs, in millionths: kept on the disk, counted as at least a kilobyte, rounded up. */
  entryPrice(bytes: number): number {
    return Math.ceil((Math.max(bytes, KILOBYTE) * this.#rates.entry) / KILOBYTE)
  }

  /** What a file of `bytes` costs, in millionths: kept in the bucket, counted as at least a kilobyte, rounded up. */
  filePrice(bytes: number): number {
    return Math.ceil((Math.max(bytes, KILOBYTE) * this.#rates.file) / KILOBYTE)
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

  #short(folder: string, price: number, what = 'this write'): string {
    return `${what} costs ${plural(price)}, and the folder holds ${creditsText(this.#free(folder))} here; credits are sold at ${DIRECTORY_PATH}`
  }

  /** `price`, in millionths, taken from what the folder holds that nothing in flight has reserved: false, and nothing taken, if it holds less. */
  #takes(folder: string, price: number): boolean {
    const reserved = this.#reserved.get(folder) ?? 0
    return this.seller.db.prepare('UPDATE balances SET millionths = millionths - ? WHERE folder = ? AND millionths - ? >= ?').run(price, folder, reserved, price).changes === 1
  }

  /** A buy's price, in millionths, from the folder's balance, inside the buy's transaction: null when taken, else why not. */
  #take(folder: string, price: number): string | null {
    return this.#takes(folder, price) ? null : this.#short(folder, price, 'this buy')
  }

  /**
   * An inbox entry's credit, shown as its line's in the request's payment: checked, then, in one
   * transaction, marked spent, and all of it but the entry's `price`, in millionths, put into the
   * recipient folder's balance. Null when it was, else what to tell the sender. The credit says
   * nothing about who paid for it.
   */
  async inbox(to: string, credit: string | undefined, price: number): Promise<string | null> {
    if (credit === undefined) return `an inbox entry here carries one credit, in the ${PAYMENT_HEADER} header as \`credits <credit> …\`, one for each line in order; credits are sold at ${DIRECTORY_PATH}`
    let id: string
    try {
      id = await checkCredit(credit, { origin: this.#config.origin, keys: [this.#config.creditKey.published] })
    } catch (error) {
      return `the credit for this inbox entry does not hold: ${(error as Error).message}`
    }
    // Never below none: at a rate where an inbox entry costs more than its credit, the recipient gets nothing.
    const rest = Math.max(0, MILLIONTHS - price)
    const landed = this.seller.together(() => {
      if (!this.spent.spend([id])) return false
      this.seller.db.prepare('INSERT INTO balances (folder, millionths) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET millionths = millionths + excluded.millionths').run(to, rest)
      return true
    })
    return landed ? null : 'the credit for this inbox entry was spent already'
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
      if (!this.#takes(folder, price)) return this.#short(folder, price)
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
