// The voucher check, the fee payer's front: `npm start`, with the variables fee-payer/README.md
// lists. deploy/start.sh starts it beside the two Koras.

import { readConfig, startFront } from './vouchers.ts'

const service = await startFront(readConfig())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
