// The index as one process: its key, its store, a read pass every READ_SECONDS with the ranking
// after each, and the pages. main.ts starts it from the settings; the tests start it with their own
// lists, hosts and RPC.

import { mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KINDS } from './evidence/index.ts'
import { loadLists } from './lists.ts'
import { loadMarkets } from './markets.ts'
import { runPass } from './pass.ts'
import { rpcAt } from './rpc.ts'
import { loadOrMakeKey } from './seed.ts'
import { openStore, type Store } from './store.ts'
import { serve, web, type Web } from './web.ts'

/** This directory: index/. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export type Options = {
  dataDir: string
  publicUrl: string
  rpcUrl: string
  /** Seconds between the end of one pass and the start of the next; 0 runs no passes but those asked for. */
  readSeconds: number
  /** Where lists/ and config/ are: this directory unless given. */
  listsRoot?: string
  /** The markets checkout: ../markets unless given. */
  marketsDir?: string
  /** Listen here; no server when port is null. */
  port?: number | null
  hostname?: string
  log?: (line: string) => void
}

export type Index = {
  address: string
  store: Store
  pages: Web
  /** Where it listens, once it does. */
  url: string | null
  /** One pass now, after any that is running. */
  pass(): Promise<void>
  close(): Promise<void>
}

export async function startIndex(o: Options): Promise<Index> {
  const log = o.log ?? ((line: string) => console.log(line))
  const lists = loadLists(o.listsRoot ?? ROOT)
  for (const kind of KINDS) if (!(kind.name in lists.scoring.evidence)) throw new Error(`config/scoring.json: evidence holds no weight for ${kind.name}`)
  const markets = loadMarkets(o.marketsDir ?? join(ROOT, '../markets'))
  mkdirSync(o.dataDir, { recursive: true })
  const { key, made } = await loadOrMakeKey(o.dataDir)
  if (made) log(`no seed in ${o.dataDir}, so a new one was made and kept there`)
  const store = openStore(o.dataDir)
  const ctx = { store, lists, markets, key, rpc: rpcAt(o.rpcUrl), log }
  const pages = web({ store, lists, markets, self: key.address }, o.publicUrl.replace(/\/+$/, ''), ROOT)

  let before: number | null = null
  let running: Promise<void> = Promise.resolve()
  const pass = () =>
    (running = running.then(async () => {
      const now = Date.now()
      try {
        await runPass(ctx, before, now)
        before = now
      } catch (err) {
        log(`pass failed: ${(err as Error).message}`)
      }
    }))

  let server: Server | null = null
  let url: string | null = null
  if (o.port !== null && o.port !== undefined) {
    server = await serve(pages, o.port, o.hostname ?? '0.0.0.0')
    const at = server.address()
    url = typeof at === 'object' && at ? `http://${o.hostname ?? '127.0.0.1'}:${at.port}` : null
  }

  let timer: NodeJS.Timeout | null = null
  let closed = false
  const loop = async () => {
    await pass()
    if (!closed && o.readSeconds > 0) timer = setTimeout(loop, o.readSeconds * 1000)
  }
  if (o.readSeconds > 0) void loop()

  return {
    address: key.address,
    store,
    pages,
    url,
    pass,
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      await running
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
      store.close()
    },
  }
}
