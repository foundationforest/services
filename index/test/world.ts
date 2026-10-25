// A small Forest on loopback for the tests: the standard's reference host, a stand-in verifier whose
// key the test's lists name, people with seeds, profiles with real stamp proofs made from the stamp
// circuit's committed proving files, records signed with their main keys, a stand-in Solana RPC,
// and the index itself, with lists written to a directory of its own.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mainKey, type MainKey, type PayAddresses, payAddresses, seedScalar } from '@foundationforest/keys'
import { b64u, hex, hostsRecord, ownerRecord, publish, type SignedRecord } from '@foundationforest/records'
import { Host } from '@foundationforest/records/host'
import { proofBytes, proveStamp, signStamp, stampNumberOf, toBytes32, verifierKeyOf } from '@foundationforest/stamp'

import { ESCROW_CHAIN } from '../src/chain.ts'
import { type Index, ROOT, startIndex } from '../src/index.ts'

export const STANDARD = join(ROOT, '../standard')
export const MARKETS = join(ROOT, '../markets')
// The stamp circuit's files keep the names they were set up with.
export const STAMP_FILES = { wasm: join(STANDARD, 'proofs/stamp/circuit/setup/note.wasm'), zkey: join(STANDARD, 'proofs/stamp/circuit/setup/note.zkey') }
export const REPUTATION_FILES = {
  wasm: join(STANDARD, 'proofs/reputation/circuit/setup/reputation.wasm'),
  zkey: join(STANDARD, 'proofs/reputation/circuit/setup/reputation.zkey'),
}

export const tmp = (name: string) => mkdtempSync(join(tmpdir(), `index-${name}-`))

/** The chain the tests' evidence names: the one the escrow runs on, which the test lists read. */
export const CHAIN = ESCROW_CHAIN

/** A verifier: a name and a key that signs stamps. */
export type Verifier = { name: string; privateKey: Uint8Array; key: string }
export function verifier(name = 'verifier.test.example'): Verifier {
  const privateKey = new Uint8Array(randomBytes(32))
  return { name, privateKey, key: verifierKeyOf(privateKey) }
}

/** A stamp proof as a profile record carries it. */
export type ProofField = { circuit: 'stamp'; verifier: string; verifierName: string; label: string; tag: string; proof: string }

/** A person's profile under one label: its main key, its pay addresses, and stamp proofs from each verifier given. */
export type Profile = { seed: Uint8Array<ArrayBuffer>; label: string; key: MainKey; pay: PayAddresses; proofs: ProofField[] }

/** A stamp from `by` for this seed, and its proof for `label` (about a second each). */
export async function stampProof(seed: Uint8Array<ArrayBuffer>, label: string, by: Verifier): Promise<ProofField> {
  const scalar = await seedScalar(seed)
  const stamp = signStamp(by.privateKey, { stampNumber: stampNumberOf(scalar, by.name), facts: 1n })
  const r = await proveStamp({ seedScalar: scalar, verifierName: by.name, stamp, label, artifacts: STAMP_FILES })
  return { circuit: 'stamp', verifier: r.verifier, verifierName: by.name, label, tag: hex.encode(toBytes32(r.tag)), proof: b64u.encode(proofBytes(r.proof)) }
}

export async function profile(label: string, by: Verifier[] = [], seed = new Uint8Array(randomBytes(32))): Promise<Profile> {
  const proofs = []
  for (const v of by) proofs.push(await stampProof(seed, label, v))
  return { seed, label, key: await mainKey(seed, label), pay: await payAddresses(seed, label), proofs }
}

/** The profile record a profile shows: its market, role, pay addresses and proofs, and anything more. */
export function profileBody(p: Profile, more: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  const [market, role] = p.label.split('/')
  return { market, role, pay: p.pay, proofs: p.proofs, ...more }
}

let clock = Date.now()
/** A record time later than every one before, so a newer record always wins. */
export const later = () => (clock = Math.max(clock + 1, Date.now()))

/** The standard's reference host on loopback. */
export async function startHost(): Promise<{ url: string; close(): Promise<void> }> {
  const host = new Host()
  const url = await host.listen(0, '127.0.0.1')
  return { url, close: () => host.close() }
}

