// Everything the index is told from outside. Its inputs are three public lists, files in lists/:
// the hosts it reads, the markets it uses and the keepers it trusts, so anyone can rebuild what it
// shows from them, the hosts and the chain. Its opinions are two more files, in config/: the scoring
// weights and the currencies its pages show. Environment variables say where things run. Everything
// is read once at start; a change means a restart.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeOrigin, publicKeyFromAddress } from '../../forest/records/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const INDEX_ROOT = resolve(here, '..')

/** The keepers this index trusts, by address, each with this index's weight for it, from 0 to 1. */
export type KeeperConfig = Record<string, { name: string; weight: number }>
/** The markets this index uses: their names, and the directory their files are read from. */
export type MarketsList = { directory: string; markets: string[] }
/** A token the pages show as money: its ISO 4217 code, its symbol, and its base units' decimals. */
export type CurrencyConfig = Record<string, { code: string; symbol: string; decimals: number }>
export type ScoringConfig = {
  evidence: { both: number; oneSided: number; none: number }
  /** The weight of a reviewer with no counted row. */
  unstampedReviewer: number
  countedMints: string[]
  maxRounds: number
  tolerance: number
}

/** The programs the foundation's index reads by default: the registry and the escrow on devnet. */
export const DEVNET = {
  registry: '5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC',
  escrow: 'FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8',
}

export type Config = {
  databaseUrl: string
  /** The hosts this index reads, each in full, as origins. Empty: no record reader. */
  hosts: string[]
  markets: MarketsList
  keepers: KeeperConfig
  /** A Solana RPC. Unset: no chain reader. */
  rpcUrl: string | null
  registryProgramId: string
  escrowProgramId: string
  /** How often every reader looks for anything new. */
  pollMs: number
  /** How settled a transaction must be before it is read: 'finalized' (the default) or 'confirmed'. */
  chainCommitment: 'finalized' | 'confirmed'
  /** 32 bytes, hex. Both of the index's signing keys come from it. Null in the web process, which never signs. */
  signingSeed: Uint8Array | null
  port: number
  /** Where the pages are published, with no trailing slash: every canonical link, the sitemap and the read skill use it. */
  publicUrl: string
  scoring: ScoringConfig
  currencies: CurrencyConfig
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function field<T>(path: string, file: Record<string, unknown>, key: string): T {
  if (!(key in file)) throw new Error(`${path} has no "${key}"`)
  return file[key] as T
}

/** The hosts list: origins, each as a hosts record names it (https; http only on loopback). */
export function readHosts(path: string): string[] {
  const out: string[] = []
  for (const named of field<unknown[]>(path, readJson(path), 'hosts')) {
    const origin = typeof named === 'string' ? normalizeOrigin(named) : null
    if (!origin || origin !== named) throw new Error(`${path}: ${String(named)} is not a host's origin (https://host[:port]; http only on loopback)`)
    if (!out.includes(origin)) out.push(origin)
  }
  return out
}

/** The markets list: a directory to read from over http(s), and the names this index uses. */
export function readMarkets(path: string): MarketsList {
  const file = readJson(path)
  const directory = field<string>(path, file, 'directory')
  const url = new URL(directory)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${path}: the directory is not an http(s) URL`)
  const markets = field<unknown[]>(path, file, 'markets')
  if (!markets.every((m) => typeof m === 'string' && m !== '')) throw new Error(`${path}: every market is a name`)
  return { directory: directory.replace(/\/+$/, ''), markets: [...new Set(markets as string[])] }
}

/** The keepers list: every key an address, every weight from 0 to 1. */
export function readKeepers(path: string): KeeperConfig {
  const keepers = field<KeeperConfig>(path, readJson(path), 'keepers')
  for (const [address, k] of Object.entries(keepers)) {
    if (!publicKeyFromAddress(address)) throw new Error(`${path}: ${address} is not a keeper's address`)
    if (typeof k.weight !== 'number' || !(k.weight >= 0 && k.weight <= 1)) throw new Error(`${path}: ${address}'s weight is not from 0 to 1`)
  }
  return keepers
}

function readScoring(path: string): ScoringConfig {
  const { about: _about, ...rest } = readJson(path)
  return rest as ScoringConfig
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

/**
 * `seed: false` for the web process: it reads the database and serves pages, and never holds the
 * signing seed.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, opts: { seed?: boolean } = {}): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const needSeed = opts.seed ?? true
  return {
    databaseUrl: env.DATABASE_URL,
    hosts: readHosts(env.HOSTS_FILE || join(INDEX_ROOT, 'lists/hosts.json')),
    markets: readMarkets(env.MARKETS_FILE || join(INDEX_ROOT, 'lists/markets.json')),
    keepers: readKeepers(env.KEEPERS_FILE || join(INDEX_ROOT, 'lists/keepers.json')),
    rpcUrl: env.SOLANA_RPC_URL || null,
    registryProgramId: env.REGISTRY_PROGRAM_ID || DEVNET.registry,
    escrowProgramId: env.ESCROW_PROGRAM_ID || DEVNET.escrow,
    pollMs: Number(env.POLL_MS || 5000),
    chainCommitment: env.CHAIN_COMMITMENT === 'confirmed' ? 'confirmed' : 'finalized',
    signingSeed: needSeed ? hexSeed(env.INDEX_SIGNING_SEED) : null,
    port: Number(env.PORT || 8080),
    publicUrl: publicUrl(env.PUBLIC_URL),
    scoring: readScoring(env.SCORING_FILE || join(INDEX_ROOT, 'config/scoring.json')),
    currencies: field(env.CURRENCIES_FILE || 'currencies', readJson(env.CURRENCIES_FILE || join(INDEX_ROOT, 'config/currencies.json')), 'currencies'),
  }
}
