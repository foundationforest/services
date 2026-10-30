// For the tests: what a buyer's app and a sponsor do, so the host's credits are bought, collected and
// spent as an app would. A buy is the credits client's (client/client.ts), as an app makes it; a
// ticket is signed with node:crypto's Ed25519, over the client's own `ticketMessage`.

import { generateKeyPairSync, sign } from 'node:crypto'

import { base58, base64urlnopad as b64u } from '@scure/base'

import { BUY_TYPE, PAYMENT_HEADER, buy as clientBuy, creditList, finish, ticketMessage } from '../client/client.ts'
import { BUY_PATH, DIRECTORY_PATH, SPEND_PATH } from '../src/credits.ts'

/** The host's credit key, as its directory publishes it. */
export async function keyOf(url: string): Promise<Uint8Array> {
  const directory = (await (await fetch(`${url}${DIRECTORY_PATH}`)).json()) as { 'token-keys': { 'token-key': string }[] }
  return b64u.decode(directory['token-keys'][0]!['token-key'])
}

export type Buy = { bytes: Uint8Array; reference: string; finish(answer: Uint8Array): Promise<string[]> }

/** A buy of `count` credits at the host named `origin`, blinded under `key`; `finish` unblinds the host's answer into credits, each base64url. */
export async function buy(origin: string, key: Uint8Array, count: number): Promise<Buy> {
  const b = await clientBuy({ origin, key, requestUri: BUY_PATH, unit: '', price: '' }, count)
  return { bytes: b.buy, reference: b.reference, finish: async (answer) => creditList(await finish(b.pending, answer)) }
}

/** A sponsor: its address, as SPONSORS lists it, and the tickets it signs. */
export function sponsor(): { address: string; ticket(origin: string, reference: string, count: number): string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const address = base58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
  return {
    address,
    ticket: (origin, reference, count) => `${address}.${count}.${b64u.encode(sign(null, ticketMessage(origin, reference, count), privateKey))}`,
  }
}

/** A buy collected at `url` with `payment` in the payment header: the status and the answer's bytes. */
export async function collect(url: string, bytes: Uint8Array, payment?: string): Promise<{ status: number; body: Uint8Array }> {
  const res = await fetch(`${url}${BUY_PATH}`, { method: 'POST', headers: { 'content-type': BUY_TYPE, ...(payment && { [PAYMENT_HEADER]: payment }) }, body: bytes as Uint8Array<ArrayBuffer> })
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }
}

/** Credits spent into `folder`'s balance at `url`: the status and the answer. */
export async function spend(url: string, folder: string, credits: string[]): Promise<{ status: number; body: { folder?: string; credits?: number; error?: string } }> {
  const res = await fetch(`${url}${SPEND_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder, credits }) })
  return { status: res.status, body: (await res.json()) as { folder?: string; credits?: number } }
}
