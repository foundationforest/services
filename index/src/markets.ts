// The market directory, as this index reads it: the `markets` repo itself, fetched over HTTPS from
// MARKETS_URL, never copied. Its `directory.md` names each market with a link to its file,
// `<folder>/<name>.json`, which is checked with shapes/' validator. There are no aliases: a market
// is its one directory name, byte for byte.
//
// badgeScope(scope) says whether a registry scope can count as a badge: `market/role` only, the
// market a directory name byte for byte and the role one its sides allow (seller and buyer when
// two, peer when one). A plain `market` counts for nothing. A post names no market: it is in its
// author profile's.

// @ts-expect-error shapes/ is plain JavaScript with no type declarations
import { rolesOf, validateMarket } from '../../shapes/src/validate.js'

/** A block of extra fields, as a market file writes it: flat fields in lexicon syntax. */
export type FieldBlock = { properties?: Record<string, { type: string; description?: string }>; required?: string[] }

export type MarketFile = {
  name: string
  folder: string
  description: string
  sides: 'two' | 'one'
  /** The plain words pages use for the two sides of a two-sided market. */
  labels?: { seller: string; buyer: string }
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
  /** Market files the directory lists that are not valid at their own path, with why. They count for nothing. */
  readonly refused: { file: string; errors: string[] }[] = []

  constructor(files: { file: string; market: unknown }[]) {
    for (const { file, market } of files) {
      const checked = validateMarket(market) as { ok: boolean; errors: string[] }
      if (!checked.ok) {
        this.refused.push({ file, errors: checked.errors })
        continue
      }
      const m = market as MarketFile
      this.markets.set(m.name, { ...m, roles: [...(rolesOf(m) as string[])] })
    }
  }

  /**
   * The directory, read from a copy of the markets repo served over HTTP(S): `base` is the folder
   * that holds `directory.md`, such as `https://raw.githubusercontent.com/foundationforest/markets/main`.
   * A file that can't be fetched stops the load, so a network failure never drops a market
   * quietly; a file that fetches but is not a valid market file at its own path is refused.
   */
  static async fetch(base: string, get: typeof fetch = fetch): Promise<Directory> {
    const read = async (path: string): Promise<string> => {
      const res = await get(`${base}/${path}`)
      if (!res.ok) throw new Error(`the market directory: ${base}/${path} answered ${res.status}`)
      return res.text()
    }
    const links = parseDirectory(await read('directory.md'))
    const files: { file: string; market: unknown }[] = []
    const refused: { file: string; errors: string[] }[] = []
    for (const { name, path } of links) {
      let market: unknown
      try {
        market = JSON.parse(await read(path))
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err
        refused.push({ file: path, errors: ['not JSON'] })
        continue
      }
      const m = market as { name?: unknown; folder?: unknown }
      if (m.name !== name || path !== `${m.folder}/${m.name}.json`) {
        refused.push({ file: path, errors: [`listed as ${name}, but the file names ${String(m.name)} in ${String(m.folder)}`] })
        continue
      }
      files.push({ file: path, market })
    }
    const directory = new Directory(files)
    directory.refused.push(...refused)
    return directory
  }

  /**
   * Whether a registry scope is a badge this index counts: `market/role`, its market part a
   * directory name byte for byte and its role one of that market's roles. A scope with no role
   * counts for nothing.
   */
  badgeScope(scope: string): { market: string; role: string } | null {
    const { market, role } = splitScope(scope)
    const file = this.markets.get(market)
    if (!file || role === null || !file.roles.includes(role)) return null
    return { market, role }
  }

  /** The plain word for a side in a market: its label when the file has one, else the role itself. */
  sideWord(market: string | null, side: 'seller' | 'buyer'): string {
    const labels = market ? this.markets.get(market)?.labels : undefined
    return labels?.[side] ?? side
  }

  folders(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const m of this.markets.values()) {
      out.set(m.folder, [...(out.get(m.folder) ?? []), m.name].sort())
    }
    return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
}

/**
 * A registry scope is a market, or a market and a role after the first slash: `online-tutors` or
 * `online-tutors/seller`. Only the slash: market names and roles are slugs, so a scope written
 * with any other separator is not a directory name and counts for nothing. Accepting two
 * separators would make two scopes, so two badges, for one human in one market.
 */
export function splitScope(scope: string): { market: string; role: string | null } {
  const at = scope.indexOf('/')
  return at === -1 ? { market: scope, role: null } : { market: scope.slice(0, at), role: scope.slice(at + 1) }
}

/**
 * What the index takes from the markets repo's `directory.md`: each market's line,
 * ``- [`name`](folder/name.json): …``. Nothing else in the page is read.
 */
export function parseDirectory(md: string): { name: string; path: string }[] {
  return [...md.matchAll(/^- \[`([^`]+)`\]\(([^)\s]+\.json)\)/gm)].map(([, name, path]) => ({ name, path }))
}
