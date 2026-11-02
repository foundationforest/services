// The standard's host check (@foundationforest/folders/check), unchanged, against any host's
// address, with this host's payment for inbox entries: `SEED=<64 hex characters> npm run check-host
// -- https://host.example`. As the standard's own script (standard/folders/scripts/check-host.ts),
// it writes from check/a and check/b, of a new seed or of SEED's, whose folders a host that charges
// must hold credits; and it pays for each inbox entry it leaves from check/b's balance at that
// host, signed by check/b's main key. Each check prints ok, unchecked (what the host refused by its
// own choice stopped it) or FAILED; it exits 1 if any failed.

import { fileURLToPath } from 'node:url'

import { type Payment, decodeInbox, hex } from '@foundationforest/folders'
import { CHECK_LABELS, checkHost } from '@foundationforest/folders/check'
import { mainKey } from '@foundationforest/keys'

import { inboxPayment } from './client/client.ts'

const isInbox = (line: string) => {
  try {
    decodeInbox(line)
    return true
  } catch {
    return false
  }
}

/**
 * The check's payment: for a request of inbox entries only, each paid from check/b's balance there,
 * signed by its main key; nothing for any other request, whose lines a host refuses before any
 * price.
 */
export async function checkPayment(seed: Uint8Array): Promise<Payment> {
  const pay = inboxPayment(await mainKey(seed, CHECK_LABELS[1]))
  return (host, body) => {
    const lines = new TextDecoder().decode(body).split('\n').filter(Boolean)
    return lines.length && lines.every(isInbox) ? pay(host, body) : undefined
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2]
  if (!url) {
    console.error('npm run check-host -- <the host’s address>')
    process.exit(2)
  }
  const seed = process.env.SEED ? hex.decode(process.env.SEED) : crypto.getRandomValues(new Uint8Array(32))
  const results = await checkHost(url, { seed, payment: await checkPayment(seed) })
  for (const r of results) console.log(`${r.status === 'failed' ? 'FAILED' : r.status}: ${r.name}${r.why ? `. ${r.why}` : ''}`)
  process.exit(results.some((r) => r.status === 'failed') ? 1 : 0)
}
