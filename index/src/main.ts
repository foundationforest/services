// The index, from its settings (README.md, Settings):
//
//   node src/main.ts            reads every READ_SECONDS and serves the pages
//   node src/main.ts rebuild    drops everything but when each proof was first seen and the signed
//                               roots (store.ts), reads the hosts and the chain again, ranks, and
//                               exits; the next start serves what it read

import { mkdirSync } from 'node:fs'

import { startIndex } from './index.ts'
import { openStore } from './store.ts'

const env = process.env
function setting(name: string, fallback?: string): string {
  const value = env[name] ?? fallback
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}
function seconds(name: string, fallback: string): number {
  const value = Number(setting(name, fallback))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is a whole number of seconds from 1`)
  return value
}

const dataDir = setting('DATA_DIR')
const publicUrl = setting('PUBLIC_URL', 'https://index.forest.foundation')
const rpcUrl = setting('RPC_URL', 'https://api.devnet.solana.com')
if (!/^https?:\/\/[^/]+$/.test(publicUrl)) throw new Error('PUBLIC_URL is an origin, such as https://index.forest.foundation')

if (process.argv[2] === 'rebuild') {
  mkdirSync(dataDir, { recursive: true })
  const store = openStore(dataDir)
  store.drop()
  store.close()
  const index = await startIndex({ dataDir, publicUrl, rpcUrl, readSeconds: 0, port: null })
  await index.pass()
  await index.close()
  console.log('rebuilt: read the hosts and the chain again, and ranked')
} else {
  const port = Number(setting('PORT', '8080'))
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT is a port number')
  const index = await startIndex({ dataDir, publicUrl, rpcUrl, readSeconds: seconds('READ_SECONDS', '30'), port })
  console.log(`index ${index.address}, listening on ${port}`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void index.close().then(() => process.exit(0)))
}
