// The one file, `DATA_DIR/places.sqlite` (README.md, The data): every town and city section in
// GeoNames' cities500, and every colonia in GeoNames' postal file for Mexico, placed by Correos de
// México's postal areas. Downloaded into memory, written to a new file, checked with the service's
// own code (checks.ts), and only then renamed into place: a build whose checks fail leaves no file,
// so an image whose data is wrong never builds.
//
//   npm run build    with DATA_DIR, ./data unless set

import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

import { fold } from '../src/fold.ts'
import { BANDS, FILE, openPlaces, type Places, SCHEMA } from '../src/places.ts'

export const SOURCES = {
  geonames: 'https://download.geonames.org/export',
  // Correos de México's postal areas, its edition 11 (2025-01-15), as open-mexico/mexico-geojson
  // copied them from datos.gob.mx at its tag 2025.1: one file per state, each area by its code.
  correos: 'https://raw.githubusercontent.com/open-mexico/mexico-geojson/8b32f43ed9e3c79eb9ec89ebe2c7105dc524b1aa',
}
export const STATES = ['01-Ags', '02-Bc', '03-Bcs', '04-Camp', '05-Coah', '06-Col', '07-Chis', '08-Chih', '09-Cdmx', '10-Dgo', '11-Gto', '12-Gro', '13-Hgo', '14-Jal', '15-Mex', '16-Mich', '17-Mor', '18-Nay', '19-NL', '20-Oax', '21-Pue', '22-Qro', '23-Qroo', '24-SLP', '25-Sin', '26-Son', '27-Tab', '28-Tmps', '29-Tlax', '30-Ver', '31-Yuc', '32-Zac']

/** GeoNames' places that are no longer there: abandoned, historical and destroyed. */
const GONE = new Set(['PPLQ', 'PPLH', 'PPLW'])
/**
 * Mexico's states, one name each: GeoNames names Mexico City in English and the postal file by its
 * name before 2016, and the postal file gives three states their long names. Neither file's codes
 * can join them: the postal file numbers the states as INEGI does, GeoNames by its own.
 */
export const MEXICO_STATES: { [name: string]: string } = {
  'Mexico City': 'Ciudad de México',
  'Distrito Federal': 'Ciudad de México',
  'Coahuila de Zaragoza': 'Coahuila',
  'Michoacán de Ocampo': 'Michoacán',
  'Veracruz de Ignacio de la Llave': 'Veracruz',
}

export type Check = { name: string; run(places: Places): string | null }
export type Source = { url: string; bytes: number; sha256: string; modified: string | null }
export type Counts = { towns: number; countries: number; colonias: number; gone: number; colonias_without_area: number }

const KM_PER_DEGREE = (Math.PI / 180) * 6371.0088
const round4 = (x: number) => Math.round(x * 10_000) / 10_000
const lines = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/\r$/, '').split('\t'))

/** The context line: each part kept unless it repeats the name or the part before it. */
export function contextOf(name: string, parts: Array<string | undefined>): string {
  const kept: string[] = []
  for (const part of parts) if (part && fold(part) !== fold(name) && fold(part) !== fold(kept.at(-1) ?? '')) kept.push(part)
  return kept.join(', ')
}

export const bandOf = (people: number) => BANDS.findLastIndex((b) => people >= b.people)

type Sum = { km2: number; lat: number; lon: number }

/**
 * Adds a polygon list's area to `sum`: each outer ring's area counts and each hole's is taken
 * away, whichever way its ring runs, with each ring's centre weighed by its area. Areas on a local
 * flat map, degrees of longitude shrunk by the cosine of the latitude: right to well under a
 * percent for areas this size.
 */
export function addArea(sum: Sum, polygons: number[][][][]): void {
  for (const polygon of polygons)
    polygon.forEach((ring, i) => {
      const k = Math.cos((ring[0]![1]! * Math.PI) / 180)
      let a = 0, cx = 0, cy = 0
      for (let j = 0; j + 1 < ring.length; j++) {
        const x1 = ring[j]![0]! * k, y1 = ring[j]![1]!, x2 = ring[j + 1]![0]! * k, y2 = ring[j + 1]![1]!
        const c = x1 * y2 - x2 * y1
        a += c
        cx += (x1 + x2) * c
        cy += (y1 + y2) * c
      }
      if (a === 0) return
      const km2 = (Math.abs(a) / 2) * KM_PER_DEGREE * KM_PER_DEGREE * (i === 0 ? 1 : -1)
      sum.km2 += km2
      sum.lat += km2 * (cy / (3 * a))
      sum.lon += km2 * (cx / (3 * a) / k)
    })
}

