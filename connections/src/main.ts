// The connections service: `npm start`, with the variables `README.md` lists.

import { readConfig, startConnections } from './service.ts'

const service = await startConnections(readConfig())
console.log(`connections: listening on port ${new URL(service.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
