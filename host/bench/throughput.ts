// How fast the pieces are, on this machine. One core, Node, pure-JavaScript crypto (noble's curve
// arithmetic with Baby Jubjub's numbers, poseidon-lite).
// Run: npm run bench.

import { cpus } from 'node:os'
import { verifySignature as zkVerify } from '@zk-kit/eddsa-poseidon'
import { bytesMessage, serviceKey, unpackSignature } from '@foundationforest/keys'
import { b64u, canonical, checkEntry, checkSignature, decodeEntry, encodeEntry, entry, signingInput, unsignedOf, viewFolder } from '@foundationforest/folders'
import { Host } from '../src/plug.ts'

// An offer about the size of a short one. Its fields are its market's; `about` stands in for them.
const offer = {
  about: 'One hour of maths tutoring, online, for secondary school students preparing for exams. Thirty a session, paid in a dollar on Solana; evenings and weekends.',
}

function rate(label: string, n: number, run: (i: number) => void): number {
  for (let i = 0; i < Math.min(50, n); i++) run(i) // warm up
  const start = performance.now()
  for (let i = 0; i < n; i++) run(i)
  const perSecond = n / ((performance.now() - start) / 1000)
  console.log(`${label.padEnd(58)} ${Math.round(perSecond).toLocaleString('en-US').padStart(10)} /s`)
  return perSecond
}

const key = serviceKey(new Uint8Array(32).fill(5))
const one = entry(key, 'offer/maths', offer, 1_790_000_000_000)
const wire = encodeEntry(one)
const message = signingInput(unsignedOf(one))
const sig = b64u.decode(one.sig)
console.log(`machine: ${cpus()[0]?.model ?? 'unknown'}, node ${process.version}; one offer entry is ${wire.length} bytes on the wire`)

rate('canonical text of an entry', 20_000, () => canonical(one))
rate('sign an entry (EdDSA-Poseidon on Baby Jubjub)', 1_000, (i) => entry(key, 'offer/maths', offer, 1_790_000_000_000 + i))
rate('check, Forest strict (key in the subgroup, R8 on curve)', 1_000, () => checkSignature(sig, message, key.address))
const signature = unpackSignature(sig)!
const hm = bytesMessage(message)
rate('check, zk-kit (@zk-kit/eddsa-poseidon), for comparison', 10, () => zkVerify(hm, signature, key.publicKey))
rate('read one entry off the wire (parse, canonical, strict check)', 1_000, () => decodeEntry(wire))

// A host taking entries: 500 profiles, a profile entry and 4 offers each, in batches of 100.
const host = new Host({ now: () => 1_790_000_000_000 })
const lines: string[] = []
for (let p = 0; p < 500; p++) {
  const k = serviceKey(new Uint8Array(32).map((_, j) => (p * 13 + j * 7 + 1) & 255))
  lines.push(encodeEntry(entry(k, 'profile', { market: 'tutoring', role: 'seller', hosts: ['https://host.example'] }, 1_790_000_000_000)))
  for (let o = 0; o < 4; o++) lines.push(encodeEntry(entry(k, `offer/${o}`, offer, 1_790_000_000_000 + o)))
}
let start = performance.now()
for (let i = 0; i < lines.length; i += 100) await host.accept(lines.slice(i, i + 100))
const ingest = lines.length / ((performance.now() - start) / 1000)
console.log(`${'host: check and store, a file per folder, 2,500 entries'.padEnd(58)} ${Math.round(ingest).toLocaleString('en-US').padStart(10)} /s`)

start = performance.now()
let served = 0
for (let after = 0; ; ) {
  const page = host.read({ after })
  if (!page.lines.length) break
  served += page.lines.length
  after = page.cursor
}
const read = served / ((performance.now() - start) / 1000)
console.log(`${'host: serve everything, pages of 1,000'.padEnd(58)} ${Math.round(read).toLocaleString('en-US').padStart(10)} /s`)

// The view of a busy folder: 1,000 entries.
const busy = Array.from({ length: 1000 }, (_, i) => checkEntry(entry(key, `offer/${i % 200}`, offer, 1_790_000_000_000 + i)))
rate('the view of a folder of 1,000 entries', 200, () => viewFolder(key.address, busy, 1_790_000_000_000 + 10_000))
await host.close()
