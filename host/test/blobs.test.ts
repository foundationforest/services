// Blobs on the plug, as they came from the standard's reference host's tests (at 7b1c937): the main
// key deletes its folder's bytes, bytes two folders hold are stored once, a request is checked
// against the bytes and the route, and the sizes and types it takes are the host's own choice.

import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { describe, test } from 'node:test'
import { type Key, type SignedBlobRequest, blobNameOf, blobRequest, blobSigningInput, canonical, deleteBlob, putBlob, signAs } from '@foundationforest/records'
import type { Host } from '../src/plug.ts'
import { MINUTE, T0, alice, bob, stranger } from './fixtures.ts'
import { startPlug } from './helpers.ts'

const bytesOf = (seed: number, length = 2000) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed * 13) & 255)
const nameOf = (bytes: Uint8Array) => blobNameOf(bytes, 'image/jpeg').sha256
const putOf = (key: Key, bytes: Uint8Array, type = 'image/jpeg', time = T0) => blobRequest(key, { action: 'put', ...blobNameOf(bytes, type) }, time) as SignedBlobRequest & { action: 'put' }
const deleteOf = (key: Key, bytes: Uint8Array, time = T0) => blobRequest(key, { action: 'delete', sha256: nameOf(bytes) }, time) as SignedBlobRequest & { action: 'delete' }
/** One host's answer, as its error code, or its message, or ok. */
const answer = (outcomes: Array<{ ok: boolean; error?: string; message?: string }>) => outcomes[0]!.error ?? outcomes[0]!.message ?? 'ok'
const put = async (h: Host, key: Key, bytes: Uint8Array, type = 'image/jpeg') => answer(await putBlob([h.url], putOf(key, bytes, type), bytes))
const del = async (h: Host, key: Key, bytes: Uint8Array) => answer(await deleteBlob([h.url], deleteOf(key, bytes)))
/** A request naming Alice's folder, signed by `key`, which is not her main key. */
const posing = <R extends SignedBlobRequest>(request: R, key = stranger): R => {
  const { sig: _sig, ...unsigned } = { ...request, profile: alice.address }
  return { ...unsigned, sig: signAs(key, key.address, blobSigningInput(unsigned)) } as R
}

const photo = bytesOf(1)
const clip = bytesOf(2, 5000)