/** Sign and post records to the host: each one's owner record at its path. */
export async function post(hostUrl: string, records: SignedRecord[]): Promise<void> {
  const [out] = await publish([hostUrl], records)
  const refused = out!.results.filter((r) => !r.ok)
  if (out!.status !== 200 || refused.length) throw new Error(`the host refused: ${JSON.stringify(out)}`)
}

/** A profile's hosts record and profile record, posted. */
export async function publishProfile(hostUrl: string, p: Profile, more: { [key: string]: unknown } = {}): Promise<void> {
  await post(hostUrl, [hostsRecord(p.key, [hostUrl], later()), ownerRecord(p.key, 'profile', profileBody(p, more) as never, later())])
}

export const at = (p: Profile, path: string, body: { [key: string]: unknown } | null) => ownerRecord(p.key, path, body as never, later())

/** A stand-in Solana RPC: `answer` gets each method and its params, and returns the result. */
export async function startRpc(answer: (method: string, params: unknown[]) => unknown = (m) => (m === 'getSignaturesForAddress' ? [] : null)): Promise<{ url: string; close(): Promise<void>; calls: string[] }> {
  const calls: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] }
      calls.push(method)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: answer(method, params) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

export type Lists = {
  hosts: string[]
  keys?: Array<{ key: string; verifier: string; label: string; points: number; until?: string }>
  indexes?: Array<{ index: string; name: string }>
  maxAgeDays?: number
  scoring?: { [key: string]: unknown }
}

/** The index's own numbers, config/scoring.json. */
export const SCORING = JSON.parse(readFileSync(join(ROOT, 'config/scoring.json'), 'utf8'))

/** A directory with lists/ and config/, the index's own but for what is given. */
export function listsDir(l: Lists): string {
  const dir = tmp('lists')
  mkdirSync(join(dir, 'lists'))
  mkdirSync(join(dir, 'config'))
  const about = 'For a test.'
  writeFileSync(join(dir, 'lists/hosts.json'), JSON.stringify({ about, hosts: l.hosts }))
  writeFileSync(join(dir, 'lists/verifiers.json'), JSON.stringify({ about, keys: l.keys ?? [] }))
  writeFileSync(join(dir, 'lists/indexes.json'), JSON.stringify({ about, maxAgeDays: l.maxAgeDays ?? 30, indexes: l.indexes ?? [{ index: 'self', name: 'Test index' }] }))
  writeFileSync(join(dir, 'config/scoring.json'), JSON.stringify({ ...SCORING, about, ...l.scoring }))
  writeFileSync(
    join(dir, 'config/currencies.json'),
    JSON.stringify({ about, mints: { J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa: { name: 'test dollar', code: 'USD', decimals: 6 } } }),
  )
  writeFileSync(join(dir, 'config/chains.json'), JSON.stringify({ about, chains: { [CHAIN]: { reader: 'solana', rpc: 'RPC_URL' } } }))
  return dir
}

export const DOLLAR = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'

/** The index over these lists; with no readSeconds, no pass of its own: the test asks for each. `now`, a clock of the test's, Date.now unless given. */
export async function index(
  l: Lists,
  rpcUrl: string,
  options: { port?: number | null; dataDir?: string; readSeconds?: number; now?: () => number } = {},
): Promise<Index & { dataDir: string }> {
  const dataDir = options.dataDir ?? tmp('data')
  const i = await startIndex({
    dataDir,
    publicUrl: 'https://index.test.example',
    settings: { RPC_URL: rpcUrl },
    readSeconds: options.readSeconds ?? 0,
    listsRoot: listsDir(l),
    marketsDir: MARKETS,
    port: options.port ?? null,
    hostname: '127.0.0.1',
    log: () => {},
    ...(options.now && { now: options.now }),
  })
  return Object.assign(i, { dataDir })
}

/** A page's JSON twin, through the index's own handler. */
export async function twin<T = { [key: string]: unknown }>(i: Index, path: string): Promise<{ status: number; body: T }> {
  const res = i.pages.handle(new Request(`https://index.test.example${path}`))
  return { status: res.status, body: (await res.json()) as T }
}

export async function page(i: Index, path: string): Promise<{ status: number; text: string }> {
  const res = i.pages.handle(new Request(`https://index.test.example${path}`))
  return { status: res.status, text: await res.text() }
}

export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true })
