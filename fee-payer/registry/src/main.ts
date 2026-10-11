// The registry payer: `npm start`, with the variables its README lists.

import { readConfig, startFront } from './payer.ts'

const service = await startFront(await readConfig())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
