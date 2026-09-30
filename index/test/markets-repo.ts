// A stand-in for the `markets` repo, for the tests: a local HTTP server that serves the files under
// `test/markets/` the way raw.githubusercontent.com serves the repo's own, so the index reads its
// directory through the same fetch it uses for the real one.

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, normalize } from 'node:path'

import { INDEX_ROOT } from '../src/config.ts'

export const MARKETS_FOLDER = join(INDEX_ROOT, 'test/markets')

/** Serves `folder` at a local URL until `close`. A path outside it, or a missing file, answers 404. */
export async function serveMarkets(folder: string = MARKETS_FOLDER): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const path = normalize(join(folder, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)))
    try {
      if (!path.startsWith(folder + '/')) throw new Error('outside')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(await readFile(path))
    } catch {
      res.writeHead(404).end('404: Not Found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}
