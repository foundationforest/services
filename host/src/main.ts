// Soil's host: `npm start`, with the variables README.md lists.

import { readConfig, startHost } from './host.ts'

const config = readConfig()
const host = await startHost(config)
console.log(`host: forest's reference host with this service's policy, on port ${new URL(host.url).port}; registry lookup ${config.rpcUrl ? 'on' : 'off'}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0))
  })
}
