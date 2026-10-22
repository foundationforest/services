// The index's opinions: the three lists in lists/ and the two files in config/, read once at start.
// Each is a file anyone can read; README.md, How we run it, says what each holds today. A file that
// does not read stops the start, naming the file and what is wrong.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeOrigin, publicKeyFromAddress } from '@foundationforest/records'

/** One issuer key this index counts. */
export type ListedKey = {
  /** The key's address. */
  key: string
  /** The issuer name its note proofs must carry. */
  issuer: string
  /** What the pages call its check, such as "face check". */
  label: string
  /** The points a profile it checked starts the ranking with. */
  points: number
  /** For a key that leaked: proofs first seen after this time (ms) do not count. */
  until?: number
}

/** An index whose reputation proofs this index shows. `self` is this index's own key. */
export type ListedIndex = { index: string; name: string }

/** The numbers the ranking takes (config/scoring.json). */
export type Scoring = {
  damping: number
  tolerance: number
  maxRounds: number
  shrink: number
  /** One weight per kind of evidence, and `none`. */
  evidence: { [kind: string]: number; none: number }
}

/** A mint this index takes as money. */
export type Currency = { name: string; code: string; decimals: number }

export type Lists = {
  hosts: string[]
  keys: ListedKey[]
  roots: number
  indexes: ListedIndex[]
  scoring: Scoring
  currencies: Map<string, Currency>
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

  const issuersFile = read(root, 'lists/issuers.json')
  if (!Array.isArray(issuersFile.keys)) fail('lists/issuers.json', 'keys is a list')
  const keys = issuersFile.keys.map((k): ListedKey => {
    const where = `key ${JSON.stringify(isObject(k) ? k.key : k)}`
    if (!isObject(k) || !publicKeyFromAddress(k.key)) fail('lists/issuers.json', `${where}: key is an address`)
    if (typeof k.issuer !== 'string' || !k.issuer) fail('lists/issuers.json', `${where}: issuer is a name`)
    if (typeof k.label !== 'string' || !k.label) fail('lists/issuers.json', `${where}: label is text`)
    if (!isNumber(k.points) || k.points < 0) fail('lists/issuers.json', `${where}: points is a number from 0`)
    const until = k.until === undefined ? undefined : Date.parse(k.until as string)
    if (k.until !== undefined && (typeof k.until !== 'string' || !Number.isFinite(until))) fail('lists/issuers.json', `${where}: until is a time, such as 2026-11-01T00:00:00Z`)
    return { key: k.key as string, issuer: k.issuer, label: k.label, points: k.points, ...(until !== undefined && { until }) }
  })
  if (new Set(keys.map((k) => k.key)).size !== keys.length) fail('lists/issuers.json', 'a key is listed twice')

  const indexesFile = read(root, 'lists/indexes.json')
  if (!Number.isSafeInteger(indexesFile.roots) || (indexesFile.roots as number) < 1) fail('lists/indexes.json', 'roots is a whole number from 1')
  if (!Array.isArray(indexesFile.indexes)) fail('lists/indexes.json', 'indexes is a list')
  const indexes = indexesFile.indexes.map((i): ListedIndex => {
    if (!isObject(i) || typeof i.name !== 'string' || (i.index !== 'self' && !publicKeyFromAddress(i.index))) fail('lists/indexes.json', `${JSON.stringify(i)}: each is { index: self or an address, name }`)
    return { index: i.index as string, name: i.name }
  })

  const scoringFile = read(root, 'config/scoring.json')
  const { damping, tolerance, maxRounds, shrink, evidence } = scoringFile
  if (!isNumber(damping) || damping < 0 || damping >= 1) fail('config/scoring.json', 'damping is from 0 to below 1')
  if (!isNumber(tolerance) || tolerance <= 0) fail('config/scoring.json', 'tolerance is above 0')
  if (!Number.isSafeInteger(maxRounds) || (maxRounds as number) < 1) fail('config/scoring.json', 'maxRounds is a whole number from 1')
  if (!isNumber(shrink) || shrink < 0) fail('config/scoring.json', 'shrink is a number from 0')
  if (!isObject(evidence) || !Object.values(evidence).every((w) => isNumber(w) && w >= 0) || !isNumber(evidence.none)) {
    fail('config/scoring.json', 'evidence holds a weight from 0 for each kind, and none')
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

  return {
    hosts,
    keys,
    roots: indexesFile.roots as number,
    indexes,
    scoring: { damping, tolerance, maxRounds: maxRounds as number, shrink, evidence: evidence as Scoring['evidence'] },
    currencies,
  }
}
