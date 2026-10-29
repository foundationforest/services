// The foundation's host: `npm start`, with the settings README.md lists.

import { readConfig, startHost } from './host.ts'

const config = readConfig()
const host = await startHost(config)
console.log(
  `host: the plug with this service's choices, on port ${new URL(host.url).port}; data in ${config.dir}; ` +
    `files ${config.files.kind === 's3' ? 'in the bucket' : 'on disk'}; ` +
    `a credit ${config.priceCents} cent${config.priceCents === 1 ? '' : 's'}, bought with a ticket from ${config.sponsors.length} sponsor${config.sponsors.length === 1 ? '' : 's'} or from a balance; ` +
    `a kilobyte ${config.rates.entry} credits on the disk and ${config.rates.file} in the bucket; an inbox entry one credit`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0))
  })
}
