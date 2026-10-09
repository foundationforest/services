// The foundation's host: `npm start`, with the variables README.md lists. The log says what the start
// moved: the old single file into the data directory, and, with a bucket, the bytes that were on disk.

import { readConfig, startHost } from './host.ts'

const config = readConfig()
const host = await startHost(config)
const { imported, toBucket } = host.moved
if (imported) {
  console.log(`host: imported ${config.importFrom} into ${config.dir}: ${imported.folders} folders, ${imported.records} records, ${imported.messages} messages, ${imported.blobs} blobs ${config.blobs.kind === 's3' ? 'into the bucket' : 'onto disk'}`)
}
if (config.blobs.kind === 's3') console.log(`host: blobs in the bucket; ${toBucket ?? 0} moved there from disk`)
console.log(
  `host: forest's reference host with this service's policy, on port ${new URL(host.url).port}; data in ${config.dir ?? 'a temporary directory'}; ` +
    `blobs ${config.blobs.kind === 's3' ? 'in the bucket' : 'on disk'}; registry lookup and payment check ${config.rpcUrl ? 'on' : 'off'}; senders' records kept ${config.senderCacheMs / 1000} s; credits at ${config.credit.price} each`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0))
  })
}
