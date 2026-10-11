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
// A spend lands when the folder's balance holds its credits: the balance and a mark for each credit
// go in in one transaction, then the credits are spent. A start finds credits held, after a stop
// between the two, and settles each by its mark. What it keeps: the spent list (credit ids) and each
// folder's balance; nothing ties a credit to a folder. It logs nothing.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  readonly #db: DatabaseSync
  readonly #config: CreditConfig

  /** In `dir` (credits.sqlite, its seller's file, and balances.sqlite), or in memory when null. With no RPC, no Solana payment is checked. */
  constructor(dir: string | null, config: CreditConfig, rpc: Rpc | null) {
    if (dir) mkdirSync(dir, { recursive: true })
    this.seller = seller({ origin: config.origin, key: config.creditKey, unit: UNIT, requestUri: BUY_PATH, credit: config.credit, maxBuy: config.maxBuy, sponsors: config.sponsors, rpc, path: dir ? join(dir, 'credits.sqlite') : ':memory:' })
    this.spent = this.seller.spent
    this.#db = new DatabaseSync(dir ? join(dir, 'balances.sqlite') : ':memory:')
    this.#db.exec('CREATE TABLE IF NOT EXISTS balances (folder TEXT PRIMARY KEY, credits INTEGER NOT NULL) WITHOUT ROWID')
    this.#db.exec('CREATE TABLE IF NOT EXISTS landing (id TEXT PRIMARY KEY) WITHOUT ROWID')
    this.#config = config
    // A credit still held was in a spend that stopped between holding it and spending it: spent if
    // its folder's balance took it, free again if not.
    for (const { id } of this.spent.holds()) {
      if (this.#db.prepare('SELECT 1 FROM landing WHERE id = ?').get(id)) this.spent.land(id)
      else this.spent.free(id)
      this.#db.prepare('DELETE FROM landing WHERE id = ?').run(id)
    }
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
    // From here on, no wait: two requests with one credit cannot both get past the hold.
    const held = this.spent.hold(ids)
    if (held === 'spent') return refuse('spent', 409)
    if (held === 'busy') return refuse('held', 409)
    this.#db.exec('BEGIN')
    try {
      for (const id of ids) this.#db.prepare('INSERT INTO landing (id) VALUES (?)').run(id)
      this.#db.prepare('INSERT INTO balances (folder, credits) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET credits = credits + excluded.credits').run(folder, ids.length)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      this.spent.free(ids)
      throw err
    }
    this.spent.land(ids)
    for (const id of ids) this.#db.prepare('DELETE FROM landing WHERE id = ?').run(id)
    return { status: 200, body: { folder, credits: this.balance(folder) } }
  }

  /** The credits a folder holds here. */
  balance(folder: string): number {
    return (this.#db.prepare('SELECT credits FROM balances WHERE folder = ?').get(folder) as { credits: number } | undefined)?.credits ?? 0
  }

  /** Takes `price` credits from the folder's balance: null if it held them, else what to tell the writer. */
  charge(folder: string, price: number): string | null {
    const taken = this.#db.prepare('UPDATE balances SET credits = credits - ? WHERE folder = ? AND credits >= ?').run(price, folder, price).changes === 1
    return taken ? null : `this write costs ${price} credit${price === 1 ? '' : 's'}, and the folder holds ${this.balance(folder)} here; credits are sold at ${DIRECTORY_PATH}`
  }

  /** The answer to a balance request: `{ folder, credits }`. */
  balanceOf(folder: string): Answer {
    return isFolder(folder) ? { status: 200, body: { folder, credits: this.balance(folder) } } : refuse('bad_request')
  }

  close(): void {
    this.seller.close()
    this.#db.close()
  }
}
