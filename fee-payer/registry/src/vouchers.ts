// The voucher check: the one program of ours in the fee payer, and its public front. It answers
// `POST /vouchers`, the voucher door: it lets through to the free Kora, which pays for anything its
// rules allow and charges nothing, only a registry row that comes with a voucher it has not seen
// before. Every other request it forwards, unchanged, to the at-cost Kora: the at-cost door.
//
// A voucher is a person proof (forest's registry, "The note and the person proof") from a note an
// issuer it trusts signed, made under the label `voucher/<this fee payer's name>/<n>`, n from 1 to
// that issuer's count for the note's tier (the foundation's: tier 1, 3; tier 2, 10), for the main key
// that signs the row. Its stamp is the same every time for one person, one issuer and one label, so a
// person has n, and each is spent once; the label names this fee payer, so two fee payers' vouchers
// are different stamps, and their used sets cannot be matched. The proof names the main key, so a
// voucher seen in flight pays only for that main key's row. The row itself may be under any issuer
// and any label.
//
// Each `POST /vouchers` is checked in this order, each failure a named refusal; the voucher is
// spent the moment it is forwarded, whatever Kora answers. What it keeps is the used set: each
// spent voucher's stamp, and nothing beside it. It logs nothing.

import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'

import { discriminator, fromBytes32, isFieldElement, verifyPerson, type IssuerKey, type SnarkjsProof } from '../../../standard/registry/client/src/index.ts'

export type Config = {
  /** The free Kora's JSON-RPC, in this container. */
  freeKoraUrl: string
  /** The key the free Kora asks for (`x-api-key`): made at each start, known only to this program and that Kora. */
  freeKoraApiKey: string
  /** The at-cost Kora, in this container: every request but `/vouchers` goes to it, unchanged. */
  atCostKoraUrl: string
  /** This fee payer's name: every voucher's label is `voucher/<name>/<n>`. */
  name: string
  /** The issuers whose notes vouchers are proven from, by key (128 hex), each tier with how many vouchers it earns. */
  issuers: { issuer: string; tier: bigint; vouchers: number }[]
  /** The registry program a row is written by. */
  registry: PublicKey
  /** The used set's one file. */
  databasePath: string
  port: number
}

