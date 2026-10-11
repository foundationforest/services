// The registry payer: one program, with its own key. It sells credits, one registration each, and
// spends them, one per registry row: it signs the row's transaction as payer and sends it itself.
//
//   GET  /.well-known/private-token-issuer-directory   its credit key and price (credits/)
//   POST /credits/buy                                   a paid buy's blind signatures
//   POST /register                                      one row, paid with one credit
//   POST /  getPayerSigner                              its address, which a row names as payer
//   GET  /liveness                                      200 while it runs
//
// A credit is spent only once its row exists on chain: one rule. Before anything is held, a row
// that already exists is refused. The credit is then held with the row's address and the
// blockhash; the payer signs; one simulation must pass, and fund nothing from the payer but the row's
// rent; then it sends. A settle loop, one round at a time, spends each held
// credit whose row exists, and frees each whose row is absent once its blockhash expired. What it
// keeps is its seller's file: credit ids, each held one's row and blockhash, the proofs it took
// and its sponsors' bill. It logs nothing.

import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'

import { PAYMENT_HEADER, checkCredit, creditOf } from '../../../credits/src/index.ts'
import { type CreditKey, DIRECTORY_PATH, type Rpc, type Seller, keyFrom, seller } from '../../../credits/src/service.ts'
import { discriminator, rowSpace } from '../../../standard/registry/client/src/index.ts'

/** What one credit buys here, as the directory says it. */
export const UNIT = 'one registration'
/** Where a buy is collected. */
export const BUY_PATH = '/credits/buy'

export type Config = {
  /** Its own key: it signs every row it pays for, and a row records it as payer. */
  key: Keypair
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
  /** The sponsors whose tickets pay for a buy here, by address. */
  sponsors: string[]
  /** The Solana RPC it checks payments and rows, and sends rows, through. */
  rpcUrl: string
  /** Its seller's one file. */
  databasePath: string
  port: number
  /** How long it waits after one settle round before the next, in ms. */
  settleMs?: number
}

/** A request body larger than this is refused unread: a transaction is at most 1,232 bytes, and a buy of the most credits a little over 260 bytes each. */
const MAX_BODY = 64 * 1024
const REGISTER = discriminator('global', 'register')
/** `register`'s data before the label: discriminator, stamp, issuer's key, tier, proof. Then the label's u32 length and its bytes. */
const BEFORE_LABEL = 8 + 32 + 64 + 32 + 32 + 64 + 32
const SYSTEM = SystemProgram.programId.toBase58()
/** An ed25519 public key's DER prefix, for node:crypto. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Its key, from FOREST_FEE_PAYER_KEY: the key itself as the Solana CLI's JSON array, or a path to that file outside this repo. */
function keyOf(value: string): Keypair {
  const text = value.trim()
  if (text.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text) as number[]))
  const path = resolve(text)
  if (path.startsWith(REPO + sep)) throw new Error('FOREST_FEE_PAYER_KEY is a file inside the repo')
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))
}

