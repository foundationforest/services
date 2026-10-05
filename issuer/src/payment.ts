// The ID check's price, when it has one: paid in a dollar to one address, and found on chain.
//
// The issuer never holds the money and never reads who paid. It hands the app a payment id and the
// address that payment must name, its reference: a key mixed from the issuer's seed under
// `reference/<id>` (key.ts), so only whoever holds the id can claim a payment that names it, and the
// id never goes on chain. The person's transfer pays `ID_TIER_PAY_TO` and lists the reference as one
// more account, as Solana Pay does. To see whether it landed, the issuer asks its RPC for the
// finalized transactions that name the reference (`getSignaturesForAddress`), and reads each one
// (`getTransaction`): what the receiving address's token accounts in the dollar held after it, less
// what they held before, must be at least the price. Two JSON-RPC calls; nothing else.

/** The price, in the dollar's smallest unit, the dollar's mint, and the address that receives it. */
export type Price = { amount: bigint; mint: string; payTo: string }

export interface Payments {
  /**
   * The signature of every finalized transaction that names `reference` and paid at least the price,
   * newest first; none yet is an empty list. Throws if the RPC can't answer.
   */
  landed(reference: string): Promise<string[]>
}

/** The RPC could not be asked, or answered something else. Its message carries no reference or URL. */
export class PaymentCheckUnavailable extends Error {}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
type Transaction = { meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null }

/** What `owner`'s token accounts in `mint` gained in this transaction. */
export function received(tx: Transaction, owner: string, mint: string): bigint {
  const sum = (balances: TokenBalance[] | undefined) =>
    (balances ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n)
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances)
}

export class RpcPayments implements Payments {
  readonly #rpcUrl: string
  readonly #price: Price

  constructor(options: { rpcUrl: string; price: Price }) {
    this.#rpcUrl = options.rpcUrl
    this.#price = options.price
  }

  async landed(reference: string): Promise<string[]> {
    const named = (await this.#call('getSignaturesForAddress', [reference, { commitment: 'finalized', limit: 20 }])) as { signature: string; err: unknown }[]
    const paid: string[] = []
    for (const { signature, err } of named) {
      if (err !== null) continue
      const tx = (await this.#call('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }])) as Transaction | null
      if (tx?.meta && tx.meta.err === null && received(tx, this.#price.payTo, this.#price.mint) >= this.#price.amount) paid.push(signature)
    }
    return paid
  }

  async #call(method: string, params: unknown[]): Promise<unknown> {
    let answer: { result?: unknown; error?: unknown }
    try {
      const res = await fetch(this.#rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
      answer = (await res.json()) as typeof answer
    } catch {
      // The error may carry the RPC's URL, which may carry its key: it is not passed on.
      throw new PaymentCheckUnavailable('the RPC could not be reached')
    }
    if (answer.error !== undefined || !('result' in answer)) throw new PaymentCheckUnavailable(`the RPC refused ${method}`)
    if (method === 'getSignaturesForAddress' && !Array.isArray(answer.result)) throw new PaymentCheckUnavailable('the RPC answered no list')
    return answer.result
  }
}
