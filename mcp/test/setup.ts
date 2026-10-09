// What both tests act on: records' reference host on loopback, taking messages a message key signed
// (it reads the sender's records from the sender's host), a stand-in index serving its own JSON, and
// a stand-in for the public list of hosts. Two people:
//
// - The buyer, whose app gave this tool access keys: a write key on offer and review, a write key
//   on review alone, two message keys (one the owner later makes past), and a read key, listed in
//   its permissions record and as its inbox's reader. Its folder holds an offer its main key wrote, and a private record encrypted to the
//   read key and to its own inbox key.
// - The seller, with an offer and an inbox open to anyone.
// - A quiet profile, whose card declares no inbox.

import { randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateHybridIdentity, identityToRecipient } from 'age-encryption'
import { mainKey, newSeed, inboxKey } from '../../standard/keys/src/index.ts'
import { type AccessKey, type Body, b64u, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, readAll } from '../../standard/records/src/index.ts'
import { Host } from '../../standard/records/src/host.ts'
import { makePrivate } from '../../standard/records/src/private.ts'
import type { Context } from '../src/forest.ts'

export const buyer = await mainKey(newSeed(), 'tutoring/buyer')
export const seller = await mainKey(newSeed(), 'tutoring/seller')
export const quiet = await mainKey(newSeed(), 'tutoring/seller')
export const buyerInbox = await inboxKey(buyer.privateKey)
export const sellerInbox = await inboxKey(seller.privateKey)

export const writeKey = keyFromPrivate(randomBytes(32))
export const reviewKey = keyFromPrivate(randomBytes(32))
export const messageKey = keyFromPrivate(randomBytes(32))
export const laterPastKey = keyFromPrivate(randomBytes(32))
export const strayKey = keyFromPrivate(randomBytes(32))
export const readIdentity = await generateHybridIdentity()
export const readRecipient = await identityToRecipient(readIdentity)

/** Each key as a grant writes it. */
export const KEYS = {
  write: b64u.encode(writeKey.privateKey),
  review: b64u.encode(reviewKey.privateKey),
  message: b64u.encode(messageKey.privateKey),
  laterPast: b64u.encode(laterPastKey.privateKey),
  stray: b64u.encode(strayKey.privateKey),
  main: b64u.encode(buyer.privateKey),
  read: readIdentity,
  inbox: buyerInbox.identity,
}

export const offer = (description: string): Body => ({ direction: 'request', description, price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' } })
export const MARKET = { about: 'the stand-in index', market: 'tutoring', profiles: [seller.address] }
export const SCORES = { profile: seller.address, score: 7 }

const card = (role: string, inboxKey: string, readers?: string[]): Body => ({
  market: 'tutoring',
  role,
  name: `a ${role}`,
  inboxKey,
  inbox: { senders: 'anyone', ...(readers && { readers }) },
  createdAt: '2026-10-07T12:00:00Z',
})

/** A JSON server: each path to its body, 404 for the rest. */
async function serveJson(files: { [path: string]: unknown }): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const body = files[req.url ?? '']
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

/** The buyer's permissions record, as the setup writes it. */
export const ACCESS: AccessKey[] = [
  { key: writeKey.address, scope: 'write', paths: ['offer', 'review'] },
  { key: reviewKey.address, scope: 'write', paths: ['review'] },
  { key: messageKey.address, scope: 'message' },
  { key: laterPastKey.address, scope: 'message' },
  { key: readRecipient, scope: 'read' },
]

export type World = { host: Host; index: string; hostsList: string; ctx: (keys?: Context['keys'], profile?: string) => Context; close: () => Promise<void> }

export async function world(): Promise<World> {
  const host = new Host({ readSender: async (url, profile) => (await readAll(url, { profile })).records })
  await host.listen()
  const now = Date.now()
  await publish(
    [host.url],
    [
      hostsRecord(buyer, [host.url], now),
      permissionsRecord(buyer, ACCESS, now),
      ownerRecord(buyer, 'profile', card('buyer', buyerInbox.recipient, [readRecipient]), now),
      ownerRecord(buyer, 'offer/owned', offer('Maths, written by the main key.'), now),
      ownerRecord(buyer, 'notes/1', await makePrivate({ text: 'Tuesdays suit me.' }, [readRecipient, buyerInbox.recipient]), now),
      ownerRecord(buyer, 'notes/2', await makePrivate({ text: 'For my eyes only.' }, [buyerInbox.recipient]), now),
      hostsRecord(seller, [host.url], now),
      ownerRecord(seller, 'profile', card('seller', sellerInbox.recipient), now),
      ownerRecord(seller, 'offer/maths', { direction: 'offer', description: 'One hour of maths, online.', createdAt: '2026-10-07T12:00:00Z' }, now),
      hostsRecord(quiet, [host.url], now),
      ownerRecord(quiet, 'profile', { market: 'tutoring', role: 'seller', name: 'quiet', createdAt: '2026-10-07T12:00:00Z' }, now),
    ],
  )
  const index = await serveJson({ '/markets/tutoring.json': MARKET, [`/profiles/${seller.address}.json`]: SCORES })
  const list = await serveJson({ '/index/lists/hosts.json': { about: 'the stand-in list', hosts: [host.url] } })
  return {
    host,
    index: index.url,
    hostsList: `${list.url}/index/lists/hosts.json`,
    ctx: (keys = {}, profile = buyer.address) => ({ hosts: [host.url], index: index.url, profile, keys }),
    close: async () => {
      await host.close()
      for (const { server } of [index, list]) await new Promise((resolve) => server.close(resolve))
    },
  }
}
