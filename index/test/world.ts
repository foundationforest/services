// A small Forest on loopback for the tests: this repo's host (its plug, host/src/plug.ts), a
// stand-in verifier whose key the test's lists name, people with seeds, profiles with real
// verifications made from the verification circuit's committed proving files, entries signed with
// their main keys, and the index itself, with lists written to a directory of its own.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mainKey, type MainKey, type PayAddresses, payAddresses, seedNumber, stampNumberOf } from '@foundationforest/keys'
import { b64u, entry, type SignedEntry, write } from '@foundationforest/folders'
import { proofBytes, proveVerification, signStamp, verifierKeyOf } from '@foundationforest/proofs'

import { Host } from '../../host/src/plug.ts'
import { type Index, ROOT, startIndex } from '../src/index.ts'

export const STANDARD = join(ROOT, '../standard')
export const MARKETS = join(ROOT, '../markets')
export const VERIFICATION_FILES = {
  wasm: join(STANDARD, 'proofs/verification/setup/verification.wasm'),
  zkey: join(STANDARD, 'proofs/verification/setup/verification.zkey'),
}
export const REPUTATION_FILES = {
  wasm: join(STANDARD, 'proofs/reputation/setup/reputation.wasm'),
  zkey: join(STANDARD, 'proofs/reputation/setup/reputation.zkey'),
}

export const tmp = (name: string) => mkdtempSync(join(tmpdir(), `index-${name}-`))

/** A verifier: a name and a key that signs stamps. */
export type Verifier = { name: string; privateKey: Uint8Array; key: string }
export function verifier(name = 'verifier.test.example'): Verifier {
  const privateKey = new Uint8Array(randomBytes(32))
  return { name, privateKey, key: verifierKeyOf(privateKey) }
}

/** A verification as a profile entry carries it. */
export type ProofField = { circuit: 'verification'; verifier: string; verifierName: string; label: string; proof: string }

/** A person's profile under one label: its main key, its pay addresses, and verifications from each verifier given. */
export type Profile = { seed: Uint8Array<ArrayBuffer>; label: string; key: MainKey; pay: PayAddresses; proofs: ProofField[] }

/** A stamp from `by` for this seed, and its verification for `label` (about a second each). */
export async function verification(seed: Uint8Array<ArrayBuffer>, label: string, by: Verifier): Promise<ProofField> {
  const stamp = signStamp(by.privateKey, { stampNumber: stampNumberOf(seedNumber(seed), by.name), facts: 1n, verifierName: by.name })
  const r = await proveVerification({ seed, stamp, label, artifacts: VERIFICATION_FILES })
  return { circuit: 'verification', verifier: r.verifier, verifierName: by.name, label, proof: b64u.encode(proofBytes(r.proof)) }
}

export async function profile(label: string, by: Verifier[] = [], seed = new Uint8Array(randomBytes(32))): Promise<Profile> {
  const proofs = []
  for (const v of by) proofs.push(await verification(seed, label, v))
  const key = await mainKey(seed, label)
  return { seed, label, key, pay: await payAddresses(seed, label), proofs }
}

/** The profile entry a profile shows: its market, role, hosts, pay addresses and proofs, and anything more. */
export function profileBody(p: Profile, hosts: string[], more: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  const [market, role] = p.label.split('/')
  return { market, role, hosts, pay: p.pay, proofs: p.proofs, ...more }
}

let clock = Date.now()
/** An entry time later than every one before, so a newer entry always wins. */
export const later = () => (clock = Math.max(clock + 1, Date.now()))

/** This repo's host on loopback: its plug alone, which takes every write; the credits stand in front of it. */
export async function startHost(): Promise<{ url: string; close(): Promise<void> }> {
  const host = new Host()
  const url = await host.listen(0, '127.0.0.1')
  return { url, close: () => host.close() }
}

/** Write signed entries to the host. */
export async function post(hostUrl: string, entries: SignedEntry[]): Promise<void> {
  const [out] = await write([hostUrl], entries)
  const refused = out!.results.filter((r) => !r.ok)
  if (out!.status !== 200 || refused.length) throw new Error(`the host refused: ${JSON.stringify(out)}`)
}

/** A profile's profile entry, naming the host, written there. */
export async function publishProfile(hostUrl: string, p: Profile, more: { [key: string]: unknown } = {}): Promise<void> {
  await post(hostUrl, [entry(p.key, 'profile', profileBody(p, [hostUrl], more) as never, later())])
}

export const at = (p: Profile, path: string, body: { [key: string]: unknown } | null) => entry(p.key, path, body as never, later())

export type Lists = {
  hosts: string[]
  keys?: Array<{ key: string; verifier: string; label: string; confidence: number; until?: string }>
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
  return dir
}

/** The index over these lists; with no readSeconds, no pass of its own: the test asks for each. `now`, a clock of the test's, Date.now unless given. */
export async function index(l: Lists, options: { port?: number | null; dataDir?: string; readSeconds?: number; now?: () => number } = {}): Promise<Index & { dataDir: string }> {
  const dataDir = options.dataDir ?? tmp('data')
  const i = await startIndex({
    dataDir,
    publicUrl: 'https://index.test.example',
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
