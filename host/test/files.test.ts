// Files on the plug: bytes are taken only while a current entry here names them, with their type and
// size; bytes several folders name are stored once and kept while any names them, then for keep
// days; and the sizes and types it takes, and its own choice by folder, are the host's.

import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { describe, test } from 'node:test'
import { type Body, type Writer, entry, fileOf, upload, write } from '@foundationforest/folders'
import { DAY, type Host } from '../src/plug.ts'
import { T0, alice, aliceWith, bob, helper, offerBody, profileBody } from './fixtures.ts'
import { Clock, startPlug } from './helpers.ts'

const bytesOf = (seed: number, length = 2000) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed * 13) & 255)
const photo = bytesOf(1)
const clip = bytesOf(2, 5000)
const nameOf = (bytes: Uint8Array) => fileOf(bytes, 'image/jpeg').sha256
/** A body naming these files. */
const naming = (...files: Array<[Uint8Array, string]>): Body => ({ ...offerBody('with files'), files: files.map(([bytes, type]) => fileOf(bytes, type)) })
/** One host's answer to an upload, as its error code, or its message, or ok. */
const put = async (h: Host, bytes: Uint8Array, type = 'image/jpeg') => {
  const [out] = await upload([h.url], bytes, type)
  return out!.error ?? out!.message ?? 'ok'
}
/** An upload as sent, its name and its type each as given: what a client that gets them wrong sends. */
const sent = async (h: Host, name: string, type: string, bytes: Uint8Array) => {
  const res = await fetch(`${h.url}/v1/files/${name}`, { method: 'PUT', headers: { 'content-type': type }, body: new Uint8Array(bytes) })
  const answer = (await res.json()) as { error?: string; message?: string }
  return `${res.status} ${answer.error ?? answer.message ?? 'ok'}`
}
const writes = async (h: Host, writer: Writer, path: string, body: Body | null, time: number) => (await write([h.url], [entry(writer, path, body, time)]))[0]!.results[0]!.error ?? 'ok'

