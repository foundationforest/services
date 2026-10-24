// The verifier service: `npm start`, with the variables `README.md` lists.

import { readConfig, startVerifier } from './service.ts'

const config = readConfig()
const verifier = await startVerifier(config)
// Never the seed itself: only that it was made, and where it is kept.
if (verifier.madeSeed) console.log(`verifier: no seed beside ${config.databasePath}, so a new one was made here and kept there`)
console.log(`verifier: listening on port ${new URL(verifier.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void verifier.close().then(() => process.exit(0))
  })
}
