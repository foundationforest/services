// A small world for the tests, in the sources' own formats, served on loopback as the real sources
// serve them: GeoNames' files (two of them zipped) and three states' postal areas, each area a
// square, so every centre and size is worked out by hand. Every colonia's point in the postal file
// is 0, 0, which the build must never use.

import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'

import { build, type Check } from '../scripts/build.ts'

const tsv = (lines: Array<Array<string | number>>) => lines.map((r) => r.join('\t')).join('\n') + '\n'

/** A cities500 line: GeoNames' 19 columns, its other names comma-separated. */
const city = (id: number, name: string, lat: number, lon: number, feature: string, cc: string, a1: string, a2: string, people: number, others = '') =>
  [id, name, name, others, lat, lon, 'P', feature, cc, '', a1, a2, '', '', people, '', '', '', '2026-01-01']

export const CITIES = tsv([
  city(1, 'Monterrey', 25.68435, -100.31721, 'PPLA', 'MX', '19', '039', 1135512),
  city(2, 'Monterrey', 16.06112, -93.36898, 'PPL', 'MX', '05', '107', 1086),
  city(3, 'San Nicolás de los Garza', 25.74167, -100.30222, 'PPL', 'MX', '19', '046', 412199),
  city(4, 'San Nicolás', 16.5, -93.0, 'PPL', 'MX', '05', '107', 600),
  city(5, 'San Pedro Garza García', 25.66158, -100.4034, 'PPL', 'MX', '19', '019', 132128),
  city(6, 'Mexico City', 19.42847, -99.12766, 'PPLC', 'MX', '09', '', 12294193, 'CDMX,Ciudad de Mexico,Ciudad de México,Mexico City'),
  city(7, 'Chamberí', 40.43404, -3.70379, 'PPLX', 'ES', '29', 'M', 145934),
  city(8, 'Madrid', 40.4165, -3.70256, 'PPLC', 'ES', '29', 'M', 3255944),
  city(9, 'Madrid', 4.73245, -74.26419, 'PPLA2', 'CO', '33', '25430', 135000),
  city(10, 'Colonia del Valle', 19.3861, -99.162, 'PPLX', 'MX', '09', '', 250000),
  city(11, 'Sant Cugat del Vallès', 41.4706, 2.0861, 'PPL', 'ES', '56', 'B', 90000),
  city(12, 'Ciudad Perdida', 20.0, -100.0, 'PPLQ', 'MX', '19', '039', 5000),
  city(13, 'Matei', -16.69, 179.99, 'PPL', 'FJ', '03', '', 700),
  // Other names: in other languages and scripts, a code, a machine spelling in lower case, one
  // spelled as the main name, and one twice.
  city(14, 'Munich', 48.13743, 11.57549, 'PPLA', 'DE', '02', '091', 1505005, 'MUC,Monaco di Baviera,Muenchen,Munchen,München,München,myunhen'),
  city(15, 'Ottobrunn bei München', 48.0649, 11.6633, 'PPL', 'DE', '02', '091', 21000),
  city(16, 'Rome', 41.89193, 12.51133, 'PPLC', 'IT', '07', 'RM', 2318895, 'Rom,Roma,Rome,Róma,roma'),
  city(24, 'Roma', -29.4467, 27.7081, 'PPL', 'LS', '', '', 9000),
  city(17, 'La Romana', 18.42733, -68.97285, 'PPLA', 'DO', '12', '', 208437),
  city(18, 'Tokyo', 35.6895, 139.69171, 'PPLC', 'JP', '40', '', 9733276, 'Tokio,東京,東京都'),
  city(19, 'Shibuya', 35.6589, 139.70665, 'PPLX', 'JP', '40', '', 230609),
  // Two of one band, the whole name typed, one by its own name and one by another.
  city(20, 'Aldea', 16.2, -93.1, 'PPL', 'MX', '05', '107', 600),
  city(21, 'Pueblo', 16.3, -93.2, 'PPL', 'MX', '05', '107', 700, 'Aldea'),
  // A section with no place within 30 km but sections, and a town with no state.
  city(22, 'Barrio Solo', -17.3, 178.4, 'PPLX', 'FJ', '03', '', 900),
  city(23, 'Levuka', -17.68, 178.83, 'PPL', 'FJ', '', '', 1100),
])
export const ADMIN1 = tsv([
  ['MX.19', 'Nuevo León', 'Nuevo Leon', 3522542],
  ['MX.05', 'Chiapas', 'Chiapas', 3531011],
  ['MX.09', 'Mexico City', 'Mexico City', 3527646],
  ['ES.29', 'Madrid', 'Madrid', 3117732],
  ['ES.56', 'Catalonia', 'Catalonia', 3336901],
  ['CO.33', 'Cundinamarca', 'Cundinamarca', 3685413],
  ['FJ.03', 'Northern', 'Northern', 2194370],
  ['DE.02', 'Bavaria', 'Bavaria', 2951839],
  ['IT.07', 'Lazio', 'Lazio', 3174976],
  ['DO.12', 'La Romana', 'La Romana', 3500956],
  ['JP.40', 'Tokyo', 'Tokyo', 1850144],
])
export const ADMIN2 = tsv([
  ['MX.19.039', 'Monterrey', 'Monterrey', 1],
  ['MX.05.107', 'Villaflores', 'Villaflores', 2],
  ['MX.19.046', 'San Nicolás de los Garza', 'San Nicolas de los Garza', 3],
  ['MX.19.019', 'San Pedro Garza García', 'San Pedro Garza Garcia', 4],
  ['ES.29.M', 'Provincia de Madrid', 'Provincia de Madrid', 5],
  ['ES.56.B', 'Província de Barcelona', 'Provincia de Barcelona', 6],
  ['CO.33.25430', 'Madrid', 'Madrid', 7],
  ['DE.02.091', 'Upper Bavaria', 'Upper Bavaria', 8],
  ['IT.07.RM', 'Città metropolitana di Roma Capitale', 'Citta metropolitana di Roma Capitale', 9],
])
export const COUNTRIES = '# GeoNames country info\n#ISO\tISO3\tISO-Numeric\tfips\tCountry\n' + tsv([
  ['MX', 'MEX', 484, 'MX', 'Mexico'],
  ['ES', 'ESP', 724, 'SP', 'Spain'],
  ['CO', 'COL', 170, 'CO', 'Colombia'],
  ['FJ', 'FJI', 242, 'FJ', 'Fiji'],
  ['DE', 'DEU', 276, 'GM', 'Germany'],
  ['IT', 'ITA', 380, 'IT', 'Italy'],
  ['DO', 'DOM', 214, 'DR', 'Dominican Republic'],
  ['JP', 'JPN', 392, 'JA', 'Japan'],
  ['LS', 'LSO', 426, 'LT', 'Lesotho'],
])

