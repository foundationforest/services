// A limit on how often one network address may open a Didit session, so nobody runs up the
// foundation's Didit bill. Each session costs money once someone does the check on it.
//
// In memory only: nothing here is written to a file or a log, and a restart forgets it all. It is
// not a security boundary: someone with many addresses gets many sessions. Even in memory it holds
// no address: each is kept as a keyed hash under a random key that exists only in this process.

import { createHmac, randomBytes } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * What one limit counts: an IPv4 address, or an IPv6 address's first 64 bits, which one phone or
 * one household usually holds whole, so walking through its own addresses gets nobody more.
 */
export function addressGroup(address: string): string {
  const plain = address.split('%')[0]
  if (plain.startsWith('::ffff:') && isIPv4(plain.slice(7))) return plain.slice(7)
  if (!isIPv6(plain)) return plain
  const [head, tail] = plain.includes('::') ? plain.split('::') : [plain, undefined]
  const groups = (part: string | undefined) =>
    part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []
  const front = groups(head)
  const back = groups(tail)
  const all = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back]
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`
}

export class RateLimit {
  readonly #max: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #key = randomBytes(32)
  readonly #windows = new Map<string, { start: number; count: number }>()
  #swept = 0

  constructor(options: { max: number; windowMs: number; now?: () => number }) {
    this.#max = options.max
    this.#windowMs = options.windowMs
    this.#now = options.now ?? Date.now
  }

  /** Counts one request from this address. False once it has had its share of the current window. */
  take(address: string): boolean {
    const now = this.#now()
    if (now - this.#swept >= this.#windowMs) {
      for (const [id, window] of this.#windows) if (now - window.start >= this.#windowMs) this.#windows.delete(id)
      this.#swept = now
    }
    const id = createHmac('sha256', this.#key).update(addressGroup(address)).digest('base64')
    const window = this.#windows.get(id)
    if (!window || now - window.start >= this.#windowMs) {
      this.#windows.set(id, { start: now, count: 1 })
      return true
    }
    if (window.count >= this.#max) return false
    window.count++
    return true
  }

  /** How many addresses it is counting. */
  get size(): number {
    return this.#windows.size
  }
}
