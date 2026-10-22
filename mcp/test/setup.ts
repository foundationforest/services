// What the tests act on: the standard's reference host on loopback, taking messages a write key
// signed (it reads the sender's records from the sender's host), behind a front that counts every
// request, so a test can show a refused call never wrote to it; and a stand-in index serving the
// four answers this tool reads, in the contract's fields. The hosts records name the front, so
// every request passes it. Four profiles:
//
// - The tutor, whose app gave this tool access keys: a write key for offer, review and inbox, a
//   write key for review alone, and a read key for inbox, named among its inbox's readers. Its
//   folder holds an offer its main key wrote.
// - The student, with an offer and an inbox open to anyone.
// - A clothing buyer, with a write key for offer and review: a role the market keeps some fields from.
// - A quiet tutor, whose profile record declares no inbox.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { accessKey, inboxKey, mainKey, newSeed, readKey } from '@foundationforest/keys'
import { type AccessKey, type Body, b64u, hostsRecord, ownerRecord, permissionsRecord, publish, readAll } from '@foundationforest/records'
import { Host } from '@foundationforest/records/host'
import type { Context } from '../src/forest.ts'

export const tutor = await mainKey(newSeed(), 'tutoring/tutor')
export const student = await mainKey(newSeed(), 'tutoring/student')
export const buyer = await mainKey(newSeed(), 'clothing/buyer')
export const quiet = await mainKey(newSeed(), 'tutoring/tutor')
export const tutorInbox = await inboxKey(tutor.secret)
export const studentInbox = await inboxKey(student.secret)

export const writer = accessKey(randomBytes(32))
export const reviewer = accessKey(randomBytes(32))
export const reader = await readKey(randomBytes(32))
export const buyerWriter = accessKey(randomBytes(32))
/** A read key no permissions record lists. */
export const stray = await readKey(randomBytes(32))

/** Each key as the person's app gives it: its 32 bytes in base64url. */
export const KEYS = {
  write: b64u.encode(writer.secret),
  review: b64u.encode(reviewer.secret),
  read: b64u.encode(reader.secret),
  buyer: b64u.encode(buyerWriter.secret),
  stray: b64u.encode(stray.secret),
}

/** The tutor's permissions record. */
export const ACCESS: AccessKey[] = [
  { key: writer.address, scope: 'write', paths: ['offer', 'review', 'inbox'] },
  { key: reviewer.address, scope: 'write', paths: ['review'] },
  { key: reader.address, sealTo: reader.sealTo, scope: 'read', paths: ['inbox'] },
]

/** A post that fits tutoring's fields. */
export const lesson = (description: string): Body => ({
  description,
  price: { amount: '30', currency: 'EUR', per: 'hour' },
  payment: ['direct', 'session'],
  subjects: ['maths', 'physics'],
  levels: ['secondary'],
  place: { lat: '40.42', lon: '-3.70', precisionKm: 1, area: 'Madrid', online: true },
  hours: { zone: 'Europe/Madrid', slots: [{ days: ['tuesday', 'thursday'], from: '18:00', to: '20:00' }] },
})

export const TUTORING = JSON.parse(readFileSync(new URL('../../markets/markets/tutoring.json', import.meta.url), 'utf8'))
export const DIRECTORY = JSON.parse(readFileSync(new URL('../../markets/directory.json', import.meta.url), 'utf8'))

/** The stand-in index's own address. */
export const INDEX_ADDRESS = accessKey(randomBytes(32)).address
/** One search result, in the contract's fields. */
export const RESULT = {
  profile: student.address,
  market: 'tutoring',
  role: 'student',
  post: { address: `${student.address}/offer/maths`, body: { description: 'Maths for the exam in June.' } },
  rating: { value: 9.2, reviews: 14, withPayment: 11 },
  checks: [{ issuer: 'issuer.forest.foundation', key: INDEX_ADDRESS, label: 'one real person' }],
}
export const ANSWERS = {
  index: { index: INDEX_ADDRESS, markets: [{ name: 'tutoring', description: TUTORING.description, roles: ['tutor', 'student'] }, { name: 'clothing', description: 'Clothes.', roles: ['seller', 'buyer'] }] },
  market: { index: INDEX_ADDRESS, market: TUTORING, posts: { tutor: [], student: [RESULT] } },
  search: { index: INDEX_ADDRESS, total: 1, results: [RESULT] },
  profile: {
    index: INDEX_ADDRESS,
    address: student.address,
    profile: { market: 'tutoring', role: 'student' },
    checks: RESULT.checks,
    rating: RESULT.rating,
    posts: [{ address: `${student.address}/offer/maths`, body: { description: 'Maths for the exam in June.' }, listed: true }],
    reviews: { received: [{ reviewer: tutor.address, address: `${tutor.address}/review/1`, body: { subject: student.address, score: '9' }, counted: true, evidence: 'without', weight: 1 }], given: [] },
  },
}