/** Whether `label` is one of this fee payer's vouchers for a note that earns `count`: `voucher/<name>/1` to `voucher/<name>/<count>`. */
export function isVoucherLabel(label: string, name: string, count: number): boolean {
  const prefix = `voucher/${name}/`
  if (!label.startsWith(prefix)) return false
  const n = label.slice(prefix.length)
  return /^[1-9][0-9]{0,8}$/.test(n) && Number(n) <= count
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
  | 'not_a_trusted_issuer'
  | 'voucher_does_not_hold'
  | 'voucher_used'
  | 'fee_payer_refused'

export type Voucher = { proof: SnarkjsProof; issuer: IssuerKey; issuerHex: string; tier: bigint; label: string; stamp: Uint8Array }

/**
 * `VOUCHER_ISSUERS`: `<key>:<tier>:<count>` for each issuer and tier, comma-separated: the issuer's
 * key as 128 hex characters (x then y, as a row holds it), a tier, and how many vouchers a note at
 * that tier earns, as `2185…a549:1:3,2185…a549:2:10`. Each issuer and tier once, each tier and
 * count a whole number above 0.
 */
export function readIssuers(text: string): Config['issuers'] {
  const issuers = text.split(',').map((entry) => {
    const [issuer, tier, count, ...rest] = entry.trim().split(':')
    if (!/^[0-9a-f]{128}$/.test(issuer ?? '') || rest.length || !/^[1-9][0-9]{0,8}$/.test(tier ?? '') || !/^[1-9][0-9]{0,8}$/.test(count ?? '')) {
      throw new Error('VOUCHER_ISSUERS must be <key>:<tier>:<count>, comma-separated: a key as 128 lowercase hex, a tier and a count each a whole number above 0')
    }
    return { issuer: issuer!, tier: BigInt(tier!), vouchers: Number(count) }
  })
  if (new Set(issuers.map((i) => `${i.issuer}:${i.tier}`)).size !== issuers.length) {
    throw new Error('VOUCHER_ISSUERS names an issuer and tier twice')
  }
  return issuers
}

/** `FEE_PAYER_NAME`: text with no slash, so a voucher's label reads one way, and short enough for a label. */
function readName(text: string): string {
  if (text.includes('/') || Buffer.byteLength(text) > 100) throw new Error('FEE_PAYER_NAME must have no slash and be at most 100 bytes')
  return text
}

/** Reads the variables fee-payer/README.md lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ['FREE_KORA_URL', 'FREE_KORA_API_KEY', 'AT_COST_KORA_URL', 'FEE_PAYER_NAME', 'VOUCHER_ISSUERS', 'REGISTRY_PROGRAM'].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  const port = Number(env.PORT || '8080')
  if (!Number.isSafeInteger(port) || port < 0) throw new Error('PORT must be a whole number')
  return {
    freeKoraUrl: env.FREE_KORA_URL!.trim(),
    freeKoraApiKey: env.FREE_KORA_API_KEY!.trim(),
    atCostKoraUrl: env.AT_COST_KORA_URL!.trim(),
    name: readName(env.FEE_PAYER_NAME!.trim()),
    issuers: readIssuers(env.VOUCHER_ISSUERS!.trim()),
    registry: new PublicKey(env.REGISTRY_PROGRAM!.trim()),
    databasePath: env.DATABASE_PATH || './data/vouchers.sqlite',
    port,
  }
}

/**
 * The used set: each spent voucher's stamp, in key order, with no time, no row number and no main
 * key, so the file says nothing about who spent which, or when. A file from before notes names its
 * one column `market_stamp`, forest's word then; it is renamed.
 */
export class UsedSet {
  readonly #db: DatabaseSync
  readonly #spend: StatementSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS used (stamp BLOB PRIMARY KEY) WITHOUT ROWID;
    `)
    const columns = this.#db.prepare("SELECT name FROM pragma_table_info('used')").all().map((c) => c.name)
    if (columns.includes('market_stamp')) this.#db.exec('ALTER TABLE used RENAME COLUMN market_stamp TO stamp')
    this.#spend = this.#db.prepare('INSERT OR IGNORE INTO used (stamp) VALUES (?)')
  }

  /** Spends a voucher: true if it was not spent before. Checking and spending are one statement. */
  spend(stamp: Uint8Array): boolean {
    return this.#spend.run(stamp).changes === 1
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
  const issuer = typeof v.issuer === 'string' && /^[0-9a-f]{128}$/.test(v.issuer) ? hexBytes(v.issuer, 64) : null
  const stamp = hexBytes(v.stamp, 32)
  const tier = typeof v.tier === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v.tier) ? BigInt(v.tier) : null
  if (!issuer || !stamp || tier === null || !isFieldElement(tier) || typeof v.label !== 'string' || typeof v.proof !== 'object' || v.proof === null) return null
  const key: IssuerKey = [fromBytes32(issuer.subarray(0, 32)), fromBytes32(issuer.subarray(32))]
  return { transaction, voucher: { proof: v.proof as SnarkjsProof, issuer: key, issuerHex: v.issuer as string, tier, label: v.label, stamp } }
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
  // The issuer and tier the voucher says it is from, if this fee payer takes them.
  const earns = config.issuers.find(({ issuer, tier }) => issuer === voucher.issuerHex && tier === voucher.tier)
  if (!earns) return refuse('not_a_trusted_issuer')
  if (!isVoucherLabel(voucher.label, config.name, earns.vouchers)) return refuse('not_a_voucher_label')
  const holds = await verifyPerson({ proof: voucher.proof, issuer: voucher.issuer, label: voucher.label, profile, stamp: voucher.stamp, tier: voucher.tier })
  if (!holds) return refuse('voucher_does_not_hold')
  // Checked and spent in one statement, with nothing awaited since the proof: two copies of one
  // voucher cannot both get past here.
  if (!used.spend(voucher.stamp)) return refuse('voucher_used', 409)
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
    // A URL no URL parser reads (`//`, `/\`) is refused here: thrown in this handler, it would stop
    // the process.
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      req.resume()
      return send(res, 400)
    }
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
