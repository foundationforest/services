// The build, whole, against the small world on loopback (fixtures.ts): what it keeps and leaves out,
// each colonia's point and size from its postal area and never the postal file's, the context
// lines, the bands, the checks that stop it, and a busy source asked again.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { BANDS } from '../src/places.ts'
import { buildFixture, serveSources, type Sources, tmp } from './fixtures.ts'

const KM_PER_DEGREE = (Math.PI / 180) * 6371.0088
/** A square's area in km², `side` degrees wide, its rings starting at latitude `lat0`. */
const squareKm2 = (side: number, lat0: number) => side * side * Math.cos((lat0 * Math.PI) / 180) * KM_PER_DEGREE ** 2
const radius = (km2: number) => Math.max(1, Math.ceil(Math.sqrt(km2 / Math.PI)))

type Kept = { name: string; context: string; lat: number; lon: number; radiusKm: number; country: string; band: number; people: number; within: string }
let sources: Sources
let file: string
let counts: Record<string, number>
let kept: Kept[]
const one = (name: string, context: string) => {
  const found = kept.filter((r) => r.name === name && r.context.includes(context))
  assert.equal(found.length, 1, `one ${name} in ${context}`)
  return found[0]!
}

before(async () => {
  sources = await serveSources()
  ;({ file, counts } = await buildFixture(sources))
  const db = new DatabaseSync(file, { readOnly: true })
  kept = db.prepare('select * from places').all() as Kept[]
  db.close()
})
after(() => sources.close())

test('it keeps every town but those no longer there, and every colonia with a postal area, each once', () => {
  assert.deepEqual(counts, { towns: 23, countries: 9, colonias: 14, names: 17, gone: 1, colonias_without_area: 1 })
  assert.equal(kept.filter((r) => r.name === 'Ciudad Perdida').length, 0, 'an abandoned place is left out')
  assert.equal(kept.filter((r) => r.name === 'Sin Área').length, 0, 'a colonia with no postal area is left out')
  assert.equal(kept.filter((r) => r.name === 'Del Valle' && r.context.endsWith('66220')).length, 1, 'a repeated line is one colonia')
})

test("a colonia's point is its postal area's centre, never the postal file's, and its size the radius of a circle as big, rounded up", () => {
  const p = one('Del Valle', '66220')
  assert.ok(Math.abs(p.lat - 25.658) < 1e-4 && Math.abs(p.lon + 100.3719) < 1e-4, `${p.lat}, ${p.lon}`)
  const km2 = squareKm2(0.02, 25.648)
  assert.ok(Math.sqrt(km2 / Math.PI) < 1.2, 'just over 1 km, so rounded up to 2')
  assert.equal(p.radiusKm, radius(km2))
  assert.equal(p.radiusKm, 2)
  assert.ok(kept.every((r) => r.lat !== 0 || r.lon !== 0), 'no place at the postal file\'s 0, 0')
  assert.equal(one('Jardines Del Valle', '66220').lat, p.lat, 'colonias of one area share its centre')
})

test("an area's code is five digits, its holes are taken away, and its parts and features are added, whichever way their rings run", () => {
  // 03100: a square of 0.04 degrees with a hole of 0.02 in its north-east quarter.
  const cdmx = one('Del Valle', '03100')
  const outer = squareKm2(0.04, 19.36), hole = squareKm2(0.02, 19.38)
  assert.ok(Math.abs(cdmx.lat - (outer * 19.38 - hole * 19.39) / (outer - hole)) < 1e-4, `${cdmx.lat}`)
  assert.ok(Math.abs(cdmx.lon - (outer * -99.16 - hole * -99.15) / (outer - hole)) < 1e-4, `${cdmx.lon}`)
  assert.equal(cdmx.radiusKm, radius(outer - hole))
  // 25000: three squares of 0.01, two in one feature and one in another, clockwise.
  const centro = one('Centro', '25000')
  assert.ok(Math.abs(centro.lat - (25.42 * 2 + 25.44) / 3) < 1e-3 && Math.abs(centro.lon - (-101.0 * 2 - 100.98) / 3) < 1e-3, `${centro.lat}, ${centro.lon}`)
  assert.equal(centro.radiusKm, radius(3 * squareKm2(0.01, 25.42)))
})

test('each context line: municipio or district, state, country, and a colonia its postal code, with no part twice and Mexico\'s states named once each', () => {
  assert.equal(one('Del Valle', '66220').context, 'San Pedro Garza García, Nuevo León, Mexico, 66220')
  assert.equal(one('Del Valle', '03100').context, 'Benito Juárez, Ciudad de México, Mexico, 03100', 'Distrito Federal is Ciudad de México')
  assert.equal(one('Mexico City', 'Mexico').context, 'Ciudad de México, Mexico', 'GeoNames\' Mexico City is Ciudad de México')
  assert.equal(one('Centro', '25000').context, 'Saltillo, Coahuila, Mexico, 25000', 'Coahuila de Zaragoza is Coahuila')
  assert.equal(one('Monterrey', 'Nuevo León').context, 'Nuevo León, Mexico', 'a municipio named as the place is left out')
  assert.equal(one('Chamberí', 'Spain').context, 'Provincia de Madrid, Madrid, Spain')
  assert.equal(one('Madrid', 'Colombia').context, 'Cundinamarca, Colombia')
  assert.equal(one('Matei', 'Fiji').context, 'Northern, Fiji', 'no municipio, none shown')
})

