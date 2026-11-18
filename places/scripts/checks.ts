// What the real data must answer before the build keeps its file (build.ts): each check asks the
// file what the service would be asked, with the service's own code, and says what went wrong.

import type { Place, Places, Point } from '../src/places.ts'
import type { Check, Counts } from './build.ts'

const KM_PER_DEGREE = (Math.PI / 180) * 6371.0088
function km(a: Point, b: Point): number {
  const dLat = b.lat - a.lat
  const dLon = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
  return Math.hypot(dLat, dLon) * KM_PER_DEGREE
}
const show = (p: Place | undefined) => (p ? `${p.name} (${p.context})` : 'nothing')
const point = (lat: number, lon: number): Point => ({ lat, lon })

/** The first place answered is `want`, else what was. */
function first(name: string, ask: (p: Places) => Place[], want: (p: Place) => boolean): Check {
  return {
    name,
    run: (places) => {
      const p = ask(places)[0]
      return p && want(p) ? null : `first was ${show(p)}`
    },
  }
}
/** A town (no postal code) of that name in that context. */
const town = (name: string, context: string) => (p: Place) => p.name === name && p.context.includes(context) && !/\d{5}$/.test(p.context)

function counted(name: string, key: keyof Counts, from: number, to: number): Check {
  return {
    name,
    run: (places) => {
      const n = (places.about().counts as Counts)[key]
      return n >= from && n <= to ? null : `${n}, not ${from} to ${to}`
    },
  }
}

export const CHECKS: Check[] = [
  {
    name: '"del valle" near 25.66, -100.37 is Del Valle, San Pedro Garza García, 66220, within 1 km of 25.6587, -100.3699, size 2 km',
    run: (places) => {
      const p = places.find('del valle', { near: point(25.66, -100.37) })[0]
      if (!p || p.name !== 'Del Valle' || !p.context.includes('San Pedro Garza García') || !p.context.endsWith('66220')) return `first was ${show(p)}`
      const off = km(p, point(25.6587, -100.3699))
      if (off > 1) return `its point is ${off.toFixed(2)} km away`
      return p.radiusKm === 2 ? null : `its size is ${p.radiusKm} km`
    },
  },
  {
    name: '"del valle" alone gives several Del Valles, each with its municipio and postal code, each line different',
    run: (places) => {
      const found = places.find('del valle').filter((p) => p.name === 'Del Valle' && /^[^,]+, .+, \d{5}$/.test(p.context))
      return found.length >= 3 && new Set(found.map((p) => p.context)).size === found.length ? null : `only ${found.map(show).join('; ') || 'none'}`
    },
  },
  first('"monterrey" is the city in Nuevo León, not a village in Chiapas', (p) => p.find('monterrey'), town('Monterrey', 'Nuevo León')),
  first('"chamberi" is Chamberí in Madrid, Spain', (p) => p.find('chamberi'), (p) => p.name === 'Chamberí' && p.country === 'ES' && p.context.includes('Madrid')),
  first('the place nearest 25.66, -100.37 is in San Pedro Garza García', (p) => p.name(point(25.66, -100.37)), (p) => p.context.includes('San Pedro Garza García')),
  {
    name: '"san nicolas" with no point has San Nicolás de los Garza in the first three',
    run: (places) => {
      const three = places.find('san nicolas').slice(0, 3)
      return three.some(town('San Nicolás de los Garza', 'Nuevo León')) ? null : `the first three were ${three.map(show).join('; ')}`
    },
  },
  first('"san nicolas" near 25.68, -100.31 is San Nicolás de los Garza', (p) => p.find('san nicolas', { near: point(25.68, -100.31) }), town('San Nicolás de los Garza', 'Nuevo León')),
  first('"san pedro" near 25.66, -100.37 is San Pedro Garza García', (p) => p.find('san pedro', { near: point(25.66, -100.37) }), town('San Pedro Garza García', 'Nuevo León')),
  first('"guadalupe" near 25.68, -100.31 is Guadalupe, Nuevo León', (p) => p.find('guadalupe', { near: point(25.68, -100.31) }), town('Guadalupe', 'Nuevo León')),
  first('"del valle san pedro garza garcia" is Del Valle, 66220', (p) => p.find('del valle san pedro garza garcia'), (p) => p.name === 'Del Valle' && p.context.endsWith('66220')),
  first('"san nicolas de los garza nuevo leon" is the city', (p) => p.find('san nicolas de los garza nuevo leon'), town('San Nicolás de los Garza', 'Nuevo León')),
  {
    name: '"madrid" near 4.71, -74.07 is Madrid in Colombia, with Madrid in Spain among the 8',
    run: (places) => {
      const found = places.find('madrid', { near: point(4.71, -74.07) })
      if (found[0]?.country !== 'CO' || found[0].name !== 'Madrid') return `first was ${show(found[0])}`
      return found.some((p) => p.name === 'Madrid' && p.country === 'ES') ? null : 'Madrid, Spain is not among them'
    },
  },
  // Another name, in its own language or script, finds the place and is the name shown.
  ...(
    [
      ['münchen', 'München', 'Munich', 48.13743, 11.57549],
      ['roma', 'Roma', 'Rome', 41.89193, 12.51133],
      ['wien', 'Wien', 'Vienna', 48.20849, 16.37208],
      ['lisboa', 'Lisboa', 'Lisbon', 38.72509, -9.1498],
      ['nueva york', 'Nueva York', 'New York City', 40.71427, -74.00597],
      ['cologne', 'Cologne', 'Köln', 50.93333, 6.95],
      ['bombay', 'Bombay', 'Mumbai', 19.07283, 72.88261],
      ['москва', 'Москва', 'Moscow', 55.75204, 37.61781],
      ['東京', '東京', 'Tokyo', 35.6895, 139.69171],
      ['القاهرة', 'القاهرة', 'Cairo', 30.06263, 31.24967],
      ['ciudad de mexico', 'Ciudad de México', 'Mexico City', 19.42847, -99.12766],
    ] as const
  ).map(([q, shown, city, lat, lon]) => first(`"${q}" is ${city}, shown as ${shown}`, (p) => p.find(q), (p) => p.name === shown && km(p, point(lat, lon)) < 1)),
  // The caption each place stands alone with.
  ...(
    [
      ['del valle', point(25.66, -100.37), 'Del Valle, San Pedro Garza García'],
      ['chamberi', undefined, 'Chamberí, Madrid'],
      ['kreuzberg', undefined, 'Kreuzberg, Berlin'],
      ['shibuya', undefined, 'Shibuya, Tokyo'],
      ['monterrey', undefined, 'Monterrey, Nuevo León'],
    ] as const
  ).map(([q, near, name]) => first(`"${q}" stands alone as ${name}`, (p) => p.find(q, { near }), (p) => p.caption === name)),
  counted('the Mexico data holds about 141,000 colonias', 'colonias', 134_000, 148_000),
  counted('the world holds about 237,000 towns and city sections', 'towns', 225_000, 250_000),
  counted('in about 246 countries', 'countries', 240, 250),
  counted('with about 970,000 other names', 'names', 920_000, 1_025_000),
]