/** Reads the variables README.md lists. Fails naming every required one that is missing. */
export async function readConfig(env: Record<string, string | undefined> = process.env): Promise<Config> {
  const required = ['FOREST_FEE_PAYER_KEY', 'REGISTRY_PROGRAM', 'PUBLIC_ORIGIN', 'CREDIT_KEY', 'CREDIT_ADDRESS', 'CREDIT_MINT', 'CREDIT_PRICE', 'RPC_URL']
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const whole = (name: string, fallback: string, min: number) => {
    const n = Number(env[name] || fallback)
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
    return n
  }
  const origin = env.PUBLIC_ORIGIN!.trim()
  if (new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN is an origin: https://host')
  // Both variables are private keys: nothing of either goes in a message.
  let key: Keypair
  try {
    key = keyOf(env.FOREST_FEE_PAYER_KEY!)
  } catch {
    throw new Error('FOREST_FEE_PAYER_KEY is not a keypair: its JSON array, or a path to that file outside the repo')
  }
  let creditKey: CreditKey
  try {
    creditKey = await keyFrom(new Uint8Array(Buffer.from(env.CREDIT_KEY!.trim(), 'base64')))
  } catch {
    throw new Error('CREDIT_KEY is not an RSA-2048 private key in PKCS #8, base64')
  }
  delete env.FOREST_FEE_PAYER_KEY
  delete env.CREDIT_KEY
  const price = env.CREDIT_PRICE!.trim()
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(price) || !/[1-9]/.test(price)) throw new Error('CREDIT_PRICE is decimal text above 0')
  return {
    key,
    registry: new PublicKey(env.REGISTRY_PROGRAM!.trim()),
    origin,
    creditKey,
    credit: { address: new PublicKey(env.CREDIT_ADDRESS!.trim()).toBase58(), mint: env.CREDIT_MINT!.trim() === 'SOL' ? 'SOL' : new PublicKey(env.CREDIT_MINT!.trim()).toBase58(), price },
    maxBuy: whole('CREDITS_PER_BUY', '10', 1),
    sponsors: (env.SPONSORS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
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
 * The row's address, the main key's index and the label's length, if the transaction is one
 * `register` and nothing else, paid for by `payer`: one top-level instruction, to the registry, with
 * `register`'s discriminator, a whole label, and its four accounts (the row, the main key, the payer,
 * System); `payer` pays the fee and is the row's payer; no address lookup table, and no account the
 * instruction does not name. System appears only as `register`'s own account: a top-level System
 * instruction beside it could move the payer's SOL to the person (README.md, FAQ).
 */
export function registration(tx: VersionedTransaction, registry: PublicKey, payer: PublicKey): { row: PublicKey; mainKey: number; label: number } | null {
  const message = tx.message
  const keys = message.staticAccountKeys
  if (message.addressTableLookups.length !== 0 || message.compiledInstructions.length !== 1) return null
  const ix = message.compiledInstructions[0]!
  if (!keys[ix.programIdIndex]?.equals(registry)) return null
  if (ix.data.length < BEFORE_LABEL + 4 || !REGISTER.every((b, i) => ix.data[i] === b)) return null
  const label = Buffer.from(ix.data).readUInt32LE(BEFORE_LABEL)
  if (BEFORE_LABEL + 4 + label !== ix.data.length) return null
  const [row, mainKey, rowPayer, system] = ix.accountKeyIndexes
  if (ix.accountKeyIndexes.length !== 4 || !keys[system!]?.equals(SystemProgram.programId)) return null
  if (!keys[0]!.equals(payer) || !keys[rowPayer!]?.equals(payer)) return null
  const named = new Set([...ix.accountKeyIndexes, ix.programIdIndex])
  if (keys.some((_, i) => !named.has(i))) return null
  return { row: keys[row!]!, mainKey: mainKey!, label }
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
export function rpcAt(url: string): Rpc {
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
  | 'row_exists'
  | 'spent'
  | 'held'
  | 'row_refused'
  | 'over_cap'
  | 'not_sent'
  | 'rpc_unavailable'

type Answer = { status: number; body: unknown; type?: string }
const refuse = (error: Refusal, status = 400, detail?: string): Answer => ({ status, body: detail === undefined ? { error } : { error, detail } })

/** An instruction a simulation ran inside another, as the RPC returns it: System's, jsonParsed. */
type Inner = { instructions: { programId: string; parsed?: { type?: string; info?: { source?: string; lamports?: number } } }[] }

/**
 * What `payer` funds in a simulation, in lamports beyond the network fee: every System instruction
 * the transaction ran inside the registry whose source is the payer. A System instruction the RPC
 * did not parse counts as more than any cap.
 */
function funded(inner: Inner[] | null | undefined, payer: string): number {
  if (!inner) return Infinity
  let lamports = 0
  for (const ix of inner.flatMap((i) => i.instructions)) {
    if (ix.programId !== SYSTEM) continue
    if (!ix.parsed?.info) return Infinity
    if (ix.parsed.info.source === payer) lamports += ix.parsed.info.lamports ?? Infinity
  }
  return lamports
}

/** A note on a hold: the row's address and the blockhash it was sent with, what settles it. */
const noteOf = (row: PublicKey, blockhash: string) => `${row.toBase58()} ${blockhash}`
const isAddress = (text: string | undefined) => {
  try {
    return text !== undefined && new PublicKey(text).toBase58() === text
  } catch {
    return false
  }
}

/** The registry payer's work, apart from HTTP: what each route answers, and the settling. */
export class RegistryPayer {
  readonly seller: Seller
  readonly #config: Config
  readonly #rpc: Rpc

  constructor(config: Config, rpc: Rpc = rpcAt(config.rpcUrl)) {
    if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true })
    this.#config = config
    this.#rpc = rpc
    this.seller = seller({ origin: config.origin, key: config.creditKey, unit: UNIT, requestUri: BUY_PATH, credit: config.credit, maxBuy: config.maxBuy, sponsors: config.sponsors, rpc, path: config.databasePath })
  }

  get spent() {
    return this.seller.spent
  }

  /** One row, paid with the credit `authorization` shows: checked, held, signed, simulated and sent. */
  async register(authorization: string | undefined, body: unknown): Promise<Answer> {
    const transaction = typeof body === 'object' && body !== null && Object.keys(body).length === 1 ? (body as { transaction?: unknown }).transaction : undefined
    if (typeof transaction !== 'string') return refuse('bad_request')
    const tx = decodeTransaction(transaction)
    if (!tx) return refuse('bad_transaction')
    const payer = this.#config.key.publicKey
    const one = registration(tx, this.#config.registry, payer)
    if (!one) return refuse('not_one_registration')
    if (!signedBy(tx, one.mainKey)) return refuse('not_signed_by_main_key')
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
    // Before anything is held: the row must not exist yet; and its rent, for its size.
    let rent: number
    try {
      const { value } = (await this.#rpc('getAccountInfo', [one.row.toBase58(), { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])) as { value: unknown }
      if (value !== null) return refuse('row_exists', 409)
      rent = (await this.#rpc('getMinimumBalanceForRentExemption', [rowSpace(one.label)])) as number
    } catch {
      return refuse('rpc_unavailable', 503)
    }
    const held = this.spent.hold(id, noteOf(one.row, tx.message.recentBlockhash))
    if (held === 'spent') return refuse('spent', 409)
    if (held === 'busy') return refuse('held', 409)
    tx.sign([this.#config.key])
    const wire = Buffer.from(tx.serialize()).toString('base64')
    // One simulation: it must pass, and the payer may fund no more than the row's rent in it.
    try {
      const { value } = (await this.#rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed', innerInstructions: true }])) as { value: { err: unknown; innerInstructions?: Inner[] | null } }
      if (value.err !== null) {
        this.spent.free(id)
        return refuse('row_refused', 400, JSON.stringify(value.err))
      }
      if (funded(value.innerInstructions, payer.toBase58()) > rent) {
        this.spent.free(id)
        return refuse('over_cap', 400, `a row here costs the payer at most ${rent} lamports beyond the network fee`)
      }
    } catch {
      this.spent.free(id)
      return refuse('rpc_unavailable', 503)
    }
    let signature: string
    try {
      signature = (await this.#rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true }])) as string
    } catch {
      // It may have gone out: the hold stays, and settles by the one rule.
      return refuse('not_sent', 502, 'the RPC did not take the row; its credit is freed once its blockhash passes with no row')
    }
    return { status: 200, body: { signature } }
  }

  /**
   * Settles what it holds, by one rule: a held credit whose row exists is spent; one whose row is
   * absent once its blockhash expired is freed; the rest wait. A hold from before this rule, which
   * names no row, is freed. One that cannot be checked now waits.
   */
  async settle(): Promise<void> {
    for (const { id, note } of this.spent.holds()) {
      const [row, blockhash] = (note ?? '').split(' ')
      if (!isAddress(row) || !blockhash) {
        this.spent.free(id)
        continue
      }
      try {
        // The blockhash first: expired before the row is looked for, a row absent then never lands.
        const live = ((await this.#rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }])) as { value: boolean }).value
        const { value } = (await this.#rpc('getAccountInfo', [row, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])) as { value: unknown }
        if (value !== null) this.spent.land(id)
        else if (!live) this.spent.free(id)
      } catch {
        // The RPC did not answer: the hold waits for the next round.
      }
    }
  }

  close(): void {
    this.seller.close()
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

/** Starts the registry payer on `config.port`, and its settle loop. */
export async function startFront(config: Config, rpc?: Rpc): Promise<{ url: string; payer: RegistryPayer; close: () => Promise<void> }> {
  const payer = new RegistryPayer(config, rpc)
  const address = config.key.publicKey.toBase58()
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
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': `content-type, authorization, ${PAYMENT_HEADER}`, 'access-control-max-age': '86400' }).end()
      return
    }
    if (path === '/liveness' && req.method === 'GET') return send(res, 200)
    if (path === DIRECTORY_PATH && req.method === 'GET') return send(res, 200, payer.seller.directory(), 'application/private-token-issuer-directory')
    if (req.method !== 'POST' || ![BUY_PATH, '/register', '/'].includes(path)) {
      req.resume()
      return send(res, 404)
    }
    readBytes(req)
      .then(async (bytes) => {
        if (!bytes) return send(res, 413)
        if (path === BUY_PATH) {
          const answered = await payer.seller.collect(bytes, req.headers[PAYMENT_HEADER] as string | undefined)
          return send(res, answered.status, answered.body, answered.type)
        }
        if (path === '/register') {
          const answered = await payer.register(req.headers.authorization, json(bytes))
          return send(res, answered.status, answered.body)
        }
        // At `/`, one JSON-RPC method, as Kora names it: the address that pays, which a row names.
        const call = json(bytes) as { method?: unknown; id?: unknown } | undefined
        if (call?.method !== 'getPayerSigner') return send(res, 404, { error: 'only getPayerSigner here' })
        return send(res, 200, { jsonrpc: '2.0', id: call.id ?? null, result: { signer_address: address, payment_address: address } })
      })
      .catch(() => send(res, 500))
  })
  await new Promise<void>((resolve) => server.listen(config.port, resolve))
  // One settle round at a time: the next is scheduled only once the last has finished.
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let round: Promise<void> = Promise.resolve()
  const loop = () => {
    round = payer.settle().catch(() => {})
    void round.then(() => {
      if (!stopped) timer = setTimeout(loop, config.settleMs ?? 3_000).unref()
    })
  }
  timer = setTimeout(loop, config.settleMs ?? 3_000).unref()
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    payer,
    close: () =>
      new Promise<void>((resolve) => {
        stopped = true
        clearTimeout(timer)
        server.close(() => {
          void round.then(() => {
            payer.close()
            resolve()
          })
        })
        server.closeAllConnections()
      }),
  }
}
