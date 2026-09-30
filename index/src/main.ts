// The index runs as two processes that share one database (HOSTING.md):
//
//   node src/main.ts readers   always on: migrations, both readers, the recompute; the only one
//                              that holds the signing seed and writes. No port.
//   node src/main.ts web       the pages and their twins: reads the database, never writes, holds
//                              no seed; as many copies as needed.
//   node src/main.ts           both in one process, for running locally (`npm start`).
//
// `startIndex` runs both in one process; the tests start it with their own settings.

import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'

import { ChainReader, type Program } from './chain/poll.ts'
import { ESCROW_PROGRAM_ID } from './chain/escrow.ts'
import { REGISTRY_PROGRAM_ID } from './chain/registry.ts'
import { type Config, loadConfig } from './config.ts'
import { type Db, createPool, migrate } from './db.ts'
import { Directory } from './markets.ts'
import { type RecordReader, startRecordReader } from './records/firehose.ts'
import type { Outcome } from './records/store.ts'
import { Scorer, recompute } from './scores/run.ts'
import { indexKeys, publicKeys } from './scores/sign.ts'
import { type Web, createWeb } from './web/routes.ts'
import { serve } from './web/server.ts'

type Opts = {
  onError?: (err: unknown) => void
  onRecord?: (uri: string, outcome: Outcome) => void
}

async function loadDirectory(config: Config, onError: (err: unknown) => void): Promise<Directory> {
  const directory = await Directory.fetch(config.marketsUrl)
  for (const r of directory.refused) onError(new Error(`market file ${r.file} refused: ${r.errors.join('; ')}`))
  return directory
}

export type Readers = { directory: Directory; scorer: Scorer; chain: ChainReader | null; records: RecordReader | null; stop: () => Promise<void> }

/** Migrations, the public keys for the pages, both readers and the recompute, on `db`. */
export async function startReaders(db: Db, config: Config, opts: Opts = {}): Promise<Readers> {
  const onError = opts.onError ?? ((err: unknown) => console.error(err))
  if (!config.signingSeed) throw new Error('the readers sign scores: INDEX_SIGNING_SEED is required')
  await migrate(db)
  const directory = await loadDirectory(config, onError)
  const keys = indexKeys(config.signingSeed)
  await db.query(
    `insert into index_meta (key, value) values ('publicKeys', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(publicKeys(keys))],
  )

  const scorer = new Scorer(() => recompute(db, { directory, config, keys }))
  scorer.onError = onError
  await scorer.now()

  const records = config.firehoseUrl
    ? await startRecordReader({
        db,
        firehoseUrl: config.firehoseUrl,
        plcUrl: config.plcUrl,
        onChange: () => scorer.schedule(),
        onError,
        onRecord: opts.onRecord,
      })
    : null

  let chain: ChainReader | null = null
  if (config.rpcUrl) {
    const programs: Program[] = [
      { id: config.registryProgramId ?? REGISTRY_PROGRAM_ID, kind: 'registry' },
      { id: config.escrowProgramId ?? ESCROW_PROGRAM_ID, kind: 'escrow' },
    ]
    chain = new ChainReader(db, config.rpcUrl, programs, () => scorer.schedule(), config.chainCommitment, onError)
    chain.start(config.chainPollMs)
  }

  return {
    directory,
    scorer,
    chain,
    records,
    stop: async () => {
      chain?.stop()
      await records?.stop()
      scorer.stop()
    },
  }
}

/** The pages on `db`, served on `config.port` unless `listen` is false. Reads only. */
export async function startWeb(db: Db, config: Config, opts: Opts & { listen?: boolean } = {}): Promise<{ web: Web; server: Server | null }> {
  const directory = await loadDirectory(config, opts.onError ?? ((err: unknown) => console.error(err)))
  const web = createWeb({ db, directory, config })
  const server = opts.listen === false ? null : await serve(web, config.port)
  return { web, server }
}

export type RunningIndex = Readers & { db: Db; web: Web; server: Server | null }

/** Both in one process, sharing one pool. */
export async function startIndex(config: Config, opts: Opts & { listen?: boolean } = {}): Promise<RunningIndex> {
  const db = createPool(config.databaseUrl)
  const readers = await startReaders(db, config, opts)
  const { web, server } = await startWeb(db, config, opts)
  return {
    ...readers,
    db,
    web,
    server,
    stop: async () => {
      await readers.stop()
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
      await db.end()
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const role = process.argv[2] ?? 'all'
  if (!['all', 'readers', 'web'].includes(role)) throw new Error(`usage: node src/main.ts [readers|web]; got ${role}`)
  const config = loadConfig(process.env, { seed: role !== 'web' })
  const db = createPool(config.databaseUrl)
  const stops: (() => Promise<void>)[] = []
  if (role !== 'web') stops.push((await startReaders(db, config)).stop)
  if (role !== 'readers') {
    const { server } = await startWeb(db, config)
    stops.push(() => new Promise<void>((resolve) => server!.close(() => resolve())))
    console.log(`pages on :${config.port}, published as ${config.publicUrl}`)
  }
  if (role === 'readers') console.log('readers running')
  const shutdown = async () => {
    for (const stop of stops) await stop()
    await db.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
