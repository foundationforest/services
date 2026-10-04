// The pre-check: `npm start`, with the variables fee-payer/README.md lists. deploy/start.sh starts it
// beside the sponsored Kora.

import { readConfig, startSponsor } from './sponsor.ts'

const service = await startSponsor(readConfig())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
