// The pre-check: the one program of ours in the fee payer. It stands in front of the sponsored Kora,
// which pays for anything its rules allow and charges nothing, and lets through only a registry row
// that comes with a voucher it has not seen before.
//
// A voucher is a second proof from the same stamp on Soil's issuer's list, made under a label
// `sponsor/1`, `sponsor/2` or `sponsor/3`, for the main key that signs the row. Its market stamp is
// the same every time for one stamp and one label, so a stamp has three, and each is spent once. The
// proof names the main key, so a voucher seen in flight sponsors only that main key's row. The row
// itself may be under any issuer and any label.
//
// One request, POST /sponsor, checked in this order, each failure a named refusal; the voucher is
// spent the moment it is forwarded, whatever Kora answers. What it keeps is the used set: each spent
// voucher's market stamp, and nothing beside it. It logs nothing.

import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'

import { discriminator, issuerSigned, verifyStamp, type SnarkjsProof } from '../../../forest/registry/client/src/index.ts'

export type Config = {
  /** The sponsored Kora's JSON-RPC, on this container's loopback. */
  koraUrl: string
  /** The key Kora asks for (`x-api-key`): made at each start, known only to this program and Kora. */
  koraApiKey: string
  /** The issuer whose list vouchers are proven against: Soil's. */
  issuer: Uint8Array
  /** The registry program a row is written by. */
  registry: PublicKey
  /** The used set's one file. */
  databasePath: string
  port: number
}

/** The labels a voucher may be made under: three per stamp. */
export const VOUCHER_LABELS = ['sponsor/1', 'sponsor/2', 'sponsor/3']

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

/** Reads the variables fee-payer/README.md lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['KORA_URL', 'KORA_API_KEY', 'VOUCHER_ISSUER', 'REGISTRY_PROGRAM'].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const port = Number(env.PORT || '8080')
  if (!Number.isSafeInteger(port) || port < 0) throw new Error('PORT must be a whole number')
  return {
    koraUrl: env.KORA_URL!.trim(),
    koraApiKey: env.KORA_API_KEY!.trim(),
    issuer: new PublicKey(env.VOUCHER_ISSUER!.trim()).toBytes(),
    registry: new PublicKey(env.REGISTRY_PROGRAM!.trim()),
    databasePath: env.DATABASE_PATH || './data/sponsor.sqlite',
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

/** One POST /sponsor, from its parsed body to the answer. */
export async function sponsor(config: Config, used: UsedSet, body: unknown): Promise<Answer> {
  const request = readRequest(body)
  if (!request) return refuse('bad_request')
  const tx = decodeTransaction(request.transaction)
  if (!tx) return refuse('bad_transaction')
  const at = registration(tx, config.registry)
  if (at === null) return refuse('not_one_registration')
  if (!signedBy(tx, at)) return refuse('not_signed_by_main_key')
  const profile = tx.message.staticAccountKeys[at]!.toBytes()
  const { voucher } = request
  if (!VOUCHER_LABELS.includes(voucher.label)) return refuse('not_a_voucher_label')
  if (!issuerSigned({ issuer: config.issuer, root: voucher.root, issuerSignature: voucher.issuerSignature })) return refuse('not_signed_by_issuer')
  const holds = await verifyStamp({ proof: voucher.proof, root: voucher.root, marketStamp: voucher.marketStamp, label: voucher.label, profile })
  if (!holds) return refuse('voucher_does_not_hold')
  // Checked and spent in one statement, with nothing awaited since the proof: two copies of one
  // voucher cannot both get past here.
  if (!used.spend(voucher.marketStamp)) return refuse('voucher_used', 409)
  try {
    const res = await fetch(config.koraUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.koraApiKey },
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

/** Starts the pre-check on `config.port`. Browsers ask first (OPTIONS), as they do of Kora. */
export async function startSponsor(config: Config): Promise<{ url: string; close: () => Promise<void> }> {
  const used = new UsedSet(config.databasePath)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== '/sponsor') return send(res, 404)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }).end()
      return
    }
    if (req.method !== 'POST') return send(res, 405)
    readBody(req)
      .then((body) => sponsor(config, used, body))
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
