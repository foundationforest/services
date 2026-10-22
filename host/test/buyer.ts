// For the tests: what a buyer's app and a sponsor do, so the host's credits are bought, collected and
// spent as an app would. A buy is blinded with Cloudflare's privacypass-ts, unchanged; a ticket is
// signed with node:crypto's Ed25519, over the host's own `ticketMessage`.

import { generateKeyPairSync, sign } from 'node:crypto'

import { AuthenticatorInput, Token, genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad as b64u } from '@scure/base'

import { CREDIT_TYPE, PAYMENT_HEADER, challengeOf, referenceOf, ticketMessage } from '../credits/credit.ts'
import { BUY_PATH, DIRECTORY_PATH, SPEND_PATH } from '../src/credits.ts'

const { BLIND_RSA, BlindRSAMode, TokenRequest, convertRSASSAPSSToEnc } = publicVerif
const suite = () => BLIND_RSA.suite[BlindRSAMode.PSS]()
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
const importKey = (key: Uint8Array) => crypto.subtle.importKey('spki', convertRSASSAPSSToEnc(key) as Uint8Array<ArrayBuffer>, BLIND_RSA.rsaParams, true, ['verify'])

/** What a buy's credits will sign: type 2, the nonce, the challenge's digest, the key's id. */
async function inputOf(origin: string, key: Uint8Array, nonce: Uint8Array): Promise<AuthenticatorInput> {
  return new AuthenticatorInput(BLIND_RSA, CREDIT_TYPE, nonce, await sha256(challengeOf(origin).serialize()), await sha256(key))
}

/** The host's credit key, as its directory publishes it. */
export async function keyOf(url: string): Promise<Uint8Array> {
  const directory = (await (await fetch(`${url}${DIRECTORY_PATH}`)).json()) as { 'token-keys': { 'token-key': string }[] }
  return b64u.decode(directory['token-keys'][0]!['token-key'])
}

export type Buy = { bytes: Uint8Array; reference: string; finish(answer: Uint8Array): Promise<string[]> }

/** A buy of `count` credits, blinded under `key`; `finish` unblinds the host's answer into credits, each base64url. */
export async function buy(origin: string, key: Uint8Array, count: number): Promise<Buy> {
  const rsa = await importKey(key)
  const keyId = await sha256(key)
  const blinds: { input: AuthenticatorInput; inverse: Uint8Array }[] = []
  const requests = []
  for (let i = 0; i < count; i++) {
    const input = await inputOf(origin, key, crypto.getRandomValues(new Uint8Array(32)))
    const { blindedMsg, inv } = await suite().blind(rsa, input.serialize())
    requests.push(new genericBatched.TokenRequest(new TokenRequest(keyId.at(-1)!, blindedMsg, BLIND_RSA)))
    blinds.push({ input, inverse: inv })
  }
  const bytes = new genericBatched.BatchedTokenRequest(requests).serialize()
  return {
    bytes,
    reference: await referenceOf(bytes),
    async finish(answer) {
      const slots = [...genericBatched.GenericBatchTokenResponse.deserialize(new Uint8Array(answer))]
      return Promise.all(
        slots.map(async (slot, i) => {
          const response = slot.tokenResponse as InstanceType<typeof publicVerif.TokenResponse>
          const { input, inverse } = blinds[i]!
          const signature = await suite().finalize(rsa, input.serialize(), response.blindSig, inverse)
          return b64u.encode(new Token(BLIND_RSA, input, signature).serialize())
        }),
      )
    },
  }
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
  const res = await fetch(`${url}${BUY_PATH}`, { method: 'POST', headers: { 'content-type': 'application/private-token-generic-batch-request', ...(payment && { [PAYMENT_HEADER]: payment }) }, body: bytes as Uint8Array<ArrayBuffer> })
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }
}

/** Credits spent into `folder`'s balance at `url`: the status and the answer. */
export async function spend(url: string, folder: string, credits: string[]): Promise<{ status: number; body: { folder?: string; credits?: number; error?: string } }> {
  const res = await fetch(`${url}${SPEND_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder, credits }) })
  return { status: res.status, body: (await res.json()) as { folder?: string; credits?: number } }
}
