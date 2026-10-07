// The face embedding (src/face.ts), with the real models on real photos: two official NASA portraits
// of one astronaut, eight years apart, and one of another. The same person scores at least
// FACE_MATCH, two people below it; a photo with no face, and bytes that are no photo, are refused.
//
//   npm run fetch && npm test
//
// Needs the models and the portraits `npm run fetch` puts in models/ and test/faces/. If they are
// missing the test says so and skips.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PNG } from 'pngjs'

import { DETECTOR_FILE, EMBEDDING_BYTES, FACE_MATCH, FaceError, MODELS_DIR, RECOGNIZER_FILE, SFACE_MODEL, sface, similarity, similarityTransform, standIn } from '../src/face.ts'

const faces = join(dirname(fileURLToPath(import.meta.url)), 'faces')
const photo = (name: string) => new Uint8Array(readFileSync(join(faces, name)))
const missing = [join(MODELS_DIR, DETECTOR_FILE), join(MODELS_DIR, RECOGNIZER_FILE), join(faces, 'mann-2019.jpg')].some((f) => !existsSync(f))
  ? 'no models or portraits; run `npm run fetch`'
  : false

/** A 64 by 64 PNG of one grey: no face in it. */
function blank(): Uint8Array {
  const png = new PNG({ width: 64, height: 64 })
  png.data.fill(128)
  return new Uint8Array(PNG.sync.write(png))
}

test('the transform maps landmarks onto a rotated, scaled, shifted copy of themselves', () => {
  const from: [number, number][] = [[10, 10], [30, 12], [20, 25], [12, 35], [28, 36]]
  const [a, b, tx, ty] = [0.8, 0.6, 5, -3]
  const to = from.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty] as [number, number])
  const got = similarityTransform(from, to)
  for (const [i, want] of [a, b, tx, ty].entries()) assert.ok(Math.abs(got[i]! - want) < 1e-9)
})

test('SFace: one person across eight years matches, two people do not', { skip: missing }, async () => {
  const embedder = await sface()
  assert.equal(embedder.model, SFACE_MODEL)
  const williams2004 = await embedder.embed(photo('williams-2004.jpg'))
  const williams2012 = await embedder.embed(photo('williams-2012.jpg'))
  const mann = await embedder.embed(photo('mann-2019.jpg'))
  assert.equal(williams2004.length, EMBEDDING_BYTES)

  assert.ok(Math.abs(similarity(williams2004, williams2004) - 1) < 1e-6, 'a face matches itself')
  assert.deepEqual(await embedder.embed(photo('williams-2004.jpg')), williams2004, 'the same photo gives the same bytes')
  const same = similarity(williams2004, williams2012)
  assert.ok(same >= FACE_MATCH, `one person, 2004 and 2012: ${same.toFixed(3)}`)
  for (const other of [williams2004, williams2012]) {
    const two = similarity(other, mann)
    assert.ok(two < FACE_MATCH, `two people: ${two.toFixed(3)}`)
  }
})

test('SFace refuses a photo with no face, and bytes that are no photo', { skip: missing }, async () => {
  const embedder = await sface()
  await assert.rejects(embedder.embed(blank()), (err: FaceError) => err.code === 'no_face')
  await assert.rejects(embedder.embed(new TextEncoder().encode('not a photo')), (err: FaceError) => err.code === 'not_an_image')
  await assert.rejects(embedder.embed(Uint8Array.of(0xff, 0xd8, 1, 2, 3)), (err: FaceError) => err.code === 'not_an_image')
})

test('the stand-in gives one embedding, whatever it is shown', async () => {
  const embedder = standIn()
  assert.equal(embedder.model, 'stand-in')
  const a = await embedder.embed(new Uint8Array(0))
  const b = await embedder.embed(blank())
  assert.equal(a.length, EMBEDDING_BYTES)
  assert.deepEqual(a, b)
  assert.ok(Math.abs(similarity(a, b) - 1) < 1e-6)
})
