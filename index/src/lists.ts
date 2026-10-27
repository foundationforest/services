// The index's opinions: the three lists in lists/ and the three files in config/, read once at start.
// Each is a file anyone can read; README.md, How we run it, says what each holds today. A file that
// does not read stops the start, naming the file and what is wrong.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeOrigin, publicKeyFromAddress } from '@foundationforest/records'

import type { Numbers } from './rank.ts'

/** One verifier key this index counts. */
export type ListedKey = {
  /** The key's address. */
  key: string
  /** The verifier name its stamp proofs must carry. */
  verifier: string
  /** What the pages call its check, such as "face check". */
  label: string
  /** From 0 to 1: how sure this index is that a profile it checked is one real person. */
  confidence: number
  /** For a key that leaked: proofs first seen after this time (ms) do not count. */
  until?: number
}

/** An index whose reputation proofs this index shows. `self` is this index's own key. */
export type ListedIndex = { index: string; name: string }

/** The numbers the ranking takes (config/scoring.json), each explained in README.md, How it scores. */
export type Scoring = Numbers & {
  /** One factor per kind of evidence, and `none`. */
  evidence: { [kind: string]: number; none: number }
}

/** A mint this index takes as money. */
export type Currency = { name: string; code: string; decimals: number }

/** A chain this index reads evidence on: the reader that reads it, and the setting that holds its RPC's URL. */
export type Chain = { reader: string; rpc: string }

/** A chain id in CAIP-2 form, such as solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1: a namespace and a reference. */
export const CHAIN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/

export type Lists = {
  hosts: string[]
  keys: ListedKey[]
  /** How many days old a root, not the newest, may be for a reputation proof to show. */
  maxAgeDays: number
  indexes: ListedIndex[]
  scoring: Scoring
  currencies: Map<string, Currency>
  /** By CAIP-2 id. */
  chains: Map<string, Chain>
}