describe('files', () => {
  test('bytes are taken only while a current entry here names them, with that type and size, and are served with their type', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal(await put(h, photo), 'unnamed')
      assert.equal(await writes(h, alice, 'photo/1', naming([photo, 'image/jpeg']), T0), 'ok')
      assert.equal(await sent(h, nameOf(photo), 'image/png', photo), '400 shape', 'another type')
      assert.equal(await sent(h, nameOf(photo), 'image/jpeg', photo.subarray(1)), '400 shape', 'another size')
      assert.equal(await sent(h, nameOf(photo), 'Image/JPEG', photo), '400 shape', 'no media type')
      assert.equal(await sent(h, nameOf(photo), 'image/jpeg', Uint8Array.from(photo, (v, i) => (i ? v : v ^ 1))), '400 hash')
      assert.equal(await put(h, photo), 'ok')
      assert.equal(await put(h, photo), 'already here')
      const res = await fetch(`${h.url}/v1/files/${nameOf(photo)}`)
      assert.deepEqual([res.status, res.headers.get('content-type'), Buffer.from(await res.arrayBuffer()).equals(photo)], [200, 'image/jpeg', true])
    } finally {
      await h.close()
    }
  })

  test('a photo of the profile, named in its profile entry, is taken like any other', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal(await writes(h, alice, 'profile', { ...profileBody('maths'), files: [fileOf(photo, 'image/png')] }, T0), 'ok')
      assert.equal(await put(h, photo, 'image/png'), 'ok')
    } finally {
      await h.close()
    }
  })

  test('only a current entry that counts names bytes: not one replaced, deleted, or by a key no longer listed', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      await writes(h, alice, 'post/a', naming([photo, 'image/jpeg']), T0)
      await writes(h, alice, 'post/a', offerBody('no photo now'), T0 + 1)
      await writes(h, alice, 'post/b', naming([clip, 'video/mp4']), T0)
      await writes(h, alice, 'post/b', null, T0 + 1)
      assert.deepEqual([await put(h, photo), await put(h, clip, 'video/mp4')], ['unnamed', 'unnamed'])
      const asHelper = { profile: alice.address, key: helper }
      await writes(h, alice, 'profile', aliceWith(['write']), T0)
      assert.equal(await writes(h, asHelper, 'photo/1', naming([photo, 'image/jpeg']), T0), 'ok')
      await writes(h, alice, 'profile', aliceWith([]), T0 + 1)
      assert.equal(await put(h, photo), 'unnamed', 'the key that named it is listed no more')
    } finally {
      await h.close()
    }
  })

  test('bytes two folders name are stored once, kept while either names them, and keep days after neither does', async () => {
    const clock = new Clock(T0)
    const h = await startPlug({ now: clock.now })
    try {
      await writes(h, alice, 'photo/1', naming([photo, 'image/jpeg']), T0)
      await writes(h, bob, 'photo/1', naming([photo, 'image/jpeg']), T0)
      assert.deepEqual([await put(h, photo), await put(h, photo)], ['ok', 'already here'])
      await writes(h, alice, 'photo/1', null, T0 + 1)
      assert.equal(await h.prune(clock.t + 60 * DAY), 1, 'Alice’s replaced entry; the bytes Bob names stay')
      assert.ok(await h.getFile(nameOf(photo)))
      clock.advance(DAY)
      await writes(h, bob, 'photo/1', null, T0 + 1)
      assert.equal(await h.prune(clock.t + 29 * DAY), 0)
      // Named again within keep days: kept, with no upload.
      await writes(h, alice, 'photo/2', naming([photo, 'image/jpeg']), T0 + 2)
      assert.equal(await h.prune(clock.t + 31 * DAY), 1, 'Bob’s replaced entry; the bytes Alice names again stay')
      assert.equal(await put(h, photo), 'already here')
      await writes(h, alice, 'photo/2', null, T0 + 3)
      assert.equal(await h.prune(clock.t + 31 * DAY), 2, 'Alice’s replaced entry, and the bytes no entry names')
      assert.equal((await fetch(`${h.url}/v1/files/${nameOf(photo)}`)).status, 404)
    } finally {
      await h.close()
    }
  })

  test('size and type are the host’s: this one takes png, jpeg and mp4 up to 50,000,000 bytes unless told otherwise; an operator chooses its own', async () => {
    const gif = bytesOf(3)
    const plain = await startPlug({ now: () => T0 })
    const small = await startPlug({ now: () => T0, maxFileBytes: 1000, fileChoice: (file) => (file.type === 'video/mp4' ? 'no video here' : null) })
    try {
      const all: Array<[Uint8Array, string]> = [[gif, 'image/gif'], [photo, 'image/png'], [bytesOf(4, 900), 'video/mp4'], [bytesOf(5, 900), 'image/gif']]
      for (const h of [plain, small]) await writes(h, alice, 'post/a', naming(...all), T0)
      assert.equal(await put(plain, gif, 'image/gif'), 'refused', 'a gif')
      assert.equal(await put(plain, photo, 'image/png'), 'ok')
      const [over] = await upload([small.url], photo, 'image/png')
      assert.deepEqual([over!.status, over!.error], [413, 'size'])
      assert.equal(await put(small, bytesOf(4, 900), 'video/mp4'), 'refused')
      assert.equal(await put(small, bytesOf(5, 900), 'image/gif'), 'ok', 'this operator takes gifs')

      // A declared size over the cap is answered at once, unread.
      const { port } = new URL(plain.url)
      const socket = connect(Number(port), '127.0.0.1')
      socket.write(`PUT /v1/files/${nameOf(photo)} HTTP/1.1\r\nhost: x\r\ncontent-type: image/png\r\ncontent-length: 50000001\r\n\r\n`)
      const reply = await new Promise<string>((resolve) => socket.once('data', (d) => resolve(String(d))))
      socket.destroy()
      assert.match(reply, /^HTTP\/1\.1 413/)
    } finally {
      await plain.close()
      await small.close()
    }
  })

  test('a host’s own choice sees the folders that name the bytes, the newest naming entry first, and what each holds here already: a quota', async () => {
    const seen: unknown[] = []
    const h = await startPlug({
      now: () => T0,
      fileChoice: (_file, folders) => {
        seen.push(folders)
        return folders[0]!.files >= 1 ? 'one file a folder here' : null
      },
    })
    try {
      await writes(h, alice, 'post/a', naming([photo, 'image/jpeg'], [clip, 'video/mp4']), T0)
      assert.equal(await put(h, photo), 'ok')
      assert.equal(await put(h, photo), 'already here', 'not asked again')
      assert.equal(await put(h, clip, 'video/mp4'), 'refused')
      await writes(h, bob, 'post/a', naming([clip, 'video/mp4']), T0)
      assert.equal(await put(h, clip, 'video/mp4'), 'ok')
      assert.deepEqual(seen, [
        [{ folder: alice.address, files: 0, bytes: 0 }],
        [{ folder: alice.address, files: 1, bytes: photo.length }],
        [{ folder: bob.address, files: 0, bytes: 0 }, { folder: alice.address, files: 1, bytes: photo.length }],
      ])
    } finally {
      await h.close()
    }
  })

  test('GET is 404 for bytes not held; only a lowercase SHA-256 is a file path; PUT and GET only', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal((await fetch(`${h.url}/v1/files/${nameOf(photo)}`)).status, 404)
      assert.equal((await fetch(`${h.url}/v1/files/${nameOf(photo).toUpperCase()}`)).status, 404)
      assert.equal((await fetch(`${h.url}/v1/files/abc`, { method: 'PUT', body: photo })).status, 404)
      const post = await fetch(`${h.url}/v1/files/${nameOf(photo)}`, { method: 'POST' })
      assert.deepEqual([post.status, post.headers.get('allow')], [405, 'GET, PUT'])
    } finally {
      await h.close()
    }
  })
})