const inboxOpen = (inboxKey: string, readers?: string[]) => ({ inboxKey, inbox: { senders: 'anyone', ...(readers && { readers }) } })

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A front that passes every request to `to`, as it came, and counts each by its method and path. */
async function front(to: () => string): Promise<{ url: string; server: Server; counts: Map<string, number> }> {
  const counts = new Map<string, number>()
  const server = createServer(async (req, res) => {
    const what = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`
    counts.set(what, (counts.get(what) ?? 0) + 1)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = Object.fromEntries(['content-type', 'forest-blob'].filter((h) => req.headers[h]).map((h) => [h, String(req.headers[h])]))
    const answer = await fetch(`${to()}${req.url}`, { method: req.method, headers, ...(chunks.length && { body: Buffer.concat(chunks) }) })
    const back = Object.fromEntries(['content-type', 'forest-cursor'].filter((h) => answer.headers.has(h)).map((h) => [h, answer.headers.get(h)!]))
    res.writeHead(answer.status, back).end(Buffer.from(await answer.arrayBuffer()))
  })
  return { url: await listen(server), server, counts }
}

/** The stand-in index: the contract's four answers, and the last search's filters. */
async function standIn(): Promise<{ url: string; server: Server; searched: () => URLSearchParams | undefined }> {
  let searched: URLSearchParams | undefined
  const files: { [path: string]: unknown } = {
    '/index.json': ANSWERS.index,
    '/markets/tutoring.json': ANSWERS.market,
    '/search.json': ANSWERS.search,
    [`/profiles/${student.address}.json`]: ANSWERS.profile,
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/search.json') searched = url.searchParams
    const body = files[url.pathname]
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  return { url: await listen(server), server, searched: () => searched }
}

export type World = { host: string; counts: Map<string, number>; index: string; searched: () => URLSearchParams | undefined; ctx: Context; close: () => Promise<void> }

export async function world(): Promise<World> {
  const host = new Host({ readSender: async (url, profile) => (await readAll(url, { profile })).records })
  await host.listen()
  const door = await front(() => host.url)
  const index = await standIn()
  const now = Date.now()
  const at = [door.url]
  await publish(at, [
    hostsRecord(tutor, at, now),
    permissionsRecord(tutor, ACCESS, now),
    ownerRecord(tutor, 'profile', { market: 'tutoring', role: 'tutor', ...inboxOpen(tutorInbox.sealTo, [reader.sealTo]) }, now),
    ownerRecord(tutor, 'offer/owned', lesson('Maths, posted by the main key.'), now),
    hostsRecord(student, at, now),
    ownerRecord(student, 'profile', { market: 'tutoring', role: 'student', ...inboxOpen(studentInbox.sealTo) }, now),
    ownerRecord(student, 'offer/maths', { description: 'Maths for the exam in June.' }, now),
    hostsRecord(buyer, at, now),
    permissionsRecord(buyer, [{ key: buyerWriter.address, scope: 'write', paths: ['offer', 'review'] }], now),
    ownerRecord(buyer, 'profile', { market: 'clothing', role: 'buyer' }, now),
    hostsRecord(quiet, at, now),
    permissionsRecord(quiet, ACCESS, now),
    ownerRecord(quiet, 'profile', { market: 'tutoring', role: 'tutor' }, now),
  ])
  return {
    host: door.url,
    counts: door.counts,
    index: index.url,
    searched: index.searched,
    ctx: { hosts: [door.url], index: index.url },
    close: async () => {
      for (const server of [door.server, index.server]) await new Promise((resolve) => server.close(resolve))
      await host.close()
    },
  }
}