test("a town's other names are kept once each, but a name its own already matches", () => {
  const db = new DatabaseSync(file, { readOnly: true })
  const others = (name: string) => (db.prepare('select n.name from names n join places p on p.id = n.place where p.name = ? order by n.id').all(name) as Array<{ name: string }>).map((r) => r.name)
  assert.deepEqual(others('Munich'), ['MUC', 'Monaco di Baviera', 'Muenchen', 'Munchen', 'München', 'myunhen'], 'München twice is once; Munchen and München are both kept, as spelled')
  assert.deepEqual(others('Rome'), ['Rom', 'Roma', 'Róma', 'roma'], 'Rome, its own name, is left out')
  assert.deepEqual(others('Tokyo'), ['Tokio', '東京', '東京都'])
  assert.deepEqual(others('Monterrey'), [], 'none for a place with none, and a colonia has none')
  db.close()
})

test('what follows a name to stand alone: a colonia its municipio, a section its city, a town its state, each then the next', () => {
  const within = (name: string, context: string) => one(name, context).within.split('\n')
  assert.deepEqual(within('Del Valle', '66220'), ['San Pedro Garza García', 'Nuevo León', 'Mexico'])
  assert.deepEqual(within('Chamberí', 'Spain'), ['Madrid', 'Madrid', 'Spain'], 'its city: the place with the most people within 30 km')
  assert.deepEqual(within('Colonia del Valle', 'Mexico'), ['Mexico City', 'Ciudad de México', 'Mexico'], 'a section of Mexico City, not a colonia, so with no municipio')
  assert.deepEqual(within('Shibuya', 'Japan'), ['Tokyo', 'Tokyo', 'Japan'])
  assert.deepEqual(within('Barrio Solo', 'Fiji'), ['Northern', 'Fiji'], 'a section with no place within 30 km has its state')
  assert.deepEqual(within('Monterrey', 'Nuevo León'), ['Nuevo León', 'Mexico'])
  assert.deepEqual(within('Levuka', 'Fiji'), ['Fiji'], 'a town with no state has its country')
})

test('a town is sized by its band, from how many live there; a colonia is in the smallest band', () => {
  assert.deepEqual(BANDS.map((b) => b.km), [1, 2, 3, 5, 10, 20])
  const size = (name: string, context: string) => [one(name, context).band, one(name, context).radiusKm]
  assert.deepEqual(size('Monterrey', 'Nuevo León'), [4, 10], '1,135,512 people')
  assert.deepEqual(size('Monterrey', 'Chiapas'), [0, 1], '1,086')
  assert.deepEqual(size('Mexico City', 'Mexico'), [5, 20], '12,294,193')
  assert.deepEqual(size('San Pedro Garza García', 'Nuevo León'), [2, 3], '132,128')
  assert.ok(kept.filter((r) => /\d{5}$/.test(r.context)).every((r) => r.band === 0 && r.people === 0))
})

test('it keeps what each source was: its address, its bytes, their SHA-256 and when the source says it changed', async () => {
  const db = new DatabaseSync(file, { readOnly: true })
  const about = Object.fromEntries((db.prepare('select key, value from about').all() as Array<{ key: string; value: string }>).map((r) => [r.key, JSON.parse(r.value)]))
  db.close()
  assert.equal(about.sources.length, 5 + 3)
  for (const s of about.sources) {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/(geonames|correos)\//)
    assert.match(s.sha256, /^[0-9a-f]{64}$/)
    assert.ok(s.bytes > 0)
    assert.equal(s.modified, 'Tue, 17 Nov 2026 02:51:17 GMT')
  }
  assert.ok(!Number.isNaN(Date.parse(about.built)))
})

test('a check that fails stops the build: it writes no file, and leaves one built before as it was', async () => {
  const dir = tmp()
  const never = { name: 'never', run: () => 'no' }
  await assert.rejects(buildFixture(sources, { dir, checks: [never] }), /never: no/)
  assert.deepEqual(readdirSync(dir), [])
  const passed: string[] = []
  await buildFixture(sources, { dir, checks: [{ name: 'always', run: (p) => (p.find('monterrey').length ? null : 'none') }], log: (l) => passed.push(l) })
  assert.ok(passed.some((l) => l.startsWith('1 checks passed')))
  const before = readFileSync(`${dir}/places.sqlite`)
  await assert.rejects(buildFixture(sources, { dir, checks: [never] }), /never: no/)
  assert.deepEqual(readdirSync(dir), ['places.sqlite'])
  assert.ok(readFileSync(`${dir}/places.sqlite`).equals(before))
})

test('a busy source is asked again after the wait it asks for; a missing one stops the build', async () => {
  sources.busy.add('/geonames/dump/countryInfo.txt')
  const lines: string[] = []
  await buildFixture(sources, { log: (l) => lines.push(l) })
  assert.ok(lines.some((l) => /countryInfo\.txt answered 429; asking again in 0 seconds/.test(l)))
  await assert.rejects(buildFixture({ ...sources, correos: `${sources.correos}/gone` }), /answered 404/)
})
