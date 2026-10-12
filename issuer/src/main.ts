// The issuer service: `npm start`, with the variables `README.md` lists.

import { readConfig, startIssuer } from './service.ts'

const config = readConfig()
const issuer = await startIssuer(config)
// Never the key itself: only that it was made, and where it is kept.
if (issuer.madeKey) console.log(`issuer: no key beside ${config.databasePath}, so a new one was made here and kept there`)
console.log(`issuer: listening on port ${new URL(issuer.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void issuer.close().then(() => process.exit(0))
  })
}
