// Each batch on chain: when a batch closes, its new root and its new members are also written to
// Solana, in notes the issuer's key signs, besides the two files. Anyone can then read the
// issuer's roots and rebuild its whole list from the chain alone, dated by the chain, even if the
// issuer's address stops answering or its files are changed.
//
// A note is the root's line of the roots file with a run of the batch's new members, in list
// order, from list position `from`, under its own label:
//
//   forest.foundation/issuer/root/v2\n{"commitments":["<decimal>",…],"from":n,"root":"<decimal>","size":n,"time":ms}
//
// A batch whose members do not fit in one note is cut into as few as fit, each with the root's line
// again, so every note reads alone. Each goes in its own transaction the issuer's key pays for and
// signs: Solana's memo program (v2), with the key as its one signer, after one instruction raising
// the transaction's compute limit, since the memo program spends about 350 units a byte and a full
// note takes more than the default 200,000. No compute price is set, so the fee stays 5,000
// lamports. A reader keeps a note only from a transaction that succeeded and that the issuer's key
// signed. The transaction is built here by hand (two instructions, a legacy message), so this needs
// no Solana library: the key signs the message bytes, which begin with the message header, never
// with the roots file's 0xff (forest/records/SPEC.md, section 1). Version 1 of the label held the
// root's line alone.
//
// A batch is written once it is in the file, oldest first, one note at a time; a note that could
// not be written is tried again a minute later, from that note on, and the file records each
// batch's transactions once all its notes are confirmed. It logs counts and the kind of a failure
// only: never a root, a member, a signature or the RPC's words, since the RPC's address can hold a
// key.

import { base58, utf8 } from '../../forest/records/src/bytes.ts'
import { canonical, parseCanonical } from '../../forest/records/src/canonical.ts'
import type { IssuerKey } from './key.ts'
import type { Root, Store } from './store.ts'

/** Solana's memo program, v2: it checks that every account it is given signed. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

/** Solana's compute budget program: its one instruction here sets the transaction's compute limit. */
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

/**
 * The compute limit a note's transaction sets. Measured on devnet on 2026-10-01: the memo program
 * takes 84,069 units for a 195-byte note and about 351 more a byte, so a note of `NOTE_MAX_BYTES`
 * takes about 374,000; this leaves a quarter more. It costs nothing while no price is set.
 */
export const NOTE_COMPUTE_UNITS = 500_000

/** Every note begins with this. */
export const NOTE_LABEL = 'forest.foundation/issuer/root/v2\n'

/**
 * The longest note, in bytes: a transaction is at most 1,232 bytes, and the rest of the issuer's
 * (one signature, three accounts, a blockhash, the compute limit's instruction, the memo
 * instruction's header and a two-byte length) takes 211.
 */
export const NOTE_MAX_BYTES = 1232 - 211

/** One note: the root's line of the roots file, and `commitments`, the members from list position `from`. */
function note(root: Root, from: number, commitments: bigint[]): string {
  return NOTE_LABEL + canonical({ commitments: commitments.map(String), from, root: root.root.toString(), size: root.size, time: root.time })
}

/**
 * A batch's notes: its new members, at list positions `from` up to the root's size, in order, cut
 * into as few notes as fit in `NOTE_MAX_BYTES`, each the root's line with its run of members.
 */
export function batchNotes(root: Root, from: number, members: bigint[]): string[] {
  if (members.length === 0 || from + members.length !== root.size) throw new Error("a batch's members must end at its root's size")
  const notes: string[] = []
  for (let at = 0; at < members.length; ) {
    let n = 1
    while (at + n < members.length && utf8(note(root, from + at, members.slice(at, at + n + 1))).length <= NOTE_MAX_BYTES) n++
    notes.push(note(root, from + at, members.slice(at, at + n)))
    at += n
  }
  return notes
}

/** A note's parts, or it throws: one root, and its run of members from list position `from`. */
export type Note = { root: Root; from: number; commitments: bigint[] }

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

/** A note's text read back: the label, then canonical text with exactly its five fields. Throws with why. */
export function parseNote(text: string): Note {
  if (!text.startsWith(NOTE_LABEL)) throw new Error('not a note')
  const body = text.slice(NOTE_LABEL.length)
  const value = parseCanonical(body) as Record<string, unknown>
  if (canonical(value) !== body) throw new Error('not canonical text')
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'commitments,from,root,size,time') throw new Error('not a note')
  const { commitments, from, root, size, time } = value
  if (!Array.isArray(commitments) || commitments.length === 0 || !commitments.every((c) => typeof c === 'string' && DECIMAL.test(c))) throw new Error('its members are not decimal text')
  if (typeof root !== 'string' || !DECIMAL.test(root)) throw new Error('its root is not decimal text')
  if (!whole(from) || !whole(size) || !whole(time)) throw new Error('its numbers are not whole')
  if (from + commitments.length > size) throw new Error('its members run past its root')
  return { root: { root: BigInt(root), size, time }, from, commitments: commitments.map(BigInt) }
}

/** Solana's compact length: seven bits a byte, low first. */
function compactU16(n: number): number[] {
  const out: number[] = []
  for (;;) {
    const low = n & 0x7f
    n >>= 7
    if (n === 0) return [...out, low]
    out.push(low | 0x80)
  }
}

