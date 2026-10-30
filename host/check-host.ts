// The standard's host check (@foundationforest/folders/check), unchanged, against any host's
// address, with this host's payment for inbox entries: `SEED=<64 hex characters> npm run check-host
// -- https://host.example`. As the standard's own script (standard/folders/scripts/check-host.ts),
// it writes from check/a and check/b, of a new seed or of SEED's, whose folders a host that charges
// must hold credits; and it pays for each inbox entry it leaves with one credit, bought from
// check/b's balance at that host, signed by check/b's main key. Each check prints ok, unchecked
// (what the host refused by its own choice stopped it) or FAILED; it exits 1 if any failed.

import { fileURLToPath } from 'node:url'

import { type Payment, decodeInbox, hex } from '@foundationforest/folders'
import { CHECK_LABELS, checkHost } from '@foundationforest/folders/check'
import { mainKey } from '@foundationforest/keys'

import { balancePayment, bought, creditsPayment, serviceAt } from './client/client.ts'

const isInbox = (line: string) => {
  try {
    decodeInbox(line)
    return true
  } catch {
    return false
  }
}

/**
 * The check's payment: at a host that sells credits, for a request of inbox entries only, a credit
 * for each, bought from check/b's balance there; nothing for any other request, so a line the host
 * must refuse before its price wastes no credit.
 */
export async function checkPayment(seed: Uint8Array): Promise<Payment> {
  const b = await mainKey(seed, CHECK_LABELS[1])
  return async (host, body) => {
    const lines = new TextDecoder().decode(body).split('\n').filter(Boolean)
    if (!lines.length || !lines.every(isInbox)) return undefined
    const service = await serviceAt(host)
    return service ? creditsPayment(await bought(service, lines.length, (reference, n) => balancePayment(host, b, reference, n))) : undefined
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
