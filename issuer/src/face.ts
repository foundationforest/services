// The face embedding: the numbers a face model gives for a face, which a note carries
// (standard/registry/README.md, "The note and the person proof"). Two photos of one person give
// two embeddings close to each other; two people, two far apart.
//
// Two open models from OpenCV's model zoo, used unchanged, run with onnxruntime-web (WASM, in Node):
//
//   YuNet (face_detection_yunet_2023mar.onnx, MIT)        finds each face and its five landmarks:
//                                                           the eyes, the nose tip, the mouth's corners
//   SFace (face_recognition_sface_2021dec.onnx, Apache 2)  128 numbers for one face, aligned to 112 x 112
//
// The steps are OpenCV's own (FaceDetectorYN, FaceRecognizerSF), written out here so no native
// library is needed:
//
//   1. decode the photo (JPEG or PNG) to RGB;
//   2. scale it to fit YuNet's 640 x 640 input, as BGR, and take the face it is surest of;
//   3. the similarity transform that maps its five landmarks onto SFace's template, least squares;
//   4. the face warped through it to 112 x 112 (bilinear), as RGB, into SFace;
//   5. the 128 numbers scaled to length 1, written as 128 float32 little-endian: 512 bytes.
//
// Two embeddings compare by cosine similarity (`similarity`). FACE_MATCH is where "the same person"
// starts.
//
// Nothing here writes or logs a photo or an embedding. The models are files `npm run fetch` puts in
// models/, each checked against its SHA-256 (scripts/fetch.ts).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import jpeg from 'jpeg-js'
import * as ort from 'onnxruntime-web'
import { PNG } from 'pngjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Where `npm run fetch` puts the models. */
export const MODELS_DIR = join(here, '../models')
export const DETECTOR_FILE = 'face_detection_yunet_2023mar.onnx'
export const RECOGNIZER_FILE = 'face_recognition_sface_2021dec.onnx'

/** The model a note names for an embedding SFace made. */
export const SFACE_MODEL = 'opencv-sface-2021dec'

/**
 * The cosine similarity at which two embeddings are the same person. OpenCV gives 0.363 for SFace;
 * across six official portraits of five people, two of them scored 0.41, and one person eight years
 * apart 0.80, so this sits between.
 */
export const FACE_MATCH = 0.5

/** How sure YuNet must be that a face is a face, as OpenCV's own default. */
const FACE_SCORE = 0.9
const DETECTOR_SIZE = 640
const STRIDES = [8, 16, 32]
const ALIGNED = 112
/** SFace's template: where the five landmarks sit in a 112 x 112 face (OpenCV's alignCrop). */
const TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]
const DIMENSIONS = 128
export const EMBEDDING_BYTES = DIMENSIONS * 4

/** Why a photo gave no embedding: it is not a JPEG or PNG, or no face is in it. */
export class FaceError extends Error {
  readonly code: 'not_an_image' | 'no_face'
  constructor(code: 'not_an_image' | 'no_face') {
    super(code)
    this.code = code
  }
}

export interface Embedder {
  /** The model's name, as a note carries it. */
  readonly model: string
  /** The embedding of the face in this photo: 512 bytes. Throws FaceError. */
  embed(photo: Uint8Array): Promise<Uint8Array>
}

/** An image as RGB, row by row. */
type Rgb = { width: number; height: number; data: Uint8Array }

/** A JPEG or a PNG, decoded to RGB. */
export function decode(photo: Uint8Array): Rgb {
  let rgba: { width: number; height: number; data: Uint8Array }
  try {
    if (photo[0] === 0xff && photo[1] === 0xd8) {
      rgba = jpeg.decode(photo, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 })
    } else if (photo[0] === 0x89 && photo[1] === 0x50) {
      const png = PNG.sync.read(Buffer.from(photo))
      rgba = { width: png.width, height: png.height, data: new Uint8Array(png.data) }
    } else {
      throw new FaceError('not_an_image')
    }
  } catch {
    throw new FaceError('not_an_image')
  }
  const data = new Uint8Array(rgba.width * rgba.height * 3)
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    data[i] = rgba.data[j]!
    data[i + 1] = rgba.data[j + 1]!
    data[i + 2] = rgba.data[j + 2]!
  }
  return { width: rgba.width, height: rgba.height, data }
}

/** The colour at (x, y), bilinear, black outside the image: what OpenCV's INTER_LINEAR does with a constant border. */
function sample(img: Rgb, x: number, y: number, out: Float32Array, at: number): void {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  for (let ch = 0; ch < 3; ch++) {
    let v = 0
    for (const [dx, dy, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ] as const) {
      const px = x0 + dx
      const py = y0 + dy
      if (w === 0 || px < 0 || py < 0 || px >= img.width || py >= img.height) continue
      v += w * img.data[(py * img.width + px) * 3 + ch]!
    }
    out[at + ch] = v
  }
}

/** A detected face: its score and its five landmarks, in the photo's own pixels. */
type Face = { score: number; landmarks: [number, number][] }

/**
 * The photo scaled to fit 640 x 640 (the rest black), as YuNet takes it: BGR, 0 to 255, channels
 * first. Returns the tensor's data and the scale.
 */
function detectorInput(img: Rgb): { data: Float32Array; scale: number } {
  const scale = Math.min(1, DETECTOR_SIZE / Math.max(img.width, img.height))
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)
  const plane = DETECTOR_SIZE * DETECTOR_SIZE
  const data = new Float32Array(3 * plane)
  const px = new Float32Array(3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The centre of each pixel, as OpenCV's resize maps it.
      sample(img, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5, px, 0)
      const i = y * DETECTOR_SIZE + x
      data[i] = px[2]!
      data[plane + i] = px[1]!
      data[2 * plane + i] = px[0]!
    }
  }
  return { data, scale }
}

