// The voucher check: the one program of ours in the fee payer, and its public front. It answers
// `POST /vouchers`, the voucher door: it lets through to the free Kora, which pays for anything its
// rules allow and charges nothing, only a registry row that comes with a voucher it has not seen
// before. Every other request it forwards, unchanged, to the at-cost Kora: the at-cost door.
//
// A voucher is a second proof from the same stamp on one of the lists it takes, made under a label
// `sponsor/1` to `sponsor/n` (forest's word for it), n that list's count (the foundation's face
// list 3, its ID list 10), for the main key that signs the row. Its market stamp is the same every
// time for one stamp and one label, so a stamp has n, and each is spent once. The proof names the
// main key, so a voucher seen in flight pays only for that main key's row. The row itself may be
// under any issuer and any label.
//
// Each `POST /vouchers` is checked in this order, each failure a named refusal; the voucher is
// spent the moment it is forwarded, whatever Kora answers. What it keeps is the used set: each
// spent voucher's market stamp, and nothing beside it. It logs nothing.

import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'

import { discriminator, issuerSigned, verifyStamp, type SnarkjsProof } from '../../../forest/registry/client/src/index.ts'

export type Config = {
  /** The free Kora's JSON-RPC, in this container. */
  freeKoraUrl: string
  /** The key the free Kora asks for (`x-api-key`): made at each start, known only to this program and that Kora. */
  freeKoraApiKey: string
  /** The at-cost Kora, in this container: every request but `/vouchers` goes to it, unchanged. */
  atCostKoraUrl: string
  /** The issuers whose lists vouchers are proven against, each with how many vouchers a stamp on it earns. */
  issuers: { issuer: Uint8Array; vouchers: number }[]
  /** The registry program a row is written by. */
  registry: PublicKey
  /** The used set's one file. */
  databasePath: string
  port: number
}

/** Whether a voucher may be made under `label` on a list whose stamps earn `count`: `sponsor/1` to `sponsor/<count>`. */
export function isVoucherLabel(label: string, count: number): boolean {
  const n = /^sponsor\/([1-9][0-9]{0,8})$/.exec(label)
  return n !== null && Number(n[1]) <= count
}

/** A request body larger than this is refused unread: a transaction is at most 1,232 bytes. */
const MAX_BODY = 16 * 1024
const REGISTER = discriminator('global', 'register')
/** An ed25519 public key's DER prefix, for node:crypto. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

export type Refusal =
  | 'bad_request'
  | 'bad_transaction'
  | 'not_one_registration'
  | 'not_signed_by_main_key'
  | 'not_a_voucher_label'
  | 'not_signed_by_issuer'
  | 'voucher_does_not_hold'
  | 'voucher_used'
  | 'fee_payer_refused'

export type Voucher = { proof: SnarkjsProof; root: Uint8Array; issuerSignature: Uint8Array; label: string; marketStamp: Uint8Array }

/**
 * `VOUCHER_ISSUERS`: `<address>:<count>` for each issuer, comma-separated, as `7zPD…:3,BVT1…:10`.
 * Each address once, each count a whole number above 0.
 */
export function readIssuers(text: string): Config['issuers'] {
  const issuers = text.split(',').map((entry) => {
    const [address, count, ...rest] = entry.trim().split(':')
    if (!address || rest.length || !/^[1-9][0-9]{0,8}$/.test(count ?? '')) {
      throw new Error('VOUCHER_ISSUERS must be <address>:<count>, comma-separated, each count a whole number above 0')
    }
    return { issuer: new PublicKey(address).toBytes(), vouchers: Number(count) }
  })
  if (new Set(issuers.map((i) => Buffer.from(i.issuer).toString('hex'))).size !== issuers.length) {
    throw new Error('VOUCHER_ISSUERS names an issuer twice')
  }
  return issuers
}

/** Reads the variables fee-payer/README.md lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['FREE_KORA_URL', 'FREE_KORA_API_KEY', 'AT_COST_KORA_URL', 'VOUCHER_ISSUERS', 'REGISTRY_PROGRAM'].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const port = Number(env.PORT || '8080')
  if (!Number.isSafeInteger(port) || port < 0) throw new Error('PORT must be a whole number')
  return {
    freeKoraUrl: env.FREE_KORA_URL!.trim(),
    freeKoraApiKey: env.FREE_KORA_API_KEY!.trim(),
    atCostKoraUrl: env.AT_COST_KORA_URL!.trim(),
    issuers: readIssuers(env.VOUCHER_ISSUERS!.trim()),
    registry: new PublicKey(env.REGISTRY_PROGRAM!.trim()),
    databasePath: env.DATABASE_PATH || './data/vouchers.sqlite',
    port,
  }
}

/**
 * The used set: each spent voucher's market stamp, in key order, with no time, no row number and no
 * main key, so the file says nothing about who spent which, or when.
 */
