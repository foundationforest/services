// The foundation's host: `npm start`, with the settings README.md lists.

import { readConfig, startHost } from './host.ts'

const config = readConfig()
const host = await startHost(config)
console.log(
  `host: the standard's reference host with this service's choices, on port ${new URL(host.url).port}; data in ${config.dir}; ` +
    `blobs ${config.blobs.kind === 's3' ? 'in the bucket' : 'on disk'}; senders' records kept ${config.senderCacheMs / 1000} s; ` +
    `a credit ${config.priceCents} cent${config.priceCents === 1 ? '' : 's'}, bought with ${config.payment ? 'a payment on Solana or ' : ''}a ticket from ${config.sponsors.length} sponsor${config.sponsors.length === 1 ? '' : 's'}; ` +
    `a write ${config.cost.floor} credits and ${config.cost.perKb} a kilobyte`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0))
  })
}
