// The service over HTTP, on loopback, against the small world's file (fixtures.ts): how words match,
// the order of what is found, a country, a rough point and its rounding, the places nearest a
// point, the credit, the headers, every error, and that it writes and logs nothing.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'

import { CREDIT, openPlaces, type Place, type Places } from '../src/places.ts'
import { serve, web } from '../src/web.ts'
import { buildFixture, serveSources } from './fixtures.ts'

let file: string
let places: Places
let server: Server
let base: string

before(async () => {
  const sources = await serveSources()
  ;({ file } = await buildFixture(sources))
  await sources.close()
  places = openPlaces(file)
  server = await serve(web(places), 0, '127.0.0.1')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => {
  server.close()
  places.close()
})

async function get(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null }
}
const find = async (query: string) => (await get(`/v1/find?${query}`)).body.places as Place[]
const named = (list: Place[]) => list.map((p) => `${p.name} | ${p.context}`)

test('words match the start of words in the name and the context, whatever their accents and capitals', async () => {
  assert.equal((await find('q=SAN+NICOLAS'))[0]!.name, 'San Nicolás de los Garza')
  assert.equal((await find('q=chamberi'))[0]!.name, 'Chamberí')
  assert.equal((await find('q=nicol'))[0]!.name, 'San Nicolás de los Garza', 'the start of a word')
  assert.deepEqual(await find('q=icolas'), [], 'never its middle')
  assert.deepEqual(named(await find('q=del+valle+san+pedro')).slice(0, 2), ['Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220', 'Jardines Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220'])
  assert.deepEqual(await find('q=del+valle+tokyo'), [], 'every word must match')
})

test('each place answered: its name, context, point, radius and country, and nothing else', async () => {
  const [p] = await find('q=del+valle&near=25.66,-100.37')
  assert.deepEqual(Object.keys(p!), ['name', 'context', 'lat', 'lon', 'radiusKm', 'country'])
  assert.deepEqual(p, { name: 'Del Valle', context: 'San Pedro Garza García, Nuevo León, Mexico, 66220', lat: 25.658, lon: -100.3719, radiusKm: 2, country: 'MX' })
})

test('with no point: a match in the name first, a place of 200,000 or more, then the whole name typed, then bigger, then by name', async () => {
  assert.deepEqual(named(await find('q=monterrey')), [
    'Monterrey | Nuevo León, Mexico',
    'Monterrey | Villaflores, Chiapas, Mexico',
    ...[1, 2, 3, 4, 5, 6].map((n) => `Lomas ${n} | Monterrey, Nuevo León, Mexico, 64000`),
  ])
  assert.deepEqual(named(await find('q=del+valle')), [
    'Colonia del Valle | Ciudad de México, Mexico',
    'Del Valle | Benito Juárez, Ciudad de México, Mexico, 03100',
    'Del Valle | General Escobedo, Nuevo León, Mexico, 66050',
    'Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220',
    'Sant Cugat del Vallès | Província de Barcelona, Catalonia, Spain',
    'Jardines Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220',
  ])
})

test('with a point: near (30 km) before far, then bigger, then the whole name typed, then nearest', async () => {
  assert.deepEqual(named(await find('q=del+valle&near=25.66,-100.37')), [
    'Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220',
    'Del Valle | General Escobedo, Nuevo León, Mexico, 66050',
    'Jardines Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220',
    'Colonia del Valle | Ciudad de México, Mexico',
    'Sant Cugat del Vallès | Província de Barcelona, Catalonia, Spain',
    'Del Valle | Benito Juárez, Ciudad de México, Mexico, 03100',
  ])
  assert.deepEqual(named(await find('q=del+valle&near=19.38,-99.16')).slice(0, 2), ['Colonia del Valle | Ciudad de México, Mexico', 'Del Valle | Benito Juárez, Ciudad de México, Mexico, 03100'])
  assert.deepEqual(named(await find('q=madrid&near=4.71,-74.07')), ['Madrid | Cundinamarca, Colombia', 'Madrid | Provincia de Madrid, Spain', 'Chamberí | Provincia de Madrid, Madrid, Spain'])
})