/** A postal-file line: its point is always 0, 0. */
const colonia = (code: string, name: string, state: string, municipio: string) => ['MX', code, name, state, '00', municipio, '000', municipio, '00', '0.0', '0.0', 1]
export const POSTAL = tsv([
  colonia('66220', 'Del Valle', 'Nuevo León', 'San Pedro Garza García'),
  colonia('66220', 'Jardines Del Valle', 'Nuevo León', 'San Pedro Garza García'),
  colonia('66220', 'Del Valle', 'Nuevo León', 'San Pedro Garza García'),
  colonia('66050', 'Del Valle', 'Nuevo León', 'General Escobedo'),
  colonia('03100', 'Del Valle', 'Distrito Federal', 'Benito Juárez'),
  colonia('25000', 'Centro', 'Coahuila de Zaragoza', 'Saltillo'),
  colonia('99999', 'Sin Área', 'Nuevo León', 'Monterrey'),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => colonia('64000', `Lomas ${n}`, 'Nuevo León', 'Monterrey')),
])

/** A square ring of side `side` degrees round a centre, counterclockwise unless asked. */
export function square(lat: number, lon: number, side: number, clockwise = false): number[][] {
  const h = side / 2
  const ring = [[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]]
  return clockwise ? ring.reverse() : ring
}
const feature = (code: number | string, type: 'Polygon' | 'MultiPolygon', coordinates: unknown) => ({ type: 'Feature', properties: { d_codigo: code }, geometry: { type, coordinates } })
export const STATES = {
  '19-NL': [
    feature(66220, 'Polygon', [square(25.658, -100.3719, 0.02)]),
    feature(66050, 'Polygon', [square(25.8035, -100.3181, 0.02)]),
    feature(64000, 'Polygon', [square(25.67, -100.31, 0.01)]),
  ],
  // 03100, as the copy gives it: a number. An area with a hole in its north-east quarter.
  '09-Cdmx': [feature(3100, 'Polygon', [square(19.38, -99.16, 0.04), square(19.39, -99.15, 0.02)])],
  // 25000 in two features: two squares, and a third whose ring runs clockwise.
  '05-Coah': [
    feature(25000, 'MultiPolygon', [[square(25.42, -101.0, 0.01)], [square(25.42, -100.98, 0.01)]]),
    feature('25000', 'Polygon', [square(25.44, -101.0, 0.01, true)]),
  ],
}

export type Sources = { geonames: string; correos: string; asked: string[]; busy: Set<string>; close(): Promise<void> }

/** The sources on loopback. A path in `busy` answers 429 once, with Retry-After: 0. */
export async function serveSources(): Promise<Sources> {
  const files: Record<string, Uint8Array> = {
    '/geonames/dump/countryInfo.txt': new TextEncoder().encode(COUNTRIES),
    '/geonames/dump/admin1CodesASCII.txt': new TextEncoder().encode(ADMIN1),
    '/geonames/dump/admin2Codes.txt': new TextEncoder().encode(ADMIN2),
    '/geonames/dump/cities500.zip': zipSync({ 'cities500.txt': new TextEncoder().encode(CITIES) }),
    '/geonames/zip/MX.zip': zipSync({ 'MX.txt': new TextEncoder().encode(POSTAL), 'readme.txt': new TextEncoder().encode('GeoNames postal codes\n') }),
    ...Object.fromEntries(Object.entries(STATES).map(([s, features]) => [`/correos/${s}.geojson`, new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', features }))])),
  }
  const asked: string[] = []
  const busy = new Set<string>()
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/'
    asked.push(path)
    if (busy.delete(path)) {
      res.writeHead(429, { 'retry-after': '0' }).end()
      return
    }
    const file = files[path]
    if (!file) res.writeHead(404).end()
    else res.writeHead(200, { 'last-modified': 'Tue, 17 Nov 2026 02:51:17 GMT' }).end(file)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { geonames: `${base}/geonames`, correos: `${base}/correos`, asked, busy, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

export const tmp = () => mkdtempSync(join(tmpdir(), 'places-'))

/** The small world's file, built in a new directory. */
export async function buildFixture(sources: Sources, o: { dir?: string; checks?: Check[]; log?: (line: string) => void } = {}) {
  return build({ dir: o.dir ?? tmp(), sources: { geonames: sources.geonames, correos: sources.correos }, states: Object.keys(STATES), checks: o.checks, log: o.log })
}