describe('blobs', () => {
  test('the main key deletes its folder’s bytes; a delete of bytes it does not hold is not here', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal(await put(h, alice, photo), 'ok')
      assert.equal(await del(h, alice, photo), 'ok')
      assert.equal((await fetch(`${h.url}/v1/blobs/${nameOf(photo)}`)).status, 404)
      assert.equal(await del(h, alice, photo), 'not here')
    } finally {
      await h.close()
    }
  })

  test('bytes two folders hold are stored once, and stay until the last of them deletes them', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.deepEqual([await put(h, alice, photo), await put(h, bob, photo)], ['ok', 'ok'])
      assert.equal(await del(h, alice, photo), 'ok')
      assert.equal((await fetch(`${h.url}/v1/blobs/${nameOf(photo)}`)).status, 200, 'Bob holds them still')
      assert.equal(await del(h, alice, photo), 'not here')
      assert.equal(await del(h, bob, photo), 'ok')
      assert.equal(await h.getBlob(nameOf(photo)), undefined)
    } finally {
      await h.close()
    }
  })

  test('a request signed by a key that is not the folder’s main key is refused [signature]', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal(answer(await putBlob([h.url], posing(putOf(stranger, photo)), photo)), 'signature', 'a put')
      assert.equal(await put(h, alice, photo), 'ok')
      assert.equal(answer(await deleteBlob([h.url], posing(deleteOf(stranger, photo)))), 'signature', 'a delete')
      assert.equal(answer(await deleteBlob([h.url], posing(deleteOf(bob, photo), bob))), 'signature', 'another profile’s main key')
      assert.ok(await h.getBlob(nameOf(photo)), 'still held')

      // Alice's request with Bob's profile in it: the signature is not Bob's main key's.
      const forged = { ...putOf(alice, clip), profile: bob.address }
      assert.equal(answer(await putBlob([h.url], forged, clip)), 'signature')
    } finally {
      await h.close()
    }
  })

  test('a request is checked against the bytes and the route: their hash, type and size, its action, its time', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const send = async (request: SignedBlobRequest | null, bytes: Uint8Array | null, options: { method?: string; type?: string; name?: string } = {}) => {
        const headers: Record<string, string> = { 'content-type': options.type ?? 'image/jpeg' }
        if (request) headers['forest-blob'] = canonical(request)
        const res = await fetch(`${h.url}/v1/blobs/${options.name ?? nameOf(photo)}`, { method: options.method ?? 'PUT', headers, ...(bytes && { body: new Uint8Array(bytes) }) })
        return [res.status, ((await res.json()) as { error?: string }).error ?? 'ok']
      }
      assert.deepEqual(await send(null, photo), [400, 'shape'], 'no signed request')
      assert.deepEqual(await send(putOf(alice, photo), photo, { type: 'image/png' }), [400, 'shape'], 'another type than it names')
      assert.deepEqual(await send(putOf(alice, photo), photo.subarray(1)), [400, 'shape'], 'another size')
      assert.deepEqual(await send(putOf(alice, clip), photo, { name: nameOf(photo) }), [400, 'shape'], 'a request for other bytes')
      // Named by the right hash, type and size, but other bytes of that size: not what they claim.
      const lookalike = Uint8Array.from(photo, (b, i) => (i === 0 ? b ^ 1 : b))
      assert.deepEqual(await send(putOf(alice, photo), lookalike), [400, 'hash'])
      assert.deepEqual(await send(deleteOf(alice, photo), photo), [400, 'shape'], 'a delete sent as a put')
      assert.deepEqual(await send(putOf(alice, photo), null, { method: 'DELETE' }), [400, 'shape'], 'a put sent as a delete')
      assert.deepEqual(await send(putOf(alice, photo, 'image/jpeg', T0 + 11 * MINUTE), photo), [400, 'stale'])
      assert.deepEqual(await send(deleteOf(alice, photo, T0 - 11 * MINUTE), null, { method: 'DELETE' }), [400, 'stale'])
      assert.deepEqual(await send(putOf(alice, photo, 'image/jpeg', T0 + 9 * MINUTE), photo), [200, 'ok'], 'within ten minutes')
    } finally {
      await h.close()
    }
  })

  test('size and type are the host’s: this one takes png, jpeg and mp4 up to 50,000,000 bytes unless told otherwise; an operator chooses its own', async () => {
    const gif = bytesOf(3)
    const plain = await startPlug({ now: () => T0 })
    const small = await startPlug({ now: () => T0, maxBlobBytes: 1000, blobChoice: (blob) => (blob.type === 'video/mp4' ? 'no video here' : null) })
    try {
      assert.equal(await put(plain, alice, gif, 'image/gif'), 'refused', 'a gif')
      assert.equal(await put(plain, alice, photo, 'image/png'), 'ok')
      const [over] = await putBlob([small.url], putOf(alice, photo, 'image/png'), photo)
      assert.deepEqual([over!.status, over!.error], [413, 'refused'])
      assert.equal(await put(small, alice, bytesOf(4, 900), 'video/mp4'), 'refused')
      assert.equal(await put(small, alice, bytesOf(5, 900), 'image/gif'), 'ok', 'this operator takes gifs')

      // A declared size over the cap is answered at once, unread.
      const { port } = new URL(plain.url)
      const socket = connect(Number(port), '127.0.0.1')
      socket.write(`PUT /v1/blobs/${nameOf(photo)} HTTP/1.1\r\nhost: x\r\ncontent-type: image/png\r\nforest-blob: ${canonical(putOf(alice, photo, 'image/png'))}\r\ncontent-length: 50000001\r\n\r\n`)
      const reply = await new Promise<string>((resolve) => socket.once('data', (d) => resolve(String(d))))
      socket.destroy()
      assert.match(reply, /^HTTP\/1\.1 413/)
    } finally {
      await plain.close()
      await small.close()
    }
  })

  test('a host’s own choice sees the folder and what it holds there already, for choices by folder: a quota', async () => {
    const seen: Array<[string, number, number]> = []
    const h = await startPlug({
      now: () => T0,
      blobChoice: (blob, stored) => {
        seen.push([blob.profile, stored.blobs, stored.bytes])
        return stored.blobs >= 1 ? 'one blob a folder here' : null
      },
    })
    try {
      assert.equal(await put(h, alice, photo), 'ok')
      assert.equal(await put(h, alice, photo), 'already here', 'not asked again')
      assert.equal(await put(h, alice, clip, 'video/mp4'), 'refused')
      assert.equal(await put(h, bob, clip, 'video/mp4'), 'ok')
      assert.deepEqual(seen, [[alice.address, 0, 0], [alice.address, 1, photo.length], [bob.address, 0, 0]])
    } finally {
      await h.close()
    }
  })

  test('GET is 404 for bytes not held; only a lowercase SHA-256 is a blob path; PUT, GET and DELETE only', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal((await fetch(`${h.url}/v1/blobs/${nameOf(photo)}`)).status, 404)
      assert.equal((await fetch(`${h.url}/v1/blobs/${nameOf(photo).toUpperCase()}`)).status, 404)
      assert.equal((await fetch(`${h.url}/v1/blobs/abc`, { method: 'PUT', body: photo })).status, 404)
      const post = await fetch(`${h.url}/v1/blobs/${nameOf(photo)}`, { method: 'POST' })
      assert.deepEqual([post.status, post.headers.get('allow')], [405, 'GET, PUT, DELETE'])
    } finally {
      await h.close()
    }
  })
})
