// The registry payer's front: `npm start`, with the variables fee-payer/README.md lists.
// deploy/registry.sh starts it beside its Kora.

import { readConfig, startFront } from './payer.ts'

const service = await startFront(await readConfig())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
