// The devnet test host: `npm start`, with the variables README.md lists.

import { readConfig, startHost } from './host.ts'

const host = await startHost(readConfig())
console.log(`host: forest's reference host for devnet testing only, on port ${new URL(host.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0))
  })
}
