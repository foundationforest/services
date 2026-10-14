// The mark on paper, the server's icon: ink #121A15 on paper #EDEAE0, three chevrons and a trunk,
// stroke 4, in a 56-unit square with 8 of margin. Written once, as its strokes: the SVG the server's
// info declares and a hosted copy serves at /icon.svg, and the ICO it serves at /favicon.ico, drawn
// here from the same strokes, so no picture is kept beside the code.

import { crc32, deflateSync } from 'node:zlib'

type Point = [number, number]

const INK = '#121A15'
const PAPER = '#EDEAE0'
const BOX = 56
const MARGIN = 8
const STROKE = 4
/** Each stroke's points, in the mark's own box: the three chevrons, then the trunk. */
const STROKES: Point[][] = [
  [[8, 12], [20, 3], [32, 12]],
  [[8, 22], [20, 13], [32, 22]],
  [[8, 32], [20, 23], [32, 32]],
  [[20, 24], [20, 38]],
]

const points = (s: Point[]) => s.map((p) => p.join(',')).join(' ')
const line = ([[x1, y1], [x2, y2]]: Point[]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`

export const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}"><rect width="${BOX}" height="${BOX}" fill="${PAPER}"/><g transform="translate(${MARGIN} ${MARGIN})" fill="none" stroke="${INK}" stroke-width="${STROKE}">${STROKES.map((s) => (s.length === 2 ? line(s) : `<polyline points="${points(s)}"/>`)).join('')}</g></svg>\n`

/** The SVG as the server's info gives it, so a copy over stdio carries it too. */
export const ICON = { src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }

/**
 * A stroke's outline as SVG draws it by default: flat ends, and each corner mitred (every corner
 * here is far within SVG's miter limit). Its left side forward, then its right side back.
 */
function outline(s: Point[]): Point[] {
  const normal = (a: Point, b: Point): Point => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    return [(a[1] - b[1]) / length, (b[0] - a[0]) / length]
  }
  const side = (sign: number) =>
    s.map((p, i): Point => {
      const before = i > 0 ? normal(s[i - 1]!, p) : undefined
      const after = i < s.length - 1 ? normal(p, s[i + 1]!) : undefined
      // At a corner, out along both normals' sum, as far as the two edges meet.
      const [x, y] = before && after ? [before, after].reduce((m, n) => [m[0] + n[0], m[1] + n[1]]).map((v) => v / (1 + before[0] * after[0] + before[1] * after[1])) : (before ?? after)!
      return [p[0] + (sign * STROKE * x!) / 2, p[1] + (sign * STROKE * y!) / 2]
    })
  return [...side(1), ...side(-1).reverse()]
}

const SHAPES = STROKES.map(outline)

function inside(shape: Point[], x: number, y: number): boolean {
  let odd = false
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i]!
    const [xj, yj] = shape[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd
  }
  return odd
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** The mark `size` pixels square, as a PNG: each pixel ink over paper by the share of its 4 by 4 points on a stroke. */
function png(size: number): Buffer {
  const [ink, paper] = [rgb(INK), rgb(PAPER)]
  const row = 1 + size * 4
  const pixels = Buffer.alloc(size * row)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let on = 0
      for (let i = 0; i < 16; i++) {
        const at = (n: number, k: number) => ((n + (k + 0.5) / 4) * BOX) / size - MARGIN
        if (SHAPES.some((s) => inside(s, at(x, i % 4), at(y, Math.floor(i / 4))))) on++
      }
      const start = y * row + 1 + x * 4
      for (let c = 0; c < 3; c++) pixels[start + c] = Math.round(paper[c]! + ((ink[c]! - paper[c]!) * on) / 16)
      pixels[start + 3] = 255
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length, 0)
    typed.copy(out, 4)
    out.writeUInt32BE(crc32(typed), data.length + 8)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bits per sample
  header[9] = 6 // RGBA
  return Buffer.concat([Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

/** The sizes in the ICO, in pixels. */
export const ICO_SIZES = [16, 32, 48, 64]

/** An ICO of PNGs, one for each size. */
function ico(): Buffer {
  const images = ICO_SIZES.map(png)
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2) // an icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach((image, i) => {
    const entry = 6 + 16 * i
    head[entry] = head[entry + 1] = ICO_SIZES[i]! // width and height
    head.writeUInt16LE(1, entry + 4) // planes
    head.writeUInt16LE(32, entry + 6) // bits per pixel
    head.writeUInt32LE(image.length, entry + 8)
    head.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  return Buffer.concat([head, ...images])
}

export const ICO = ico()
