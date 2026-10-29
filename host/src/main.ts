// The foundation's host: `npm start`, with the settings README.md lists.

import { readConfig, startHost } from './host.ts'

const config = readConfig()
const host = await startHost(config)
console.log(
  `host: the plug with this service's choices, on port ${new URL(host.url).port}; data in ${config.dir}; ` +
    `files ${config.files.kind === 's3' ? 'in the bucket' : 'on disk'}; ` +
    `a credit ${config.priceCents} cent${config.priceCents === 1 ? '' : 's'}, bought with a ticket from ${config.sponsors.length} sponsor${config.sponsors.length === 1 ? '' : 's'}; ` +
    `a write ${config.cost.floor} credits and ${config.cost.perKb} a kilobyte`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0))
  })
}
