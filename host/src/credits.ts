// The host's credits: it sells them (forest's credits, one cent of writes each), and a credit spent
// here goes into a folder's balance, which pays for that folder's writes.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price
//   POST /credits/buy                                   a paid buy's blind signatures
//   POST /credits/spend     { folder }                  one credit, shown in Authorization, into the folder's balance
//   GET  /credits/balance/<folder>                      { folder, credits }
//
// A write costs one credit a started megabyte (MiB) of it, one at the least: every record and every
// message costs one, and bytes one a megabyte. A record or message is paid from its own folder's
// balance (a message's, the sender's); bytes from the balance of a folder whose current records name
// them. Forest's host never asks about a hosts or permissions record, so those are free.
//
// A spend lands when the folder's balance holds the credit: the balance and a mark for the credit go
// in in one transaction, then the credit is spent. A start finds a credit held, after a stop between
// the two, and settles it by that mark. What it keeps: the spent list (credit ids) and each
// folder's balance; nothing ties a credit to a folder. It logs nothing.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { base58 } from '../../standard/records/src/index.ts'
import { checkCredit, creditOf, referenceOf } from '../../standard/credits/src/index.ts'
import { type CreditKey, type Rpc, DIRECTORY_PATH, SpentList, amountOf, answer, countOf, directoryOf, paid } from '../../standard/credits/src/service.ts'

export { DIRECTORY_PATH }

/** What one credit buys here, as the directory says it. */
export const UNIT = 'one cent of writes'
export const BUY_PATH = '/credits/buy'
export const SPEND_PATH = '/credits/spend'
export const BALANCE_PATH = '/credits/balance/'

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
  readonly spent: SpentList
  readonly #db: DatabaseSync
  readonly #config: CreditConfig
  readonly #rpc: Rpc

  /** In `dir` (credits.sqlite, the spent list, and balances.sqlite), or in memory when null. */
  constructor(dir: string | null, config: CreditConfig, rpc: Rpc) {
    if (dir) mkdirSync(dir, { recursive: true })
    this.spent = new SpentList(dir ? join(dir, 'credits.sqlite') : ':memory:')
    this.#db = new DatabaseSync(dir ? join(dir, 'balances.sqlite') : ':memory:')
    this.#db.exec('CREATE TABLE IF NOT EXISTS balances (folder TEXT PRIMARY KEY, credits INTEGER NOT NULL) WITHOUT ROWID')
    this.#db.exec('CREATE TABLE IF NOT EXISTS landing (id TEXT PRIMARY KEY) WITHOUT ROWID')
    this.#config = config
    this.#rpc = rpc
    // A credit still held was in a spend that stopped between holding it and spending it: spent if
    // its folder's balance took it, free again if not.
    for (const { id } of this.spent.holds()) {
      if (this.#db.prepare('SELECT 1 FROM landing WHERE id = ?').get(id)) this.spent.land(id)
      else this.spent.free(id)
      this.#db.prepare('DELETE FROM landing WHERE id = ?').run(id)
    }
  }

  directory(): Record<string, unknown> {
    const { credit, creditKey } = this.#config
    return directoryOf({ requestUri: BUY_PATH, keys: [{ key: creditKey.published }], credit: { unit: UNIT, ...credit } })
  }

  /** A buy, collected: its blind signatures once a finalized payment names it and pays for every credit it asks. */
  async collect(buy: Uint8Array): Promise<Answer> {
    let count: number
    try {
      count = countOf(buy)
    } catch {
      return refuse('not_a_buy')
    }
    if (count > this.#config.maxBuy) return refuse('too_many', 400, `at most ${this.#config.maxBuy} credits a buy`)
    const { credit } = this.#config
    const amount = amountOf(credit.price, count)
    let signature: string | null
    try {
      signature = await paid(this.#rpc, { reference: await referenceOf(buy), address: credit.address, mint: credit.mint, amount })
    } catch {
      return refuse('payment_check_unavailable', 503)
    }
    if (!signature) return refuse('not_paid', 402, `${amount} to ${credit.address}, naming the buy's reference, finalized`)
    return { status: 200, body: await answer(buy, this.#config.creditKey, this.#config.origin), type: 'application/private-token-generic-batch-response' }
  }

  /** One credit, shown in `authorization`, into the balance of the folder `body` names. */
  async spend(authorization: string | undefined, body: unknown): Promise<Answer> {
    const folder = typeof body === 'object' && body !== null && Object.keys(body).length === 1 ? (body as { folder?: unknown }).folder : undefined
    if (!isFolder(folder)) return refuse('bad_request')
    let credit: Uint8Array
    try {
      credit = creditOf(authorization ?? '')
    } catch {
      return refuse('no_credit', 401)
    }
    let id: string
    try {
      id = await checkCredit(credit, { origin: this.#config.origin, keys: [this.#config.creditKey.published] })
    } catch {
      return refuse('credit', 402)
    }
    // From here on, no wait: two requests with one credit cannot both get past the hold.
    const held = this.spent.hold(id)
    if (held === 'spent') return refuse('spent', 409)
    if (held === 'busy') return refuse('held', 409)
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare('INSERT INTO landing (id) VALUES (?)').run(id)
      this.#db.prepare('INSERT INTO balances (folder, credits) VALUES (?, 1) ON CONFLICT (folder) DO UPDATE SET credits = credits + 1').run(folder)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      this.spent.free(id)
      throw err
    }
    this.spent.land(id)
    this.#db.prepare('DELETE FROM landing WHERE id = ?').run(id)
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
    this.spent.close()
    this.#db.close()
  }
}
