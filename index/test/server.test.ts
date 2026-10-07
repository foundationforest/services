// The pages' server (src/web/server.ts) takes any request a client can send without stopping: a
// Host header no URL reads, a path no URL parser reads, a method a web Request refuses. Each gets
// an answer, and the server goes on. No database: the pages' handler is a stand-in.
//
//   node --test test/server.test.ts

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { test } from 'node:test'

import { serve } from '../src/web/server.ts'

/** One request as raw bytes, so what no client library would send arrives as written; the status line's code, or null if none came. */
function raw(port: number, request: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(request))
    let got = ''
    socket.on('data', (chunk) => (got += chunk.toString('latin1')))
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1]) || null))
    socket.on('error', reject)
  })
}

test('a request the pages cannot read gets an answer, and the server goes on', async () => {
  const asked: string[] = []
  const server = await serve(
    {
      handle: async (req) => {
        asked.push(new URL(req.url).pathname)
        return new Response('ok')
      },
    },
    0,
    '127.0.0.1',
  )
  const port = (server.address() as AddressInfo).port
  try {
    const cases: [string, number | null][] = [
      ['GET / HTTP/1.1\r\nHost: a b\r\n', 200],
      ['GET / HTTP/1.1\r\nHost: [\r\n', 200],
      ['GET / HTTP/1.1\r\nHost: x:99999\r\n', 200],
      ['GET // HTTP/1.1\r\nHost: x\r\n', 200],
      ['GET /\\ HTTP/1.1\r\nHost: x\r\n', 200],
      ['OPTIONS * HTTP/1.1\r\nHost: x\r\n', 200],
      ['TRACE / HTTP/1.1\r\nHost: x\r\n', 405],
      // node:http's own parser refuses TRACK: 400 before the pages are asked.
      ['TRACK / HTTP/1.1\r\nHost: x\r\n', 400],
      // node:http closes a CONNECT nobody listens for, with no answer.
      ['CONNECT x:443 HTTP/1.1\r\nHost: x:443\r\n', null],
    ]
    for (const [head, status] of cases) {
      assert.equal(await raw(port, `${head}Connection: close\r\n\r\n`), status, head.split('\r\n')[0]! + ' ' + head.split('\r\n')[1]!)
      assert.equal(await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 200, 'still answering')
    }
    // The pages see the path, never the Host header.
    assert.deepEqual([...new Set(asked)].sort(), ['/', '//'])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
