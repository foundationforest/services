// The key holder: `npm start`, with the variables `README.md` lists.

import { readConfig, startKeyholder } from './service.ts'

const service = await startKeyholder(readConfig())
console.log(`keyholder: listening on port ${new URL(service.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
