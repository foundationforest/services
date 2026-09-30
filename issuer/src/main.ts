// The issuer service: `npm start`, with the variables `README.md` lists.

import { readConfig, startIssuer } from './service.ts'

const issuer = await startIssuer(readConfig())
console.log(`issuer: listening on port ${new URL(issuer.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void issuer.close().then(() => process.exit(0))
  })
}
