// What the read tools do with an index: read what it says, and pass it on whole, as its own word.
// Nothing is kept between calls: every call reads again what it needs. No tool here signs, and none
// reads a host: what acts for a person goes to their app, over the live link (link.ts).
//
// Nothing here checks what an index says, and nothing here names a field of it, so an index can
// change what it shows, or another index show other things, and this copy passes it on the same.

import { type Body, READ_TIMEOUT_MS } from '@foundationforest/records'

/** A plain refusal: what could not be done, and why, in words a person reads. */
export class Refusal extends Error {
  override name = 'Refusal'
}
export function refuse(why: string): never {
  throw new Refusal(why)
}

/** The foundation's index, whose answers are passed on unless told otherwise. */
export const INDEX = 'https://index.forest.foundation'
/** The most of an index's answer read: a page's worth on this repo's host. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024

/** What reading starts with: the index whose answers it passes on. */
export type Context = { index: string }

export const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value)

/** What a URL answers, read up to `max` bytes, with `fetchWith`. */
async function readBytes(url: string, fetchWith: typeof fetch, max: number, timeout: number): Promise<Buffer> {
  const res = await fetchWith(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`answered ${res.status}`)
  }
  const parts: Uint8Array[] = []
  let size = 0
  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(parts)
    size += value.length
    if (size > max) {
      await reader.cancel()
      throw new Error(`sent more than ${max} bytes`)
    }
    parts.push(value)
  }
}

/** JSON from a URL, read up to `max` bytes, with `fetchWith`. */
export async function readJson(url: string, fetchWith: typeof fetch = fetch, max = MAX_ANSWER_BYTES, timeout = READ_TIMEOUT_MS): Promise<unknown> {
  return JSON.parse((await readBytes(url, fetchWith, max, timeout)).toString('utf8'))
}

/** Whose word an index's answer is, as the AI is shown it beside the answer. */
export const WORD = "the index's own, passed on whole and unchecked"

/** What an index said at a URL: its answer, untouched, or why it said nothing. Never spread into one object, so no field of the index's can stand for one of these. */
export type Said = { url: string; word: string } & ({ answer: unknown } | { unread: string })

const at = (ctx: Context, path: string) => `${ctx.index.replace(/\/+$/, '')}/${path}`

/** What the index says at `path`, untouched, as JSON or as text, with where it was read; refused when it says nothing. */
export async function fromIndex(ctx: Context, path: string, as: 'json' | 'text' = 'json'): Promise<Said> {
  const url = at(ctx, path)
  try {
    const answer = as === 'json' ? await readJson(url) : (await readBytes(url, fetch, MAX_ANSWER_BYTES, READ_TIMEOUT_MS)).toString('utf8')
    return { url, word: WORD, answer }
  } catch (err) {
    return refuse(`the index gave nothing for ${url}: ${(err as Error).message}`)
  }
}

/** The same, or why the index said nothing, so a down index never hides what the markets gave. */
export async function indexSays(ctx: Context, path: string, as: 'json' | 'text' = 'json'): Promise<Said> {
  try {
    return await fromIndex(ctx, path, as)
  } catch (err) {
    return { url: at(ctx, path), word: WORD, unread: (err as Error).message }
  }
}
