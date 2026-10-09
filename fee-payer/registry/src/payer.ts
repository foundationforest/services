// The registry payer's front: the one program of ours in the registry payer, in front of its Kora,
// which pays for anything its rules allow and charges nothing. It sells credits, one registration
// each, and spends them, one per registry row.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price (forest's credits)
//   POST /credits/buy                                   a paid buy's blind signatures
//   POST /register                                      one row, paid with one credit
//   POST /  getPayerSigner                              its Kora's address, which a row names as payer
//   GET  /liveness                                      its Kora's
//
// A credit is spent only once its row lands. It is held from the moment it is shown; held, a second
// request with it is refused. If Kora refuses the row, it is freed at once. Once Kora sends the row,
// the front watches it: confirmed, the credit is spent; failed, or its blockhash past while it
// never landed, the credit is freed and can be shown again. A hold outlives a restart, with the
// signature and blockhash to settle it by. What it keeps is the spent list: credit ids, and for each
// held one that signature and blockhash. It logs nothing.

import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'

import { checkCredit, creditOf, referenceOf } from '../../../standard/credits/src/index.ts'
import { type CreditKey, DIRECTORY_PATH, SpentList, amountOf, answer, countOf, directoryOf, keyFrom, paid } from '../../../standard/credits/src/service.ts'
import { discriminator } from '../../../standard/registry/client/src/index.ts'

/** What one credit buys here, as the directory says it. */
export const UNIT = 'one registration'
/** Where a buy is collected. */
export const BUY_PATH = '/credits/buy'

export type Config = {
  /** Its Kora's JSON-RPC, in this container. */
  koraUrl: string
  /** The key its Kora asks for (`x-api-key`): made at each start, known only to this program and that Kora. */
  koraApiKey: string
  /** The registry program a row is written by. */
  registry: PublicKey
  /** Its public origin, `https://host`: the name its credits' challenge carries. */
  origin: string
  /** Its credit key, from `CREDIT_KEY`. */
  creditKey: CreditKey
  /** Where a credit is paid, in what, and one credit's price in whole units. */
  credit: { address: string; mint: string; price: string }
  /** The most credits one buy may ask for. */
  maxBuy: number
  /** The Solana RPC it finds payments and watches rows through. */
  rpcUrl: string
  /** The spent list's one file. */
  databasePath: string
  port: number
  /** How often it settles what it holds, in ms. */
  settleMs?: number
}

/** A request body larger than this is refused unread: a transaction is at most 1,232 bytes, and a buy of the most credits a little over 260 bytes each. */
const MAX_BODY = 64 * 1024
const REGISTER = discriminator('global', 'register')
/** An ed25519 public key's DER prefix, for node:crypto. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
/** A hold with no row sent yet (the process stopped between): freed once a blockhash can no longer be live, about 150 blocks. */
const STALE_HOLD_MS = 120_000

/** Reads the variables fee-payer/README.md lists. Fails naming every required one that is missing. */
export async function readConfig(env: Record<string, string | undefined> = process.env): Promise<Config> {
  const required = ['KORA_URL', 'KORA_API_KEY', 'REGISTRY_PROGRAM', 'PUBLIC_ORIGIN', 'CREDIT_KEY', 'CREDIT_ADDRESS', 'CREDIT_MINT', 'CREDIT_PRICE', 'RPC_URL']
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const whole = (name: string, fallback: string, min: number) => {
    const n = Number(env[name] || fallback)
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
    return n
  }
  const origin = env.PUBLIC_ORIGIN!.trim()
  if (new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN is an origin: https://host')
  let creditKey: CreditKey
  try {
    creditKey = await keyFrom(new Uint8Array(Buffer.from(env.CREDIT_KEY!.trim(), 'base64')))
  } catch {
    // The variable is a private key: nothing of it goes in the message.
    throw new Error('CREDIT_KEY is not an RSA-2048 private key in PKCS #8, base64')
  }
  delete env.CREDIT_KEY
  const price = env.CREDIT_PRICE!.trim()
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(price) || !/[1-9]/.test(price)) throw new Error('CREDIT_PRICE is decimal text above 0')
  return {
    koraUrl: env.KORA_URL!.trim(),
    koraApiKey: env.KORA_API_KEY!.trim(),
    registry: new PublicKey(env.REGISTRY_PROGRAM!.trim()),
    origin,
    creditKey,
    credit: { address: new PublicKey(env.CREDIT_ADDRESS!.trim()).toBase58(), mint: env.CREDIT_MINT!.trim() === 'SOL' ? 'SOL' : new PublicKey(env.CREDIT_MINT!.trim()).toBase58(), price },
    maxBuy: whole('CREDITS_PER_BUY', '10', 1),
    rpcUrl: env.RPC_URL!.trim(),
    databasePath: env.DATABASE_PATH || './data/credits.sqlite',
    port: whole('PORT', '8080', 0),
  }
}

