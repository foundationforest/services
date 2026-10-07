// `npm run fetch`: the files the face embedding needs and its test reads, each checked against its
// SHA-256, so a changed file never gets in. A file already here with the right hash is kept.
//
//   models/       the two models (src/face.ts), from OpenCV's model zoo, as it publishes them on
//                 Hugging Face: YuNet (MIT) and SFace (Apache 2.0)
//   test/faces/   three official NASA portraits, public domain, from NASA's own image library: two of
//                 one astronaut (2004, 2012) and one of another (2019), for test/face.test.ts
//
// None of these files is in the repo. Needs the network. `npm run fetch -- models` takes the models
// alone, as the image does.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nasa = (id: string) => `https://images-assets.nasa.gov/image/${id}/${id}~medium.jpg`

export const FILES = [
  {
    path: 'models/face_detection_yunet_2023mar.onnx',
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  },
  {
    path: 'models/face_recognition_sface_2021dec.onnx',
    url: 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  },
  // Sunita Williams, official portrait, 22 September 2004 (JSC2005-E-02663, Mark Sowa).
  { path: 'test/faces/williams-2004.jpg', url: nasa('jsc2005e02663'), sha256: 'f07a5fbbd28521391b4c15aa8bcf466904958c3580bb0ed1a31db493826599a5' },
  // Sunita Williams, 22 February 2012 (JSC2012-E-096296).
  { path: 'test/faces/williams-2012.jpg', url: nasa('jsc2012e096296'), sha256: '30f019f6690f1330fbf01ac2f10778768317651fb246ad14267626d186fdcbf4' },
  // Nicole Mann, official portrait, 18 June 2019 (jsc2019e026848).
  { path: 'test/faces/mann-2019.jpg', url: nasa('jsc2019e026848_alt'), sha256: '7f25ee0829725139e367251a97462d0db731436b44149037b16ecdfe51c93f30' },
]

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const only = process.argv[2]
for (const file of FILES.filter((f) => !only || f.path.startsWith(`${only}/`))) {
  const path = join(root, file.path)
  if (existsSync(path) && sha256(readFileSync(path)) === file.sha256) continue
  const res = await fetch(file.url, { headers: { 'user-agent': 'foundationforest/services issuer fetch' }, signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`${file.url} answered ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const got = sha256(bytes)
  if (got !== file.sha256) throw new Error(`${file.path}: SHA-256 ${got}, not ${file.sha256}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.part`, bytes)
  renameSync(`${path}.part`, path)
  console.log(`${file.path}: ${bytes.length} bytes`)
}
