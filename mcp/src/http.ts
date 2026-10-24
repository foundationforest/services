// The few ways this copy answers over HTTP, and how it reads a request's body.

import type { IncomingMessage, ServerResponse } from 'node:http'

/** A body larger than a request may carry. */
export class TooLarge extends Error {}

/** The request's body as text, up to `max` bytes. */
export async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) throw new TooLarge(`a body of more than ${max} bytes`)
    parts.push(chunk as Buffer)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** JSON, with `headers`. */
export function json(res: ServerResponse, status: number, body: unknown, headers: { [name: string]: string } = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}

/** A page a person reads, in plain words. */
export function page(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(`${text}\n`)
}