/** The transaction's bytes, exactly: canonical base64 of one whole transaction and nothing after it. */
export function decodeTransaction(transaction: string): VersionedTransaction | null {
  try {
    const bytes = Buffer.from(transaction, 'base64')
    if (bytes.toString('base64') !== transaction) return null
    const tx = VersionedTransaction.deserialize(bytes)
    return Buffer.from(tx.serialize()).equals(bytes) ? tx : null
  } catch {
    return null
  }
}

/**
 * The main key the row is for, if the transaction is one `register` and nothing else: one top-level
 * instruction, to the registry, with `register`'s discriminator and its four accounts (the row, the
 * main key, the payer, System), no address lookup table, and no account the instruction does not
 * name. System appears only as `register`'s own account: a top-level System instruction beside it
 * could move the payer's SOL to the person (fee-payer/README.md, FAQ).
 */
export function registration(tx: VersionedTransaction, registry: PublicKey): number | null {
  const message = tx.message
  const keys = message.staticAccountKeys
  if (message.addressTableLookups.length !== 0 || message.compiledInstructions.length !== 1) return null
  const ix = message.compiledInstructions[0]!
  if (!keys[ix.programIdIndex]?.equals(registry)) return null
  if (ix.data.length < REGISTER.length || !REGISTER.every((b, i) => ix.data[i] === b)) return null
  if (ix.accountKeyIndexes.length !== 4 || !keys[ix.accountKeyIndexes[3]!]?.equals(SystemProgram.programId)) return null
  const named = new Set([...ix.accountKeyIndexes, ix.programIdIndex])
  if (keys.some((_, i) => !named.has(i))) return null
  return ix.accountKeyIndexes[1]!
}

/** Whether the key at this index signed the transaction's message. */
export function signedBy(tx: VersionedTransaction, index: number): boolean {
  if (index >= tx.message.header.numRequiredSignatures) return false
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, tx.message.staticAccountKeys[index]!.toBuffer()]), format: 'der', type: 'spki' })
  try {
    return verify(null, tx.message.serialize(), key, tx.signatures[index]!)
  } catch {
    return false
  }
}

/** A JSON-RPC call through `url`. Its errors never carry the URL, which may carry the RPC's key. */
export function rpcAt(url: string): (method: string, params: unknown[]) => Promise<unknown> {
  return async (method, params) => {
    let answer: { result?: unknown; error?: unknown }
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
      answer = (await res.json()) as typeof answer
    } catch {
      throw new Error('the RPC could not be reached')
    }
    if (answer.error !== undefined || !('result' in answer)) throw new Error(`the RPC refused ${method}`)
    return answer.result
  }
}

export type Refusal =
  | 'bad_request'
  | 'bad_transaction'
  | 'not_one_registration'
  | 'not_signed_by_main_key'
  | 'no_credit'
  | 'credit'
  | 'spent'
  | 'held'
  | 'fee_payer_refused'
  | 'not_a_buy'
  | 'too_many'
  | 'not_paid'
  | 'payment_check_unavailable'