/**
 * The memo transaction, signed, as it goes on the wire: one signature, then a legacy message with
 * three accounts (the issuer's key, which pays and signs; the memo program and the compute budget
 * program, read only) and two instructions: the compute limit, `NOTE_COMPUTE_UNITS`; then the memo,
 * naming the key as its signer.
 */
export function memoTransaction(key: IssuerKey, memo: string, blockhash: string): Uint8Array {
  const data = utf8(memo)
  const limit = new Uint8Array(4)
  new DataView(limit.buffer).setUint32(0, NOTE_COMPUTE_UNITS, true)
  const message = Uint8Array.from([
    1, 0, 2, // one signature; no read-only signer; two read-only accounts unsigned (the programs)
    ...compactU16(3),
    ...key.publicKey,
    ...base58.decode(MEMO_PROGRAM),
    ...base58.decode(COMPUTE_BUDGET_PROGRAM),
    ...base58.decode(blockhash),
    ...compactU16(2),
    2, // the compute budget program: account 2
    ...compactU16(0),
    ...compactU16(5),
    2, // SetComputeUnitLimit
    ...limit,
    1, // the memo program: account 1
    ...compactU16(1),
    0, // its one account: the issuer's key
    ...compactU16(data.length),
    ...data,
  ])
  return Uint8Array.from([...compactU16(1), ...key.sign(message), ...message])
}

/** The RPC answered with an error, or not at all. */
export class RpcUnavailable extends Error {}
/** The transaction landed and failed. */
export class MemoFailed extends Error {}
/** The transaction's blockhash ran out before it was confirmed: it can no longer land. */
export class MemoExpired extends Error {}

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>

function rpcClient(url: string, get: typeof fetch): Rpc {
  return async <T>(method: string, params: unknown[]) => {
    let body: { result?: T; error?: unknown }
    try {
      const res = await get(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      body = (await res.json()) as typeof body
    } catch {
      throw new RpcUnavailable()
    }
    if (body.error !== undefined || body.result === undefined) throw new RpcUnavailable()
    return body.result
  }
}

/** Send one memo and wait for it: its signature once confirmed, or it throws. */
export async function sendMemo(
  rpc: Rpc,
  key: IssuerKey,
  memo: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const { value } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const wire = memoTransaction(key, memo, value.blockhash)
  const signature = await rpc<string>('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }])
  for (;;) {
    const statuses = await rpc<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>('getSignatureStatuses', [[signature]])
    const status = statuses.value[0]
    if (status?.err) throw new MemoFailed()
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
    if (!status && (await rpc<number>('getBlockHeight', [{ commitment: 'confirmed' }])) > value.lastValidBlockHeight) throw new MemoExpired()
    await sleep(1000)
  }
}

/** The kind of a failure, never its message. */
const kind = (error: unknown) => (error instanceof Error ? error.constructor.name : typeof error)

/**
 * Writes every batch the file holds that is not on chain yet, oldest first, one note at a time; at
 * start, after each batch (`poke`), and every `retryMs` while any is left.
 */
export class RootWriter {
  readonly #store: Store
  readonly #key: IssuerKey
  readonly #rpc: Rpc
  readonly #log: (line: string) => void
  readonly #retryMs: number
  readonly #sleep?: (ms: number) => Promise<void>
  /** The notes of a batch confirmed so far, by its root's size, until the whole batch is. */
  readonly #sent = new Map<number, string[]>()
  #timer: NodeJS.Timeout | undefined
  #running: Promise<void> | undefined
  #again = false
  #closed = false

  constructor(
    store: Store,
    key: IssuerKey,
    options: { rpcUrl: string; log?: (line: string) => void; retryMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> },
  ) {
    this.#store = store
    this.#key = key
    this.#rpc = rpcClient(options.rpcUrl, options.fetch ?? fetch)
    this.#log = options.log ?? ((line) => console.log(line))
    this.#retryMs = options.retryMs ?? 60_000
    this.#sleep = options.sleep
  }

  start(): void {
    this.#timer = setInterval(() => void this.poke(), this.#retryMs)
    void this.poke()
  }

  /** Write what is waiting. A poke during a run makes the run go round once more. Never rejects. */
  poke(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      do {
        this.#again = false
        await this.#write()
      } while (this.#again && !this.#closed)
    })().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async idle(): Promise<void> {
    while (this.#running) await this.#running
  }

  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    await this.idle()
  }

  async #write(): Promise<void> {
    let roots = 0
    let notes = 0
    for (const root of this.#store.unwritten()) {
      if (this.#closed) break
      const sent = this.#sent.get(root.size) ?? []
      this.#sent.set(root.size, sent)
      let texts: string[]
      try {
        texts = batchNotes(root, root.from, this.#store.between(root.from, root.size))
        while (sent.length < texts.length && !this.#closed) {
          sent.push(await sendMemo(this.#rpc, this.#key, texts[sent.length]!, this.#sleep))
          notes++
        }
      } catch (error) {
        this.#log(`issuer: a note not written on chain (${kind(error)}); tried again in ${Math.round(this.#retryMs / 1000)} s`)
        break
      }
      if (sent.length < texts.length) break
      this.#store.written(root.size, sent)
      this.#sent.delete(root.size)
      roots++
    }
    if (notes) this.#log(`issuer: ${notes} note${notes === 1 ? '' : 's'} written on chain, ${roots} root${roots === 1 ? '' : 's'} complete`)
  }
}
