// Each root on chain: when a batch closes, its new root is also written to Solana as one memo that
// the issuer's key signs, besides the two files. Anyone can then read the issuer's roots from the
// chain, dated by the chain, even if the issuer's address stops answering or its file is changed.
//
// The memo is the root's line of the roots file, under its own label:
//
//   forest.foundation/issuer/root/v1\n{"root":"<decimal>","size":n,"time":ms}
//
// in one transaction the issuer's key pays for and signs: Solana's memo program (v2), with the
// key as its one signer. A reader keeps a memo only from a transaction that succeeded and that the
// issuer's key signed. The transaction is built here by hand (one instruction, a legacy message),
// so this needs no Solana library: the key signs the message bytes, which begin with the message
// header, never with the roots file's 0xff (forest/records/SPEC.md, section 1).
//
// A root is written once it is in the file, oldest first; a root that could not be written is
// tried again a minute later, and the file records each one's transaction once it is confirmed.
// It logs counts and the kind of a failure only: never a root, a signature or the RPC's words,
// since the RPC's address can hold a key.

import { base58, utf8 } from '../../forest/records/src/bytes.ts'
import { canonical } from '../../forest/records/src/canonical.ts'
import type { IssuerKey } from './key.ts'
import type { Root, Store } from './store.ts'

/** Solana's memo program, v2: it checks that every account it is given signed. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

/** Every root memo begins with this. */
export const ROOT_MEMO_LABEL = 'forest.foundation/issuer/root/v1\n'

/** The memo for one root: the label, then the root's entry in the roots file, as canonical text. */
export function rootMemo(root: Root): string {
  return ROOT_MEMO_LABEL + canonical({ root: root.root.toString(), size: root.size, time: root.time })
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
 * two accounts (the issuer's key, which pays and signs; the memo program, read only) and one
 * instruction naming the key as the memo's signer.
 */
export function memoTransaction(key: IssuerKey, memo: string, blockhash: string): Uint8Array {
  const data = utf8(memo)
  const message = Uint8Array.from([
    1, 0, 1, // one signature; no read-only signer; one read-only account unsigned (the program)
    ...compactU16(2),
    ...key.publicKey,
    ...base58.decode(MEMO_PROGRAM),
    ...base58.decode(blockhash),
    ...compactU16(1),
    1, // the program: account 1
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
 * Writes every root the file holds that is not on chain yet, oldest first, one at a time; at start,
 * after each batch (`poke`), and every `retryMs` while any is left.
 */
export class RootWriter {
  readonly #store: Store
  readonly #key: IssuerKey
  readonly #rpc: Rpc
  readonly #log: (line: string) => void
  readonly #retryMs: number
  readonly #sleep?: (ms: number) => Promise<void>
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
    let written = 0
    for (const root of this.#store.unwritten()) {
      if (this.#closed) break
      try {
        this.#store.written(root.size, await sendMemo(this.#rpc, this.#key, rootMemo(root), this.#sleep))
        written++
      } catch (error) {
        this.#log(`issuer: a root not written on chain (${kind(error)}); tried again in ${Math.round(this.#retryMs / 1000)} s`)
        break
      }
    }
    if (written) this.#log(`issuer: ${written} root${written === 1 ? '' : 's'} written on chain`)
  }
}