type Answer = { status: number; body: unknown; type?: string }
const refuse = (error: Refusal, status = 400, detail?: string): Answer => ({ status, body: detail === undefined ? { error } : { error, detail } })

/** A note on a hold: the row's signature and the blockhash it was sent with, so a restart can settle it. */
const noteOf = (signature: string, blockhash: string) => `${signature} ${blockhash}`

/** The front's work, apart from HTTP: what each route answers. */
export class RegistryPayer {
  readonly spent: SpentList
  readonly #config: Config
  readonly #rpc: (method: string, params: unknown[]) => Promise<unknown>

  constructor(config: Config, rpc = rpcAt(config.rpcUrl)) {
    if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true })
    this.spent = new SpentList(config.databasePath)
    this.#config = config
    this.#rpc = rpc
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
    let signature: string | null
    try {
      signature = await paid(this.#rpc, { reference: await referenceOf(buy), address: credit.address, mint: credit.mint, amount: amountOf(credit.price, count) })
    } catch {
      return refuse('payment_check_unavailable', 503)
    }
    if (!signature) return refuse('not_paid', 402, `${amountOf(credit.price, count)} to ${credit.address}, naming the buy's reference, finalized`)
    return { status: 200, body: await answer(buy, this.#config.creditKey, this.#config.origin), type: 'application/private-token-generic-batch-response' }
  }

  /** One row, paid with the credit `authorization` shows: checked, held, sent through Kora, and watched until it lands or cannot. */
  async register(authorization: string | undefined, body: unknown): Promise<Answer> {
    const transaction = typeof body === 'object' && body !== null && Object.keys(body).length === 1 ? (body as { transaction?: unknown }).transaction : undefined
    if (typeof transaction !== 'string') return refuse('bad_request')
    const tx = decodeTransaction(transaction)
    if (!tx) return refuse('bad_transaction')
    const at = registration(tx, this.#config.registry)
    if (at === null) return refuse('not_one_registration')
    if (!signedBy(tx, at)) return refuse('not_signed_by_main_key')
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
    // Held in one statement, with nothing awaited since the check: two requests with one credit
    // cannot both get past here.
    const held = this.spent.hold(id)
    if (held === 'spent') return refuse('spent', 409)
    if (held === 'busy') return refuse('held', 409)
    let signature: string
    try {
      const res = await fetch(this.#config.koraUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.#config.koraApiKey },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signAndSendTransaction', params: { transaction } }),
      })
      const answered = (await res.json()) as { result?: { signature?: unknown }; error?: { message?: unknown } }
      if (typeof answered.result?.signature !== 'string') {
        this.spent.free(id)
        return refuse('fee_payer_refused', 502, String(answered.error?.message ?? `HTTP ${res.status}`))
      }
      signature = answered.result.signature
    } catch {
      this.spent.free(id)
      return refuse('fee_payer_refused', 502, 'the registry payer did not answer')
    }
    // The hold again, now with what settles it: no await between the two, so no request gets in.
    this.spent.free(id)
    this.spent.hold(id, noteOf(signature, tx.message.recentBlockhash))
    return { status: 200, body: { signature } }
  }

  /**
   * Settles what it holds: each row sent and confirmed, its credit spent; failed, or never landed
   * while its blockhash went past, its credit freed. A hold with no row sent, from before a restart,
   * is freed once it is older than any blockhash could live. One that cannot be checked now waits.
   */
  async settle(now: number = Date.now()): Promise<void> {
    for (const { id, note, at } of this.spent.holds()) {
      if (note === null) {
        if (now - at > STALE_HOLD_MS) this.spent.free(id)
        continue
      }
      const [signature, blockhash] = note.split(' ') as [string, string]
      try {
        const landed = await this.#status(signature)
        if (landed === 'landed') this.spent.land(id)
        else if (landed === 'failed') this.spent.free(id)
        else if (!((await this.#rpc('isBlockhashValid', [blockhash, { commitment: 'processed' }])) as { value: boolean }).value) {
          // Past its blockhash: it can no longer land, unless it did a moment ago. Ask once more.
          const last = await this.#status(signature)
          if (last === 'landed') this.spent.land(id)
          else this.spent.free(id)
        }
      } catch {
        // The RPC did not answer: the hold waits for the next round.
      }
    }
  }

  async #status(signature: string): Promise<'landed' | 'failed' | 'unknown'> {
    const { value } = (await this.#rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])) as { value: ({ err: unknown; confirmationStatus?: string } | null)[] }
    const status = value[0]
    if (!status) return 'unknown'
    if (status.err !== null) return 'failed'
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' ? 'landed' : 'unknown'
  }

  close(): void {
    this.spent.close()
  }
}

const CORS = { 'access-control-allow-origin': '*' }

function send(res: ServerResponse, status: number, body?: unknown, type = 'application/json'): void {
  if (body === undefined) {
    res.writeHead(status, CORS).end()
    return
  }
  res.writeHead(status, { ...CORS, 'content-type': type }).end(body instanceof Uint8Array ? body : JSON.stringify(body))
}

async function readBytes(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

const json = (bytes: Uint8Array | undefined): unknown => {
  if (!bytes) return undefined
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return undefined
  }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

/** A request to its Kora, its answer passed back unchanged. */
function toKora(res: ServerResponse, to: URL, method: string, path: string, headers: IncomingHttpHeaders, body?: Uint8Array): void {
  const upstream = request({ host: to.hostname, port: to.port, method, path, headers: { ...passed(headers), ...(body && { 'content-length': String(body.length) }) } }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
    answer.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  upstream.end(body)
}

/** Starts the front on `config.port`. */
export async function startFront(config: Config, rpc?: (method: string, params: unknown[]) => Promise<unknown>): Promise<{ url: string; payer: RegistryPayer; close: () => Promise<void> }> {
  const payer = new RegistryPayer(config, rpc)
  const kora = new URL(config.koraUrl)
  const server = createServer((req, res) => {
    // A URL no URL parser reads (`//`, `/\`) is refused here: thrown in this handler, it would stop
    // the process.
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      req.resume()
      return send(res, 400)
    }
    // Browsers ask first (OPTIONS).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' }).end()
      return
    }
    if (path === '/liveness' && req.method === 'GET') return toKora(res, kora, 'GET', '/liveness', {})
    if (path === DIRECTORY_PATH && req.method === 'GET') return send(res, 200, payer.directory(), 'application/private-token-issuer-directory')
    if (req.method !== 'POST' || ![BUY_PATH, '/register', '/'].includes(path)) {
      req.resume()
      return send(res, 404)
    }
    readBytes(req)
      .then(async (bytes) => {
        if (!bytes) return send(res, 413)
        if (path === BUY_PATH) {
          const answered = await payer.collect(bytes)
          return send(res, answered.status, answered.body, answered.type)
        }
        if (path === '/register') {
          const answered = await payer.register(req.headers.authorization, json(bytes))
          return send(res, answered.status, answered.body)
        }
        // At `/`, Kora's JSON-RPC for one method only: the address that pays, which a row names.
        const call = json(bytes) as { method?: unknown } | undefined
        if (call?.method !== 'getPayerSigner') return send(res, 404, { error: 'only getPayerSigner here' })
        return toKora(res, kora, 'POST', '/', { 'content-type': 'application/json', 'x-api-key': config.koraApiKey }, bytes)
      })
      .catch(() => send(res, 500))
  })
  await new Promise<void>((resolve) => server.listen(config.port, resolve))
  const timer = setInterval(() => void payer.settle(), config.settleMs ?? 3_000)
  timer.unref()
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    payer,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        server.close(() => {
          payer.close()
          resolve()
        })
        server.closeAllConnections()
      }),
  }
}
