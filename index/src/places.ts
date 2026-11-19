// What this index asks the places service (../places/README.md), at PLACES_URL, while it builds a
// page, since a page with no script can ask nothing itself: the first place found for the words a
// person types in Where (`/v1/find`), and the names nearest a circle's centre (`/v1/name`, at the
// point rounded to two decimals, as places rounds it), of which captionOf picks the one to show.
// Places' answers change only with a new file, so each is kept here for a day, by its question,
// up to MAX of each kind, the oldest going first. One that fails or takes more than TIMEOUT_MS is
// not kept, and the page shows the place without its name; nothing is logged, so no one's words
// or points reach this index's logs. With no PLACES_URL, it asks nothing: no name, and Where finds
// no place. The credit every answer carries is the About page's.

import { captionOf } from './pages/words.ts'

export const TIMEOUT_MS = 5000
export const KEEP_MS = 24 * 60 * 60 * 1000
export const MAX = 10_000

/** The place Where found: its point as `near` writes one, `lat,lon`, and its caption, the name to show. */
export type Found = { near: string; name: string }

export type Places = {
  /** The first place places finds for these words, or null: none found, or places did not answer. */
  find(words: string): Promise<Found | null>
  /** The name to show for a circle, by its centre and its size; null when places names none or did not answer. */
  caption(lat: number, lon: number, radiusKm: number): Promise<string | null>
  /** The credit places' answers carry, or null before places has answered. */
  credit(): Promise<string | null>
}

/** One answer of places', as far as this index reads it. */
type Answer = { caption: string; radiusKm: number; place: { lat: string; lon: string } }

const DECIMAL = /^-?\d+(\.\d+)?$/
const isAnswer = (v: unknown): v is Answer => {
  const a = v as Answer | null
  return !!a && typeof a.caption === 'string' && !!a.caption && Number.isInteger(a.radiusKm) && !!a.place && DECIMAL.test(String(a.place.lat)) && DECIMAL.test(String(a.place.lon))
}

/** Answers kept for a day by their question, at most MAX, the oldest dropped first. */
class Kept<T> {
  private readonly held = new Map<string, { at: number; value: T }>()
  private readonly now: () => number
  constructor(now: () => number) {
    this.now = now
  }
  get(key: string): T | undefined {
    const k = this.held.get(key)
    if (k && this.now() - k.at < KEEP_MS) return k.value
    this.held.delete(key)
    return undefined
  }
  set(key: string, value: T): void {
    this.held.delete(key)
    this.held.set(key, { at: this.now(), value })
    if (this.held.size > MAX) this.held.delete(this.held.keys().next().value!)
  }
}

/** A point to two decimals, as places rounds one: `40.42,-3.7`. */
const rounded = (n: number) => String(Math.round(n * 100) / 100 || 0)

export function placesAt(url: string | null, now: () => number = Date.now): Places {
  const found = new Kept<Found | null>(now)
  const named = new Kept<Answer[]>(now)
  let credit: { at: number; text: string } | null = null

  /** Places' places for a path, [] for a question it refuses (too few letters), or null when it did not answer. */
  async function ask(path: string): Promise<Answer[] | null> {
    if (url === null) return null
    try {
      const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.status === 400) return []
      if (!res.ok) return null
      const body = (await res.json()) as { places?: unknown; credit?: unknown }
      if (typeof body.credit === 'string') credit = { at: now(), text: body.credit }
      return Array.isArray(body.places) ? body.places.filter(isAnswer) : null
    } catch {
      return null
    }
  }

  return {
    async find(words) {
      const key = words.trim().toLowerCase().replace(/\s+/g, ' ')
      if (!key) return null
      const kept = found.get(key)
      if (kept !== undefined) return kept
      const answers = await ask(`/v1/find?q=${encodeURIComponent(key)}`)
      if (answers === null) return null
      const first = answers[0]
      const out = first ? { near: `${first.place.lat},${first.place.lon}`, name: first.caption } : null
      found.set(key, out)
      return out
    },
    async caption(lat, lon, radiusKm) {
      const key = `${rounded(lat)},${rounded(lon)}`
      let answers = named.get(key)
      if (answers === undefined) {
        const asked = await ask(`/v1/name?near=${key}`)
        if (asked === null) return null
        named.set(key, (answers = asked))
      }
      return captionOf(answers, radiusKm)
    },
    async credit() {
      if (url !== null && (!credit || now() - credit.at >= KEEP_MS)) {
        try {
          const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
          const body = res.ok ? ((await res.json()) as { credit?: unknown }) : {}
          if (typeof body.credit === 'string') credit = { at: now(), text: body.credit }
        } catch {
          // Places did not answer: the credit last seen, if any.
        }
      }
      return credit?.text ?? null
    },
  }
}