const isObject = (v: unknown): v is { [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function read(root: string, file: string): { [key: string]: unknown } {
  const path = join(root, file)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`)
  }
  if (!isObject(value) || typeof value.about !== 'string') throw new Error(`${file}: an object with an about`)
  return value
}

function fail(file: string, what: string): never {
  throw new Error(`${file}: ${what}`)
}

/** Every list and config file under `root` (lists/ and config/ beside each other), checked. */
export function loadLists(root: string): Lists {
  const hostsFile = read(root, 'lists/hosts.json')
  if (!Array.isArray(hostsFile.hosts)) fail('lists/hosts.json', 'hosts is a list of origins')
  const hosts = hostsFile.hosts.map((h) => (typeof h === 'string' && normalizeOrigin(h) === h ? h : fail('lists/hosts.json', `${JSON.stringify(h)} is not an origin`)))

  const verifiersFile = read(root, 'lists/verifiers.json')
  if (!Array.isArray(verifiersFile.keys)) fail('lists/verifiers.json', 'keys is a list')
  const keys = verifiersFile.keys.map((k): ListedKey => {
    const where = `key ${JSON.stringify(isObject(k) ? k.key : k)}`
    if (!isObject(k) || !publicKeyFromAddress(k.key)) fail('lists/verifiers.json', `${where}: key is an address`)
    if (typeof k.verifier !== 'string' || !k.verifier) fail('lists/verifiers.json', `${where}: verifier is a name`)
    if (typeof k.label !== 'string' || !k.label) fail('lists/verifiers.json', `${where}: label is text`)
    if (!isNumber(k.confidence) || k.confidence < 0 || k.confidence > 1) fail('lists/verifiers.json', `${where}: confidence is a number from 0 to 1`)
    const until = k.until === undefined ? undefined : Date.parse(k.until as string)
    if (k.until !== undefined && (typeof k.until !== 'string' || !Number.isFinite(until))) fail('lists/verifiers.json', `${where}: until is a time, such as 2026-11-01T00:00:00Z`)
    return { key: k.key as string, verifier: k.verifier, label: k.label, confidence: k.confidence, ...(until !== undefined && { until }) }
  })
  if (new Set(keys.map((k) => k.key)).size !== keys.length) fail('lists/verifiers.json', 'a key is listed twice')

  const indexesFile = read(root, 'lists/indexes.json')
  if (!Number.isSafeInteger(indexesFile.maxAgeDays) || (indexesFile.maxAgeDays as number) < 1) fail('lists/indexes.json', 'maxAgeDays is a whole number of days from 1')
  if (!Array.isArray(indexesFile.indexes)) fail('lists/indexes.json', 'indexes is a list')
  const indexes = indexesFile.indexes.map((i): ListedIndex => {
    if (!isObject(i) || typeof i.name !== 'string' || (i.index !== 'self' && !publicKeyFromAddress(i.index))) fail('lists/indexes.json', `${JSON.stringify(i)}: each is { index: self or an address, name }`)
    return { index: i.index as string, name: i.name }
  })

  const scoringFile = read(root, 'config/scoring.json')
  const { vouchStep, reportCut, toughFrom, easyTo, marketWeight, tolerance, maxRounds, evidence } = scoringFile
  if (!isNumber(vouchStep) || vouchStep < 0 || vouchStep > 1) fail('config/scoring.json', 'vouchStep is from 0 to 1')
  if (!isNumber(reportCut) || reportCut < 0 || reportCut > 1) fail('config/scoring.json', 'reportCut is from 0 to 1')
  if (!isNumber(toughFrom) || toughFrom <= 0.5 || toughFrom > 1) fail('config/scoring.json', 'toughFrom is above 0.5, up to 1')
  if (!isNumber(easyTo) || easyTo < 0 || easyTo >= 0.5) fail('config/scoring.json', 'easyTo is from 0 to below 0.5')
  if (!isNumber(marketWeight) || marketWeight <= 0) fail('config/scoring.json', 'marketWeight is above 0')
  if (!isNumber(tolerance) || tolerance <= 0) fail('config/scoring.json', 'tolerance is above 0')
  if (!Number.isSafeInteger(maxRounds) || (maxRounds as number) < 1) fail('config/scoring.json', 'maxRounds is a whole number from 1')
  if (!isObject(evidence) || !Object.values(evidence).every((w) => isNumber(w) && w >= 0) || !isNumber(evidence.none)) {
    fail('config/scoring.json', 'evidence holds a factor from 0 for each kind, and none')
  }

  const currenciesFile = read(root, 'config/currencies.json')
  if (!isObject(currenciesFile.mints)) fail('config/currencies.json', 'mints is an object')
  const currencies = new Map<string, Currency>()
  for (const [mint, c] of Object.entries(currenciesFile.mints)) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) fail('config/currencies.json', `${mint} is not a mint's address`)
    if (!isObject(c) || typeof c.name !== 'string' || typeof c.code !== 'string' || !/^[A-Z]{3}$/.test(c.code) || !Number.isSafeInteger(c.decimals) || (c.decimals as number) < 0) {
      fail('config/currencies.json', `${mint}: { name, code (three capitals), decimals }`)
    }
    currencies.set(mint, { name: c.name, code: c.code, decimals: c.decimals as number })
  }

  const chainsFile = read(root, 'config/chains.json')
  if (!isObject(chainsFile.chains)) fail('config/chains.json', 'chains is an object')
  const chains = new Map<string, Chain>()
  for (const [chain, c] of Object.entries(chainsFile.chains)) {
    if (!CHAIN.test(chain)) fail('config/chains.json', `${chain} is not a CAIP-2 chain id, such as solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)
    if (!isObject(c) || typeof c.reader !== 'string' || typeof c.rpc !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(c.rpc)) {
      fail('config/chains.json', `${chain}: { reader, rpc: the name of the setting that holds its RPC's URL }`)
    }
    chains.set(chain, { reader: c.reader, rpc: c.rpc })
  }

  return {
    hosts,
    keys,
    maxAgeDays: indexesFile.maxAgeDays as number,
    indexes,
    scoring: { vouchStep, reportCut, toughFrom, easyTo, marketWeight, tolerance, maxRounds: maxRounds as number, evidence: evidence as Scoring['evidence'] },
    currencies,
    chains,
  }
}
