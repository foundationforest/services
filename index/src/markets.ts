// The markets this index uses: the names in lists/markets.json, each read from the markets directory
// that list names, over HTTPS, never copied. The directory's `directory.md` names each market with a
// link to its file, `<folder>/<name>.json`. A market is its one name, byte for byte.
//
// A file is checked here for what this index reads from it, and nothing more (`checkMarket`).
//
// `labelOf(label)` says whether a row's label can count: `market/role` only, the market one this
// index uses and the role one its sides allow (seller and buyer when two, peer when one). An offer
// names no market: it is in its author profile's.

import type { MarketsList } from './config.ts'

/** A block of extra fields, as a market file writes it: flat fields in lexicon syntax. */
export type FieldBlock = { properties?: Record<string, { type: string; description?: string }>; required?: string[] }

export type MarketFile = {
  name: string
  folder: string
  description: string
  sides: 'two' | 'one'
  /** The plain words pages use for the two sides of a two-sided market. */
  roleNames?: { seller: string; buyer: string }
  evidenceTypes: string[]
  offerFields: FieldBlock
  reviewFields?: FieldBlock
  ratings: string[]
  howDealsGo: string
  /** Derived, not in the file: seller and buyer when two sides, peer when one. */
  roles: string[]
}

export class Directory {
  readonly markets = new Map<string, MarketFile>()
  /** Markets the list names that could not be used, with why. They count for nothing. */
  readonly refused: { market: string; errors: string[] }[] = []

  constructor(files: { file: string; market: unknown }[]) {
    for (const { file, market } of files) {
      const errors = checkMarket(market)
      if (errors.length) {
        this.refused.push({ market: file, errors })
        continue
      }
      const m = market as MarketFile
      this.markets.set(m.name, { ...m, roles: rolesOf(m) })
    }
  }

  /**
   * The markets the list names, each read from the directory the list names: `directory.md`, then
   * each named market's file. A file that can't be fetched stops the load, so a network failure
   * never drops a market quietly; a market the directory does not list, or whose file is not a
   * valid market file at its own path, is refused.
   */
  static async fetch(list: MarketsList, get: typeof fetch = fetch): Promise<Directory> {
    const read = async (path: string): Promise<string> => {
      const res = await get(`${list.directory}/${path}`)
      if (!res.ok) throw new Error(`the market directory: ${list.directory}/${path} answered ${res.status}`)
      return res.text()
    }
    const links = new Map(parseDirectory(await read('directory.md')).map((l) => [l.name, l.path]))
    const files: { file: string; market: unknown }[] = []
    const refused: { market: string; errors: string[] }[] = []
    for (const name of list.markets) {
      const path = links.get(name)
      if (!path) {
        refused.push({ market: name, errors: ['not in the directory'] })
        continue
      }
      let market: unknown
      try {
        market = JSON.parse(await read(path))
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err
        refused.push({ market: name, errors: ['not JSON'] })
        continue
      }
      const m = market as { name?: unknown; folder?: unknown }
      if (m.name !== name || path !== `${m.folder}/${m.name}.json`) {
        refused.push({ market: name, errors: [`listed at ${path}, but the file names ${String(m.name)} in ${String(m.folder)}`] })
        continue
      }
      files.push({ file: name, market })
    }
    const directory = new Directory(files)
    directory.refused.push(...refused)
    return directory
  }

  /**
   * Whether a row's label counts here: `market/role`, its market one this index uses, byte for
   * byte, and its role one of that market's roles. A label with no role counts for nothing.
   */
  labelOf(label: string): { market: string; role: string } | null {
    const { market, role } = splitLabel(label)
    const file = this.markets.get(market)
    if (!file || role === null || !file.roles.includes(role)) return null
    return { market, role }
  }

  /** The plain word for a side in a market: its role name when the file has one, else the role itself. */
  sideWord(market: string | null, side: 'seller' | 'buyer'): string {
    const names = market ? this.markets.get(market)?.roleNames : undefined
    return names?.[side] ?? side
  }

  folders(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const m of this.markets.values()) {
      out.set(m.folder, [...(out.get(m.folder) ?? []), m.name].sort())
    }
    return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
}

/** The roles a market's sides allow: seller and buyer when two, peer when one. */
export function rolesOf(market: Pick<MarketFile, 'sides'>): string[] {
  return market.sides === 'two' ? ['seller', 'buyer'] : ['peer']
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * What this index reads from a market file, each with the type it needs; every way the file falls
 * short. Keys it does not read are left alone.
 */
export function checkMarket(market: unknown): string[] {
  if (!isObject(market)) return ['a market file is a JSON object']
  const errors: string[] = []
  for (const key of ['name', 'folder', 'description', 'howDealsGo']) {
    if (typeof market[key] !== 'string' || market[key] === '') errors.push(`${key} must be text`)
  }
  if (market.sides !== 'two' && market.sides !== 'one') errors.push('sides must be "two" or "one"')
  if (market.roleNames !== undefined) {
    const names = market.roleNames
    if (market.sides !== 'two' || !isObject(names) || typeof names.seller !== 'string' || typeof names.buyer !== 'string') {
      errors.push('roleNames must be { "seller": …, "buyer": … }, in a two-sided market')
    }
  }
  if (!isStrings(market.evidenceTypes)) errors.push('evidenceTypes must be a list of names')
  if (!isStrings(market.ratings) || !market.ratings.includes('overall')) errors.push('ratings must be a list of names, "overall" among them')
  for (const key of ['offerFields', 'reviewFields']) {
    const block = market[key]
    if (block === undefined && key === 'reviewFields') continue
    if (!isObject(block) || (block.properties !== undefined && !isObject(block.properties))) errors.push(`${key} must be a block of fields`)
  }
  return errors
}

/**
 * A label is a market, or a market and a role after the first slash: `tutoring` or
 * `tutoring/seller`. Only the slash: market names and roles are slugs, so a label written with any
 * other separator is not a market here and counts for nothing. Accepting two separators would make
 * two labels, so two rows, for one human in one market.
 */
export function splitLabel(label: string): { market: string; role: string | null } {
  const at = label.indexOf('/')
  return at === -1 ? { market: label, role: null } : { market: label.slice(0, at), role: label.slice(at + 1) }
}

/**
 * What the index takes from the markets repo's `directory.md`: each market's line,
 * ``- [`name`](folder/name.json): …``. Nothing else in the page is read.
 */
export function parseDirectory(md: string): { name: string; path: string }[] {
  return [...md.matchAll(/^- \[`([^`]+)`\]\(([^)\s]+\.json)\)/gm)].map(([, name, path]) => ({ name: name!, path: path! }))
}