test('a country keeps only its places; at most 8 come back', async () => {
  assert.deepEqual(named(await find('q=madrid')), ['Madrid | Provincia de Madrid, Spain', 'Madrid | Cundinamarca, Colombia', 'Chamberí | Provincia de Madrid, Madrid, Spain'])
  assert.deepEqual((await find('q=madrid&country=co')).map((p) => p.country), ['CO'])
  assert.deepEqual((await find('q=lomas')).map((p) => p.name), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Lomas ${n}`))
})

test('every point is rounded to two decimals before it is used', async () => {
  for (const path of ['/v1/find?q=del+valle&near=', '/v1/name?near=']) {
    const a = await get(`${path}25.664,-100.374`)
    const b = await get(`${path}25.656,-100.366`)
    const c = await get(`${path}25.66,-100.37`)
    assert.equal(a.text, c.text)
    assert.equal(b.text, c.text)
  }
  assert.deepEqual(places.name({ lat: 25.664, lon: -100.374 }), places.name({ lat: 25.66, lon: -100.37 }), 'whoever calls')
})

test('name: up to 8 places nearest the point, nearest first; places at one point by name', async () => {
  const near = (await get('/v1/name?near=25.66,-100.37')).body.places as Place[]
  assert.deepEqual(named(near).slice(0, 4), [
    'Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220',
    'Jardines Del Valle | San Pedro Garza García, Nuevo León, Mexico, 66220',
    'San Pedro Garza García | Nuevo León, Mexico',
    'Monterrey | Nuevo León, Mexico',
  ])
  assert.equal(near.length, 8)
  assert.equal((await get('/v1/name?near=-16.69,-179.99')).body.places[0].name, 'Matei', 'across 180 degrees')
  assert.equal((await get('/v1/name?near=89.99,0')).body.places.length, 8, 'from the pole')
})

test('every answer credits its sources; GET / says what the file holds and where it came from', async () => {
  for (const path of ['/', '/v1/find?q=monterrey', '/v1/name?near=0,0']) assert.equal((await get(path)).body.credit, CREDIT)
  assert.match(CREDIT, /GeoNames.*CC BY 4\.0.*Correos de México.*CC BY 4\.0/)
  const { body } = await get('/')
  assert.deepEqual(body.counts, { towns: 12, countries: 4, colonias: 14, gone: 1, colonias_without_area: 1 })
  assert.equal(body.sources.length, 8)
  assert.equal(body.find, '/v1/find?q=<words>&country=<XX>&near=<lat>,<lon>')
  assert.equal(body.name, '/v1/name?near=<lat>,<lon>')
})

test('GET and HEAD, JSON, open to any origin, cached a day', async () => {
  const res = await get('/v1/find?q=monterrey')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400')
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const head = await get('/v1/find?q=monterrey', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  const post = await get('/v1/find?q=monterrey', { method: 'POST' })
  assert.deepEqual([post.status, post.body, post.headers.get('allow')], [405, { error: 'get_only' }, 'GET, HEAD'])
})

test('each error, with its code', async () => {
  const errors: Array<[string, number, string]> = [
    ['/v1/find', 400, 'bad_words'],
    ['/v1/find?q=', 400, 'bad_words'],
    ['/v1/find?q=s', 400, 'bad_words'],
    ['/v1/find?q=s,+.', 400, 'bad_words'],
    [`/v1/find?q=${'a'.repeat(101)}`, 400, 'bad_words'],
    ['/v1/find?q=sa&near=north', 400, 'bad_point'],
    ['/v1/find?q=sa&near=91,0', 400, 'bad_point'],
    ['/v1/find?q=sa&near=0,181', 400, 'bad_point'],
    ['/v1/find?q=sa&country=COL', 400, 'bad_country'],
    ['/v1/name', 400, 'bad_point'],
    ['/v1/name?near=25.66', 400, 'bad_point'],
    ['/v1/places', 404, 'not_found'],
  ]
  for (const [path, status, error] of errors) assert.deepEqual([path, (await get(path)).status, (await get(path)).body], [path, status, { error }])
  assert.equal((await get(`/v1/find?q=${'a'.repeat(100)}`)).status, 200, '100 characters is fine')
  assert.equal((await get('/v1/find?q=sa&near=+25.66+,+-100.37+')).status, 200, 'spaces round the point are fine')
})

test('it stores nothing: the file is opened read-only and stays as it was, and no request is logged', async () => {
  const sha = () => createHash('sha256').update(readFileSync(file)).digest('hex')
  const was = sha()
  const logged: unknown[] = []
  const { log, error, warn } = console
  console.log = console.error = console.warn = (...a: unknown[]) => void logged.push(a)
  try {
    for (const path of ['/', '/v1/find?q=del+valle&near=25.66,-100.37', '/v1/name?near=25.66,-100.37', '/v1/find?q=s', '/nope']) await get(path)
  } finally {
    Object.assign(console, { log, error, warn })
  }
  assert.deepEqual(logged, [])
  assert.throws(() => places.db.exec("insert into about (key, value) values ('who', '\"me\"')"), /readonly/)
  assert.equal(sha(), was)
})
