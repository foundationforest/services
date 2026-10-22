// A small Forest on loopback for the tests: the standard's reference host, a stand-in issuer whose
// key the test's lists name, people with seeds, profiles with real note proofs made from the note
// circuit's committed proving files, records signed with their main keys, a stand-in Solana RPC,
// and the index itself, with lists written to a directory of its own.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mainKey, type MainKey, payKey, seedScalar } from '@foundationforest/keys'
import { issuerKeyOf, noteNumberOf, proofBytes, proveNote, signNote, toBytes32 } from '@foundationforest/note'
import { b64u, hex, hostsRecord, ownerRecord, publish, type SignedRecord } from '@foundationforest/records'
import { Host } from '@foundationforest/records/host'

import { type Index, ROOT, startIndex } from '../src/index.ts'

export const STANDARD = join(ROOT, '../standard')
export const MARKETS = join(ROOT, '../markets')
export const NOTE_FILES = { wasm: join(STANDARD, 'proofs/note/circuit/setup/note.wasm'), zkey: join(STANDARD, 'proofs/note/circuit/setup/note.zkey') }
export const REPUTATION_FILES = {
  wasm: join(STANDARD, 'proofs/reputation/circuit/setup/reputation.wasm'),
  zkey: join(STANDARD, 'proofs/reputation/circuit/setup/reputation.zkey'),
}

export const tmp = (name: string) => mkdtempSync(join(tmpdir(), `index-${name}-`))

/** An issuer: a name and a key that signs notes. */
export type Issuer = { name: string; privateKey: Uint8Array; key: string }
export function issuer(name = 'issuer.test.example'): Issuer {
  const privateKey = new Uint8Array(randomBytes(32))
  return { name, privateKey, key: issuerKeyOf(privateKey) }
}

/** A note proof as a profile record carries it. */
export type ProofField = { circuit: 'note'; issuer: string; issuerName: string; label: string; stamp: string; proof: string }

/** A person's profile under one label: its main key, its pay address, and note proofs from each issuer given. */
export type Profile = { seed: Uint8Array<ArrayBuffer>; label: string; key: MainKey; pay: string; proofs: ProofField[] }

/** A note from `by` for this seed, and its proof for `label` (about a second each). */
export async function noteProof(seed: Uint8Array<ArrayBuffer>, label: string, by: Issuer): Promise<ProofField> {
  const scalar = await seedScalar(seed)
  const note = signNote(by.privateKey, { noteNumber: noteNumberOf(scalar, by.name), attributes: 1n })
  const r = await proveNote({ seedScalar: scalar, issuerName: by.name, note, label, artifacts: NOTE_FILES })
  return { circuit: 'note', issuer: r.issuer, issuerName: by.name, label, stamp: hex.encode(toBytes32(r.stamp)), proof: b64u.encode(proofBytes(r.proof)) }
}

export async function profile(label: string, by: Issuer[] = [], seed = new Uint8Array(randomBytes(32))): Promise<Profile> {
  const proofs = []
  for (const i of by) proofs.push(await noteProof(seed, label, i))
  return { seed, label, key: await mainKey(seed, label), pay: (await payKey(seed, label)).address, proofs }
}

/** The profile record a profile shows: its market, role, pay address and proofs, and anything more. */
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
  keys?: Array<{ key: string; issuer: string; label: string; points: number; until?: string }>
  indexes?: Array<{ index: string; name: string }>
  roots?: number
  scoring?: { [key: string]: unknown }
}

/** A directory with lists/ and config/, the index's own but for what is given. */
export function listsDir(l: Lists): string {
  const dir = tmp('lists')
  mkdirSync(join(dir, 'lists'))
  mkdirSync(join(dir, 'config'))
  const about = 'For a test.'
  writeFileSync(join(dir, 'lists/hosts.json'), JSON.stringify({ about, hosts: l.hosts }))
  writeFileSync(join(dir, 'lists/issuers.json'), JSON.stringify({ about, keys: l.keys ?? [] }))
  writeFileSync(join(dir, 'lists/indexes.json'), JSON.stringify({ about, roots: l.roots ?? 10, indexes: l.indexes ?? [{ index: 'self', name: 'Test index' }] }))
  writeFileSync(
    join(dir, 'config/scoring.json'),
    JSON.stringify({ about, damping: 0.85, tolerance: 1e-9, maxRounds: 100, shrink: 0.5, evidence: { escrow: 1, payment: 1, none: 1 }, ...l.scoring }),
  )
  writeFileSync(
    join(dir, 'config/currencies.json'),
    JSON.stringify({ about, mints: { J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa: { name: 'test dollar', code: 'USD', decimals: 6 } } }),
  )
  return dir
}

export const DOLLAR = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'

/** The index over these lists; with no readSeconds, no pass of its own: the test asks for each. */
export async function index(l: Lists, rpcUrl: string, options: { port?: number | null; dataDir?: string; readSeconds?: number } = {}): Promise<Index & { dataDir: string }> {
  const dataDir = options.dataDir ?? tmp('data')
  const i = await startIndex({ dataDir, publicUrl: 'https://index.test.example', rpcUrl, readSeconds: options.readSeconds ?? 0, listsRoot: listsDir(l), marketsDir: MARKETS, port: options.port ?? null, hostname: '127.0.0.1', log: () => {} })
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
