// Everything the index is told from outside: environment variables for where things are (the
// hosts, the market directory), and JSON files for its opinions (issuer weights, scoring weights,
// the currencies its pages show). Read once at start; a change means a restart.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeOrigin } from '../../forest/records/src/entry.ts'
import { publicKeyFromDid } from '../../forest/records/src/keys.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const INDEX_ROOT = resolve(here, '..')

/**
 * The issuers this index trusts, keyed by the issuer's did:key (the key its roots file is signed
 * with), each with this index's weight for it and where it publishes its signed roots file. An
 * issuer with no `roots` address vouches only for roots already in the database.
 */
export type IssuerConfig = Record<string, { name: string; weight: number; roots?: string }>
/** A token the pages show as money: its ISO 4217 code, its symbol, and its base units' decimals. */
export type CurrencyConfig = Record<string, { code: string; symbol: string; decimals: number }>
export type ScoringConfig = {
  evidence: { both: number; oneSided: number; none: number }
  unbadgedReviewer: number
  countedMints: string[]
  maxRounds: number
  tolerance: number
}

export type Config = {
  databaseUrl: string
  /** The hosts this index follows in full, as origins. Hosts named in the folders it reads are followed too, badged profiles only. Empty: no record reader. */
  hosts: string[]
  /** A Solana RPC. Unset: no chain reader. */
  rpcUrl: string | null
  registryProgramId: string | null
  escrowProgramId: string | null
  escrowV2ProgramId: string | null
  /** How often every reader looks for anything new: the hosts, the chain, the issuers' roots (at most once a minute). */
  pollMs: number
  /** How settled a transaction must be before it is read: 'finalized' (the default) or 'confirmed'. */
  chainCommitment: 'finalized' | 'confirmed'
  /** 32 bytes, hex. Both of the index's signing keys come from it. Null in the web process, which never signs. */
  signingSeed: Uint8Array | null
  /** Where the `markets` repo's files are read from: the folder holding its `directory.md`, over HTTP(S). */
  marketsUrl: string
  port: number
  /** Where the pages are published, with no trailing slash: every canonical link, the sitemap and the read skill use it. */
  publicUrl: string
  issuers: IssuerConfig
  scoring: ScoringConfig
  currencies: CurrencyConfig
}

function readJson<T>(path: string, key: string): T {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!(key in parsed)) throw new Error(`${path} has no "${key}"`)
  return parsed[key] as T
}

function readScoring(path: string): ScoringConfig {
  const { about: _about, ...rest } = JSON.parse(readFileSync(path, 'utf8'))
  return rest as ScoringConfig
}

/** `HOSTS`: origins separated by commas, each as folders name hosts (https; http only on loopback). */
export function hostList(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',').map((h) => h.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(part)
    if (!origin) throw new Error(`HOSTS: ${part} is not a host's origin (https://host[:port]; http only on loopback)`)
    if (!out.includes(origin)) out.push(origin)
  }
  return out
}

/** The issuers file: every key a did:key, every weight from 0 to 1, every roots address http(s). */
function readIssuers(path: string): IssuerConfig {
  const issuers = readJson<IssuerConfig>(path, 'issuers')
  for (const [key, i] of Object.entries(issuers)) {
    if (!publicKeyFromDid(key)) throw new Error(`${path}: ${key} is not an issuer's did:key`)
    if (typeof i.weight !== 'number' || !(i.weight >= 0 && i.weight <= 1)) throw new Error(`${path}: ${key}'s weight is not from 0 to 1`)
    if (i.roots !== undefined && !/^https?:\/\//.test(i.roots)) throw new Error(`${path}: ${key}'s roots is not an http(s) URL`)
  }
  return issuers
}

export function hexSeed(hex: string | undefined): Uint8Array {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('INDEX_SIGNING_SEED must be 32 bytes as 64 hex characters')
  }
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

/** An origin only: the pages live at the root of their host (`/`, `/markets/…`, `/sitemap.xml`). */
export function publicUrl(raw: string | undefined): string {
  const url = new URL(raw || 'https://forest.foundation')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PUBLIC_URL must be an http or https URL')
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_URL is an origin, such as https://forest.foundation, with no path')
  return url.origin
}

/** The markets repo's own files, on its main branch unless a URL names another branch or a commit. */
export const MARKETS_URL = 'https://raw.githubusercontent.com/foundationforest/markets/main'

export function marketsUrl(raw: string | undefined): string {
  const url = new URL(raw || MARKETS_URL)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('MARKETS_URL must be an http or https URL')
  return url.href.replace(/\/+$/, '')
}

/**
 * `seed: false` for the web process: it reads the database and serves pages, and never holds the
 * signing seed.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, opts: { seed?: boolean } = {}): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const needSeed = opts.seed ?? true
  return {
    databaseUrl: env.DATABASE_URL,
    hosts: hostList(env.HOSTS),
    rpcUrl: env.SOLANA_RPC_URL || null,
    registryProgramId: env.REGISTRY_PROGRAM_ID || null,
    escrowProgramId: env.ESCROW_PROGRAM_ID || null,
    escrowV2ProgramId: env.ESCROW_V2_PROGRAM_ID || null,
    pollMs: Number(env.POLL_MS || 5000),
    chainCommitment: env.CHAIN_COMMITMENT === 'confirmed' ? 'confirmed' : 'finalized',
    signingSeed: needSeed ? hexSeed(env.INDEX_SIGNING_SEED) : null,
    marketsUrl: marketsUrl(env.MARKETS_URL),
    port: Number(env.PORT || 8080),
    publicUrl: publicUrl(env.PUBLIC_URL),
    issuers: readIssuers(env.ISSUERS_FILE || join(INDEX_ROOT, 'config/issuers.json')),
    scoring: readScoring(env.SCORING_FILE || join(INDEX_ROOT, 'config/scoring.json')),
    currencies: readJson(env.CURRENCIES_FILE || join(INDEX_ROOT, 'config/currencies.json'), 'currencies'),
  }
}
