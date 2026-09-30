// The batch: accepted commitments go onto the list together, in random order, on a timer or once
// enough are waiting, so an entry on the chain can't be matched to a face check by when it arrived.
//
// A flush takes everything queued, drops what is already on the list, shuffles the rest and inserts
// them one transaction at a time, deleting each from the file once the chain has it. If anything
// fails it stops, and the rest wait for the next flush. Either way it ends by rewriting the file,
// so nothing inserted stays in it.
//
// It logs counts only: never a commitment, a session, a signature or an error's message.

import { randomInt } from 'node:crypto'

import type { IssuerList } from './list.ts'
import type { Store } from './store.ts'

/** Fisher–Yates with a uniform random index; `random(n)` returns an integer in [0, n). */
export function shuffle<T>(items: readonly T[], random: (n: number) => number = randomInt): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** The kind of error, never its message: a message can carry a signature, a URL or a log. */
export const errorKind = (error: unknown) => (error instanceof Error ? error.constructor.name : typeof error)

export class Batcher {
  readonly #store: Store
  readonly #list: IssuerList
  readonly #max: number
  readonly #intervalMs: number
  readonly #log: (line: string) => void
  #timer: NodeJS.Timeout | undefined
  #running: Promise<void> | undefined
  #closed = false

  constructor(
    store: Store,
    list: IssuerList,
    options: { max: number; intervalMs: number; log?: (line: string) => void },
  ) {
    this.#store = store
    this.#list = list
    this.#max = options.max
    this.#intervalMs = options.intervalMs
    this.#log = options.log ?? ((line) => console.log(line))
  }

  /** The timer: a flush every interval, whatever is waiting. */
  start(): void {
    this.#timer = setInterval(() => void this.flush(), this.#intervalMs)
  }

  /** After each accepted commitment: flush once enough are waiting. */
  poke(): void {
    if (this.#store.count() >= this.#max) void this.flush()
  }

  /** One flush at a time: a trigger during a flush joins it. Never rejects. */
  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#running ??= this.#flush().finally(() => {
      this.#running = undefined
      // Enough arrived during the flush for another: don't make them wait for the next trigger.
      if (!this.#closed && this.#store.count() >= this.#max) void this.flush()
    })
    return this.#running
  }

  /** Resolves when no flush is running. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running
  }

  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    await this.idle()
  }

  async #flush(): Promise<void> {
    let waiting = 0
    let inserted = 0
    try {
      const pending = this.#store.queued()
      waiting = pending.length
      if (waiting === 0) return
      // Anything already on the list landed before a crash or a lost confirmation: the program
      // takes a commitment twice, so it is ours not to send it again.
      await this.#list.refresh()
      const todo = pending.filter((c) => !this.#list.has(c))
      for (const c of pending) if (this.#list.has(c)) this.#store.remove(c)
      for (const c of shuffle(todo)) {
        await this.#list.insert(c)
        this.#store.remove(c)
        inserted++
      }
      this.#log(`issuer: batch of ${inserted} inserted`)
    } catch (error) {
      this.#log(`issuer: batch stopped after ${inserted} of ${waiting} (${errorKind(error)}); the rest wait`)
    } finally {
      if (waiting > 0) {
        try {
          this.#store.compact()
        } catch (error) {
          this.#log(`issuer: the file was not rewritten (${errorKind(error)})`)
        }
      }
    }
  }
}
