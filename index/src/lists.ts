// The index's opinions: the three lists in lists/ and the one file in config/, read once at start.
// Each is a file anyone can read; README.md, How we run it, says what each holds today. A file that
// does not read stops the start, naming the file and what is wrong.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeOrigin, publicKeyFromAddress } from '@foundationforest/folders'

import type { Numbers } from './rank.ts'

/** One verifier key this index counts. */
export type ListedKey = {
  /** The key's address. */
  key: string
  /** The verifier name its verifications must carry. */
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

export type Lists = {
  hosts: string[]
  keys: ListedKey[]
  /** How many days old a root, not the newest, may be for a reputation proof to show. */
  maxAgeDays: number
  indexes: ListedIndex[]
  /** The numbers the ranking takes (config/scoring.json), each explained in README.md, How it scores. */
  scoring: Numbers
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
  const { vouchStep, reportCut, marketWeight, tolerance, maxRounds } = scoringFile
  if (!isNumber(vouchStep) || vouchStep < 0 || vouchStep > 1) fail('config/scoring.json', 'vouchStep is from 0 to 1')
  if (!isNumber(reportCut) || reportCut < 0 || reportCut > 1) fail('config/scoring.json', 'reportCut is from 0 to 1')
  if (!isNumber(marketWeight) || marketWeight <= 0) fail('config/scoring.json', 'marketWeight is above 0')
  if (!isNumber(tolerance) || tolerance <= 0) fail('config/scoring.json', 'tolerance is above 0')
  if (!Number.isSafeInteger(maxRounds) || (maxRounds as number) < 1) fail('config/scoring.json', 'maxRounds is a whole number from 1')

  return {
    hosts,
    keys,
    maxAgeDays: indexesFile.maxAgeDays as number,
    indexes,
    scoring: { vouchStep, reportCut, marketWeight, tolerance, maxRounds: maxRounds as number },
  }
}