/** YuNet's twelve outputs read the way OpenCV's FaceDetectorYN reads them; the face it is surest of. */
function bestFace(out: ort.InferenceSession.OnnxValueMapType, scale: number): Face | null {
  let best: Face | null = null
  STRIDES.forEach((stride) => {
    // The boxes (`bbox_<stride>`) are not read: the landmarks place the face.
    const [cls, obj, kps] = ['cls', 'obj', 'kps'].map((k) => out[`${k}_${stride}`]!.data as Float32Array)
    const cols = DETECTOR_SIZE / stride
    for (let idx = 0; idx < cls!.length; idx++) {
      const clamp = (v: number) => Math.min(1, Math.max(0, v))
      const score = Math.sqrt(clamp(cls![idx]!) * clamp(obj![idx]!))
      if (score < FACE_SCORE || (best && score <= best.score)) continue
      const r = Math.floor(idx / cols)
      const c = idx % cols
      const landmarks: [number, number][] = []
      for (let n = 0; n < 5; n++) {
        landmarks.push([((kps![idx * 10 + 2 * n]! + c) * stride) / scale, ((kps![idx * 10 + 2 * n + 1]! + r) * stride) / scale])
      }
      best = { score, landmarks }
    }
  })
  return best
}

/**
 * The similarity transform (rotation, one scale, shift) that best maps `from` onto `to`, least
 * squares: [a -b tx; b a ty].
 */
export function similarityTransform(from: [number, number][], to: [number, number][]): [number, number, number, number] {
  const n = from.length
  const mean = (pts: [number, number][]) => pts.reduce(([sx, sy], [x, y]) => [sx + x / n, sy + y / n], [0, 0])
  const [fx, fy] = mean(from)
  const [tx, ty] = mean(to)
  let dot = 0
  let cross = 0
  let norm = 0
  for (let i = 0; i < n; i++) {
    const px = from[i]![0] - fx
    const py = from[i]![1] - fy
    const qx = to[i]![0] - tx
    const qy = to[i]![1] - ty
    dot += px * qx + py * qy
    cross += px * qy - py * qx
    norm += px * px + py * py
  }
  const a = dot / norm
  const b = cross / norm
  return [a, b, tx - (a * fx - b * fy), ty - (b * fx + a * fy)]
}

/** The face warped onto SFace's template, as SFace takes it: 112 x 112, RGB, 0 to 255, channels first. */
function recognizerInput(img: Rgb, face: Face): Float32Array {
  const [a, b, tx, ty] = similarityTransform(face.landmarks, TEMPLATE)
  const det = a * a + b * b
  const plane = ALIGNED * ALIGNED
  const data = new Float32Array(3 * plane)
  const px = new Float32Array(3)
  for (let v = 0; v < ALIGNED; v++) {
    for (let u = 0; u < ALIGNED; u++) {
      // The inverse of the transform: where in the photo this pixel of the aligned face comes from.
      const dx = u - tx
      const dy = v - ty
      sample(img, (a * dx + b * dy) / det, (-b * dx + a * dy) / det, px, 0)
      const i = v * ALIGNED + u
      data[i] = px[0]!
      data[plane + i] = px[1]!
      data[2 * plane + i] = px[2]!
    }
  }
  return data
}

/** 128 numbers scaled to length 1, as 128 float32 little-endian. */
function toBytes(values: Float32Array): Uint8Array {
  const length = Math.hypot(...values)
  const out = new Uint8Array(EMBEDDING_BYTES)
  const view = new DataView(out.buffer)
  values.forEach((v, i) => view.setFloat32(i * 4, v / length, true))
  return out
}

function fromBytes(bytes: Uint8Array): Float32Array {
  if (bytes.length !== EMBEDDING_BYTES) throw new RangeError(`an embedding is ${EMBEDDING_BYTES} bytes`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Float32Array.from({ length: DIMENSIONS }, (_, i) => view.getFloat32(i * 4, true))
}

/** How alike two embeddings are: their cosine similarity, from -1 to 1. */
export function similarity(a: Uint8Array, b: Uint8Array): number {
  const x = fromBytes(a)
  const y = fromBytes(b)
  let dot = 0
  for (let i = 0; i < DIMENSIONS; i++) dot += x[i]! * y[i]!
  return dot / (Math.hypot(...x) * Math.hypot(...y))
}

/** SFace, with YuNet to find the face: the models from `dir`, loaded once. */
export async function sface(dir: string = MODELS_DIR): Promise<Embedder> {
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'error'
  const options = { logSeverityLevel: 3 } as const
  const detector = await ort.InferenceSession.create(readFileSync(join(dir, DETECTOR_FILE)), options)
  const recognizer = await ort.InferenceSession.create(readFileSync(join(dir, RECOGNIZER_FILE)), options)
  return {
    model: SFACE_MODEL,
    async embed(photo) {
      const img = decode(photo)
      const input = detectorInput(img)
      const detected = await detector.run({ input: new ort.Tensor('float32', input.data, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]) })
      const face = bestFace(detected, input.scale)
      if (!face) throw new FaceError('no_face')
      const out = await recognizer.run({ data: new ort.Tensor('float32', recognizerInput(img, face), [1, 3, ALIGNED, ALIGNED]) })
      return toBytes(out.fc1!.data as Float32Array)
    },
  }
}

/**
 * The stand-in, for the devnet stand-in Didit only, which shows no face: the same embedding for
 * everyone, forest's own devnet stand-in vector (cos i), under the model `stand-in`.
 */
export function standIn(): Embedder {
  const fixed = toBytes(Float32Array.from({ length: DIMENSIONS }, (_, i) => Math.cos(i)))
  return { model: 'stand-in', embed: async () => fixed.slice() }
}