export async function build(o: { dir: string; sources?: typeof SOURCES; states?: string[]; checks?: Check[]; log?: (line: string) => void }) {
  const sources = o.sources ?? SOURCES
  const log = o.log ?? (() => {})
  const got: Source[] = []
  async function download(url: string): Promise<Uint8Array> {
    // A busy source (429, or a 5xx) is asked again, up to 5 times, after the wait it asks for or
    // 10, 20, 40 and 80 seconds: GitHub's raw files answer 429 to many downloads from one address.
    let res: Response
    for (let tries = 1; ; tries++) {
      res = await fetch(url)
      if ((res.status !== 429 && res.status < 500) || tries === 5) break
      const after = res.headers.get('retry-after')
      const wait = after !== null && /^\d+$/.test(after) ? Number(after) : 10 * 2 ** (tries - 1)
      log(`${url} answered ${res.status}; asking again in ${wait} seconds`)
      await res.body?.cancel()
      await new Promise((r) => setTimeout(r, wait * 1000))
    }
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    got.push({ url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), modified: res.headers.get('last-modified') })
    log(`${url}: ${bytes.length} bytes`)
    return bytes
  }
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  async function unzipped(url: string, name: string): Promise<string> {
    const file = unzipSync(await download(url), { filter: (f) => f.name === name })[name]
    if (!file) throw new Error(`${url} holds no ${name}`)
    return text(file)
  }

  const countries = new Map(lines(text(await download(`${sources.geonames}/dump/countryInfo.txt`))).map((l) => [l[0]!, l[4]!]))
  const admin1 = new Map(lines(text(await download(`${sources.geonames}/dump/admin1CodesASCII.txt`))).map((l) => [l[0]!, l[1]!]))
  const admin2 = new Map(lines(text(await download(`${sources.geonames}/dump/admin2Codes.txt`))).map((l) => [l[0]!, l[1]!]))
  const cities = lines(await unzipped(`${sources.geonames}/dump/cities500.zip`, 'cities500.txt'))
  const postal = lines(await unzipped(`${sources.geonames}/zip/MX.zip`, 'MX.txt'))
  const state = (name: string) => MEXICO_STATES[name] ?? name

  // Each postal area by its code, five digits: the copy gives each as a number, so 03100 as 3100.
  const areas = new Map<string, Sum>()
  for (const s of o.states ?? STATES) {
    const collection = JSON.parse(text(await download(`${sources.correos}/${s}.geojson`))) as { features: Array<{ properties: { d_codigo: number | string }; geometry: { type: string; coordinates: unknown } | null }> }
    for (const f of collection.features) {
      if (!f.geometry) continue
      const code = String(f.properties.d_codigo).padStart(5, '0')
      const sum = areas.get(code) ?? { km2: 0, lat: 0, lon: 0 }
      addArea(sum, (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][])
      areas.set(code, sum)
    }
  }

  mkdirSync(o.dir, { recursive: true })
  const file = join(o.dir, FILE)
  const next = `${file}.new`
  rmSync(next, { force: true })
  const db = new DatabaseSync(next)
  db.exec(SCHEMA)
  const put = db.prepare('insert into places (id, name, context, folded, lat, lon, radiusKm, country, band, people) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const spot = db.prepare('insert into spots (id, minLat, maxLat, minLon, maxLon) values (?, ?, ?, ?, ?)')
  let id = 0
  function add(name: string, context: string, lat: number, lon: number, radiusKm: number, country: string, band: number, people: number) {
    id++
    lat = round4(lat)
    lon = round4(lon)
    put.run(id, name, context, fold(name), lat, lon, radiusKm, country, band, people)
    spot.run(id, lat, lat, lon, lon)
  }

  const counts: Counts = { towns: 0, countries: 0, colonias: 0, gone: 0, colonias_without_area: 0 }
  db.exec('begin')
  const seenCountries = new Set<string>()
  for (const l of cities) {
    const [, name, , , lat, lon, , feature, cc, , a1, a2] = l as [string, string, string, string, string, string, string, string, string, string, string, string]
    if (GONE.has(feature)) {
      counts.gone++
      continue
    }
    const people = Number(l[14]) || 0
    const band = bandOf(people)
    const region = admin1.get(`${cc}.${a1}`)
    add(name, contextOf(name, [admin2.get(`${cc}.${a1}.${a2}`), cc === 'MX' && region ? state(region) : region, countries.get(cc)]), Number(lat), Number(lon), BANDS[band]!.km, cc, band, people)
    seenCountries.add(cc)
    counts.towns++
  }
  counts.countries = seenCountries.size
  // A colonia: its name, municipio, state and code from the postal file, never its point, and its
  // point and size from its postal area. Merged when name, municipio and code repeat.
  const seen = new Set<string>()
  for (const [, code, name, st, , municipio] of postal as string[][]) {
    const key = `${name}\t${municipio}\t${code}`
    if (seen.has(key)) continue
    seen.add(key)
    const area = areas.get(code!)
    if (!area || area.km2 <= 0) {
      counts.colonias_without_area++
      continue
    }
    const radiusKm = Math.max(1, Math.ceil(Math.sqrt(area.km2 / Math.PI)))
    add(name!, contextOf(name!, [municipio, state(st!), countries.get('MX'), code]), area.lat / area.km2, area.lon / area.km2, radiusKm, 'MX', 0, 0)
    counts.colonias++
  }
  db.exec('commit')
  db.exec("insert into words (words) values ('rebuild')")
  db.exec("insert into words (words) values ('optimize')")
  const about = db.prepare('insert into about (key, value) values (?, ?)')
  about.run('built', JSON.stringify(new Date().toISOString()))
  about.run('counts', JSON.stringify(counts))
  about.run('sources', JSON.stringify(got))
  db.exec('vacuum')
  db.close()
  log(`${counts.towns} towns in ${counts.countries} countries, ${counts.colonias} colonias; left out: ${counts.gone} places no longer there, ${counts.colonias_without_area} colonias with no postal area`)

  const places = openPlaces(next)
  const failed = (o.checks ?? []).flatMap((c) => {
    const why = c.run(places)
    return why === null ? [] : [`${c.name}: ${why}`]
  })
  places.close()
  if (failed.length) {
    rmSync(next, { force: true })
    throw new Error(`the build's checks failed, and it wrote no file:\n${failed.join('\n')}`)
  }
  renameSync(next, file)
  log(`${o.checks?.length ?? 0} checks passed; ${file}`)
  return { file, counts }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { CHECKS } = await import('./checks.ts')
  await build({ dir: process.env.DATA_DIR || './data', checks: CHECKS, log: console.log })
}
