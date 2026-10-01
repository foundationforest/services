// The devnet test board: `npm start`, with the variables README.md lists.

import { readConfig, startBoard } from './board.ts'

const config = readConfig()
const board = await startBoard(config)
console.log(`board: forest's reference host for devnet testing only, as ${config.url}, on port ${new URL(board.url).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void board.close().then(() => process.exit(0))
  })
}
