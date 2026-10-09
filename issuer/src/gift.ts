// The welcome gift: at a person's first note, the issuer pays for credits their app buys at the
// services its settings name, a few registrations at the registry payer and writes at the host.
//
// The app makes each buy (forest's credits, `buy`) and keeps what finishes it; it sends the issuer
// each buy's pay link, and the issuer pays them all in one transaction, from its `credits` key
// (key.ts). It sees each buy's reference and amount, never the credits: the service signs them
// blind. A link is paid only if it is exactly the link forest's credits writes for that service's
// directory, the count the issuer gives and the buy's reference: the service's address, token and
// price, and the amount for that count. Anything else is `bad_gift`, and nothing is paid.

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import { Connection, PublicKey, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError, type TransactionInstruction } from '@solana/web3.js'

import { type Service, DIRECTORY_PATH, amountOf, serviceOf } from '../../standard/credits/src/index.ts'
import { base58 } from '../../standard/records/src/bytes.ts'
import type { IssuerKey } from './key.ts'

/** One service in the gift: where it is, and how many of its credits the issuer pays for. */
export type GiftService = { origin: string; credits: number }
/** The gift, by what each service is to the person's app: `registryPayer`, `host`. */
export type Gift = Record<string, GiftService>

/** One transfer the gift pays: to a service's address, in its token (or SOL), the amount in whole units, naming the buy's reference. */
export type Part = { address: string; mint: string; amount: string; reference: string }

export interface Payer {
  /**
   * Pays every part in one transaction. Its signature once it is confirmed, or once it was sent and
   * may yet land; null only when nothing was paid: it was never sent, it failed, or its blockhash
   * passed with it not landed.
   */
  pay(parts: Part[]): Promise<string | null>
}

/** A service's directory, read at its origin. */
export type Directory = (origin: string) => Promise<unknown>

export const readDirectory: Directory = async (origin) => {
  const res = await fetch(`${origin}${DIRECTORY_PATH}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`the directory answered ${res.status}`)
  return res.json()
}

/** The pay link forest's credits (`buy`) writes for `count` credits of `service`, naming `reference`. */
export function payLinkOf(service: Service, count: number, reference: string): string {
  return (
    `solana:${service.address}?amount=${amountOf(service.price, count)}` +
    (service.mint === 'SOL' ? '' : `&spl-token=${service.mint}`) +
    `&reference=${reference}&label=${encodeURIComponent(new URL(service.origin).host)}`
  )
}

function isReference(text: string): boolean {
  try {
    return base58.decode(text).length === 32
  } catch {
    return false
  }
}

/**
 * What the gift pays, from the app's links, one for each service in the gift and no other: each
 * checked against the link the issuer would write, from the service's directory. `bad_gift` for a
 * link that is not that one; `gift_unavailable` when a directory cannot be read.
 */
export async function partsOf(gift: Gift, links: Record<string, unknown>, directory: Directory): Promise<Part[] | 'bad_gift' | 'gift_unavailable'> {
  const roles = Object.keys(gift).sort()
  if (Object.keys(links).sort().join() !== roles.join()) return 'bad_gift'
  const parts: Part[] = []
  for (const role of roles) {
    const link = links[role]
    const { origin, credits } = gift[role]!
    const reference = typeof link === 'string' ? /[?&]reference=([^&]+)/.exec(link)?.[1] : undefined
    if (!reference || !isReference(reference)) return 'bad_gift'
    let service: Service
    try {
      service = serviceOf(origin, await directory(origin))
    } catch {
      return 'gift_unavailable'
    }
    if (link !== payLinkOf(service, credits, reference)) return 'bad_gift'
    parts.push({ address: service.address, mint: service.mint, amount: amountOf(service.price, credits), reference })
  }
  return parts
}

/** `amount`, decimal text in whole units, in base units of `decimals`; throws if it has more decimal places. */
function units(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > decimals) throw new Error('more decimal places than the token has')
  return BigInt(whole! + fraction.padEnd(decimals, '0'))
}

/** The gift's payer on Solana: a key that holds the dollars and the SOL for the fee, through an RPC. */
export class RpcPayer implements Payer {
  readonly #key: IssuerKey
  readonly #connection: Connection

  constructor(rpcUrl: string, key: IssuerKey) {
    this.#key = key
    this.#connection = new Connection(rpcUrl, 'confirmed')
  }

  async pay(parts: Part[]): Promise<string | null> {
    const payer = new PublicKey(this.#key.publicKey)
    let sent: { signature: string; blockhash: string; lastValidBlockHeight: number }
    try {
      const instructions: TransactionInstruction[] = []
      for (const part of parts) instructions.push(...(await transfer(this.#connection, payer, part)))
      const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash('confirmed')
      const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...instructions)
      tx.addSignature(payer, Buffer.from(this.#key.sign(tx.serializeMessage())))
      sent = { signature: await this.#connection.sendRawTransaction(tx.serialize()), blockhash, lastValidBlockHeight }
    } catch {
      // Refused before it was sent, or never sent: nothing was paid.
      return null
    }
    try {
      const { value } = await this.#connection.confirmTransaction(sent, 'confirmed')
      return value.err === null ? sent.signature : null
    } catch (error) {
      // Past its blockhash, it can no longer land. Anything else, it may yet: the gift stays given.
      return error instanceof TransactionExpiredBlockheightExceededError ? null : sent.signature
    }
  }
}

/**
 * One part's instructions: the service's token account, made if it is not there, then a transfer to
 * it naming the reference as one more account, read-only, as Solana Pay does. In SOL, the transfer
 * alone. The token's program and decimals are read from its mint.
 */
export async function transfer(connection: Pick<Connection, 'getAccountInfo'>, payer: PublicKey, part: Part): Promise<TransactionInstruction[]> {
  const to = new PublicKey(part.address)
  const reference = { pubkey: new PublicKey(part.reference), isSigner: false, isWritable: false }
  if (part.mint === 'SOL') {
    const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: units(part.amount, 9) })
    ix.keys.push(reference)
    return [ix]
  }
  const mint = new PublicKey(part.mint)
  const program = (await connection.getAccountInfo(mint))?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const { decimals } = await getMint(connection as Connection, mint, 'confirmed', program)
  const from = getAssociatedTokenAddressSync(mint, payer, false, program)
  const into = getAssociatedTokenAddressSync(mint, to, true, program)
  const ix = createTransferCheckedInstruction(from, mint, into, payer, units(part.amount, decimals), decimals, [], program)
  ix.keys.push(reference)
  return [createAssociatedTokenAccountIdempotentInstruction(payer, into, to, mint, program), ix]
}