export class UsedSet {
  readonly #db: DatabaseSync
  readonly #spend: StatementSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS used (market_stamp BLOB PRIMARY KEY) WITHOUT ROWID;
    `)
    this.#spend = this.#db.prepare('INSERT OR IGNORE INTO used (market_stamp) VALUES (?)')
  }

  /** Spends a voucher: true if it was not spent before. Checking and spending are one statement. */
  spend(marketStamp: Uint8Array): boolean {
    return this.#spend.run(marketStamp).changes === 1
  }

  close(): void {
    this.#db.close()
  }
}

function hexBytes(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(value)) return null
  return new Uint8Array(Buffer.from(value, 'hex'))
}

/** The request's two parts, or null when either is not there in its shape. */
export function readRequest(body: unknown): { transaction: string; voucher: Voucher } | null {
  if (typeof body !== 'object' || body === null) return null
  const { transaction, voucher } = body as Record<string, unknown>
  if (typeof transaction !== 'string' || typeof voucher !== 'object' || voucher === null) return null
  const v = voucher as Record<string, unknown>
  const root = hexBytes(v.root, 32)
  const issuerSignature = hexBytes(v.issuerSignature, 64)
  const marketStamp = hexBytes(v.marketStamp, 32)
  if (!root || !issuerSignature || !marketStamp || typeof v.label !== 'string' || typeof v.proof !== 'object' || v.proof === null) return null
  return { transaction, voucher: { proof: v.proof as SnarkjsProof, root, issuerSignature, label: v.label, marketStamp } }
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
 * could move the fee payer's SOL to the person (fee-payer/README.md, FAQ).
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

type Answer = { status: number; body: { signature: string } | { error: Refusal; detail?: string } }
const refuse = (error: Refusal, status = 400, detail?: string): Answer => ({ status, body: detail === undefined ? { error } : { error, detail } })

/** One POST /vouchers, from its parsed body to the answer. */
export async function spendVoucher(config: Config, used: UsedSet, body: unknown): Promise<Answer> {
  const request = readRequest(body)
  if (!request) return refuse('bad_request')
  const tx = decodeTransaction(request.transaction)
  if (!tx) return refuse('bad_transaction')
  const at = registration(tx, config.registry)
  if (at === null) return refuse('not_one_registration')
  if (!signedBy(tx, at)) return refuse('not_signed_by_main_key')
  const profile = tx.message.staticAccountKeys[at]!.toBytes()
  const { voucher } = request
  // The list the voucher is from: the one whose issuer signed its root.
  const list = config.issuers.find(({ issuer }) => issuerSigned({ issuer, root: voucher.root, issuerSignature: voucher.issuerSignature }))
  if (!list) return refuse('not_signed_by_issuer')
  if (!isVoucherLabel(voucher.label, list.vouchers)) return refuse('not_a_voucher_label')
  const holds = await verifyStamp({ proof: voucher.proof, root: voucher.root, marketStamp: voucher.marketStamp, label: voucher.label, profile })
  if (!holds) return refuse('voucher_does_not_hold')
  // Checked and spent in one statement, with nothing awaited since the proof: two copies of one
  // voucher cannot both get past here.
  if (!used.spend(voucher.marketStamp)) return refuse('voucher_used', 409)
  try {
    const res = await fetch(config.freeKoraUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.freeKoraApiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signAndSendTransaction', params: { transaction: request.transaction } }),
    })
    const answer = (await res.json()) as { result?: { signature?: unknown }; error?: { message?: unknown } }
    if (typeof answer.result?.signature === 'string') return { status: 200, body: { signature: answer.result.signature } }
    return refuse('fee_payer_refused', 502, String(answer.error?.message ?? `HTTP ${res.status}`))
  } catch {
    return refuse('fee_payer_refused', 502, 'the fee payer did not answer')
  }
}

const CORS = { 'access-control-allow-origin': '*' }

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, CORS).end()
    return
  }
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding']
const passed = (headers: IncomingHttpHeaders) => {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

/** The at-cost door: the request, unchanged, to the at-cost Kora, and its answer, unchanged, back. */
function forward(req: IncomingMessage, res: ServerResponse, to: URL): void {
  const upstream = request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: passed(req.headers) }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, passed(answer.headers))
    answer.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(upstream)
}

/** Starts the front on `config.port`: the voucher door at `/vouchers`, the at-cost door everywhere else. */
export async function startFront(config: Config): Promise<{ url: string; close: () => Promise<void> }> {
  const used = new UsedSet(config.databasePath)
  const atCost = new URL(config.atCostKoraUrl)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== '/vouchers') return forward(req, res, atCost)
    // Browsers ask first (OPTIONS), as they do of Kora.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }).end()
      return
    }
    if (req.method !== 'POST') return send(res, 405)
    readBody(req)
      .then((body) => spendVoucher(config, used, body))
      .then((answer) => send(res, answer.status, answer.body))
      .catch(() => send(res, 500))
  })
  await new Promise<void>((resolve) => server.listen(config.port, resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          used.close()
          resolve()
        })
        server.closeAllConnections()
      }),
  }
}
