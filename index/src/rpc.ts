// Solana's JSON-RPC, by POST to RPC_URL: the only chain this index reads. Two methods are asked,
// getSignaturesForAddress and getTransaction, always at `finalized`.

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

/** The RPC at `url`. A failed request, or an RPC error, throws. */
export function rpcAt(url: string, timeoutMs = 30_000): Rpc {
  let id = 0
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`the RPC answered ${res.status} to ${method}`)
    const answer = (await res.json()) as { result?: unknown; error?: { message?: string } }
    if (answer.error) throw new Error(`the RPC refused ${method}: ${answer.error.message ?? 'no reason given'}`)
    return answer.result ?? null
  }
}

/** One transaction as getTransaction gives it, the parts this index reads. */
export type Transaction = {
  blockTime: number | null
  meta: {
    err: unknown
    logMessages?: string[] | null
    preTokenBalances?: TokenBalance[] | null
    postTokenBalances?: TokenBalance[] | null
  } | null
}
export type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }

/** A transaction by its signature, at finalized; null when the RPC holds none. */
export async function transaction(rpc: Rpc, signature: string): Promise<Transaction | null> {
  return (await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])) as Transaction | null
}
