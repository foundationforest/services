// The lookup, over the one file (`places.sqlite`), opened read-only: the service writes nothing.
// The build (scripts/build.ts) makes the file with SCHEMA; this reads it, the same code in every
// answer and in the build's own checks.
//
//   find   some words, and a country and a rough point if wanted: up to 8 places, best first
//   name   a point: up to 8 places, nearest first, since colonias that share a postal area share
//          its centre
//
// A point is rounded to two decimals before anything reads it, whoever calls.

import { DatabaseSync } from 'node:sqlite'

import { type Code } from './codes.ts'
import { fold, words } from './fold.ts'

export const FILE = 'places.sqlite'
/** How many places an answer gives, at most. */
export const MAX = 8
/** Near is within this many kilometres of the rough point; a city section's city is within it too. */
export const NEAR_KM = 30
/** A town's size band: from how many live there, its radius. A colonia is in the first. */
export const BANDS = [
  { people: 0, km: 1 },
  { people: 10_000, km: 2 },
  { people: 50_000, km: 3 },
  { people: 200_000, km: 5 },
  { people: 1_000_000, km: 10 },
  { people: 5_000_000, km: 20 },
]
/** With no point, a place in this band or above, 200,000 people or more, comes before the whole name typed. */
const BIG = 3
/** The longest question, in characters, and the fewest letters its words hold. */
export const MAX_LENGTH = 100
export const MIN_LETTERS = 2
/** What every answer credits. */
export const CREDIT =
  'Places from GeoNames (https://www.geonames.org), CC BY 4.0; Mexico\'s colonias placed by Correos de México\'s postal areas (https://datos.gob.mx), CC BY 4.0.'

/**
 * Every place, with what its order needs: `folded` its name as fold() gives it, `band` its size band
 * (0 for a colonia, the smallest), `people` how many live there (0 for a colonia, which has no
 * count), and `within` what may follow its name to stand alone, best first, one a line. `names`
 * holds a town's other names, each folded too, with how many of GeoNames' towns use that spelling. `words` searches each place's name and context,
 * `others` the other names; neither keeps the sizes only a relevance score reads. `spots` finds
 * places by their point; `about` holds when the file was built and from what.
 */
export const SCHEMA = `
create table places (
  id integer primary key,
  name text not null,
  context text not null,
  folded text not null,
  lat real not null,
  lon real not null,
  radiusKm integer not null,
  country text not null,
  band integer not null,
  people integer not null,
  within text not null
);
create table names (id integer primary key, place integer not null, name text not null, folded text not null, uses integer not null);
create virtual table words using fts5 (
  name, context,
  content = 'places', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2', columnsize = 0
);
create virtual table others using fts5 (
  name,
  content = 'names', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2', columnsize = 0
);
create virtual table spots using rtree (id, minLat, maxLat, minLon, maxLon);
create table about (key text primary key, value text not null);
`

/** A place as a listing holds it, the markets' place: a circle, its point as decimal text and its radius in whole kilometres. It holds no name. */
export type Listed = { lat: string; lon: string; radiusKm: number }
/**
 * A place answered: its names, for showing only (the name that matched, its context, and its
 * caption, the name that stands alone, the one line an app or an index shows for the circle), its
 * point, its radius and its country, and the place as a listing holds it.
 */
export type Place = { name: string; context: string; caption: string; lat: number; lon: number; radiusKm: number; country: string; place: Listed }
export type Point = { lat: number; lon: number }

/** A question this service does not answer, with its code. */
export class Refused extends Error {
  readonly code: Code
  constructor(code: Code) {
    super(code)
    this.code = code
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** `lat,lon` as decimal degrees; the point, rounded to two decimals. */
export function readPoint(text: string): Point {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text)
  const lat = Number(m?.[1]), lon = Number(m?.[2])
  if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Refused('bad_point')
  return { lat: round2(lat), lon: round2(lon) }
}

/** Kilometres from the point `$lat`, `$lon` to each place, by the haversine formula. */
const DISTANCE = `2 * 6371.0088 * asin(sqrt(
  pow(sin(radians(p.lat - $lat) / 2), 2) + cos(radians($lat)) * cos(radians(p.lat)) * pow(sin(radians(p.lon - $lon) / 2), 2)))`

const SHOWN = 'p.name, p.context, p.lat, p.lon, p.radiusKm, p.country, p.within'

// Find: each place once, by how it matched. `kind` 0 is its own name holding every word, 1 another
// of its names, 2 its name and context together; `whole`, the name that matched typed whole; and
// `others`, every other name of it that holds every word, for showing the one closest to the words.
//
// The order: a name, its own or another, holding every word before a match that needs the
// context. With a point: near before far, a bigger band, the whole name typed before part of it,
// its own name before another, then nearest. With none: a place of 200,000 people or more, the
// whole name typed, its own name before another, a bigger band, then the most people. Far from
// anyone, a namesake is likelier meant than a town that only starts with the words. Then by name
// and context, so one question always has one answer.
const FOUND = `
with hits as (
  select p.id as place, case when p.id in (select rowid from words where words match $named) then 0 else 2 end as kind,
    null as other, instr($typed, ' ' || p.folded || ' ') > 0 as whole
  from words join places p on p.id = words.rowid
  where words match $all
  union all
  select n.place, 1, n.uses || ' ' || n.name, instr($typed, ' ' || n.folded || ' ') > 0
  from others join names n on n.id = others.rowid
  where others match $all
), best as (
  select place, min(kind) as kind,
    max(case when kind <> 1 then whole end) as ownWhole, max(case when kind = 1 then whole end) as otherWhole,
    group_concat(other, char(10)) as others
  from hits group by place
)
select ${SHOWN}, b.kind, b.others
  %DISTANCE%
from best b join places p on p.id = b.place
where $country is null or p.country = $country
order by %ORDER% limit ${MAX}`
const WHOLE = 'case when b.kind = 1 then b.otherWhole else b.ownWhole end desc'
const FIND_NEAR = FOUND.replace('%DISTANCE%', `, ${DISTANCE} as km`).replace('%ORDER%', `b.kind < 2 desc, km <= ${NEAR_KM} desc, p.band desc, ${WHOLE}, b.kind, km, p.name, p.context`)
const FIND = FOUND.replace('%DISTANCE%', '').replace('%ORDER%', `b.kind < 2 desc, p.band >= ${BIG} desc, ${WHOLE}, b.kind, p.band desc, p.people desc, p.name, p.context`)

// Name's order: nearest, then a bigger band, the most people, then by name and context. The box is
// searched in one or two pieces of longitude, two where it crosses 180 degrees.
const NAMED = `
select ${SHOWN}, km from (
  select p.*, ${DISTANCE} as km from spots s join places p on p.id = s.id
  where s.minLat <= $north and s.maxLat >= $south
    and ((s.minLon <= $east and s.maxLon >= $west) or (s.minLon <= $east2 and s.maxLon >= $west2))
) p order by km, band desc, people desc, name, context limit ${MAX}`
/** Half-widths of the box, in degrees, tried in turn until its inner circle holds the 8th place. */
const BOXES = [0.05, 0.2, 1, 5, 30, 180]
const KM_PER_DEGREE = (Math.PI / 180) * 6371.0088

/**
 * Of the other names that matched, each with how many towns use its spelling, the one to show. A
 * name the words typed differ from only by accents or capitals comes first, shown as GeoNames
 * spells it: a person typing often leaves accents out, so "ciudad de mexico" shows Ciudad de
 * México. Then: one written with capitals, where its script has them, as GeoNames' all-lower-case
 * names are machine spellings; among names that differ only so, the spelling most towns use, then
 * one with accents, so "roma" shows Roma, the name of hundreds of places, not the Hungarian Róma;
 * else the shortest; else the first in code point order.
 */
export function closest(question: string, names: Array<{ name: string; uses: number }>): string {
  const folded = fold(question)
  const accented = (n: string) => /\p{M}/u.test(n.normalize('NFD'))
  const rank = ({ name: n, uses }: { name: string; uses: number }) => {
    const typed = fold(n) === folded
    return [typed ? 0 : 1, n === n.toLowerCase() && n !== n.toUpperCase() ? 1 : 0, typed ? -uses : 0, typed && !accented(n) ? 1 : 0, n.length]
  }
  const before = (a: { name: string; uses: number }, b: { name: string; uses: number }) => {
    const x = rank(a), y = rank(b)
    const i = x.findIndex((v, j) => v !== y[j])
    return i === -1 ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : x[i]! - y[i]!
  }
  return [...names].sort(before)[0]!.name
}

/** A name that stands alone, a place's caption: the name, then the first of `within` that is not the name itself. */
export function alone(name: string, within: string): string {
  const after = within.split('\n').find((part) => part && fold(part) !== fold(name))
  return after ? `${name}, ${after}` : name
}

export type Places = ReturnType<typeof openPlaces>

export function openPlaces(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  const findNear = db.prepare(FIND_NEAR)
  const findAnywhere = db.prepare(FIND)
  const named = db.prepare(NAMED)
  const about = db.prepare('select key, value from about')
  const shown = (r: Record<string, unknown>, name = r.name as string): Place => ({
    name,
    context: r.context as string,
    caption: alone(name, r.within as string),
    lat: r.lat as number,
    lon: r.lon as number,
    radiusKm: r.radiusKm as number,
    country: r.country as string,
    place: { lat: String(r.lat), lon: String(r.lon), radiusKm: r.radiusKm as number },
  })

  return {
    db,
    /** Up to 8 places one of whose names, or whose name and context, hold every word, best first. */
    find(question: string, o: { country?: string; near?: Point } = {}): Place[] {
      const all = words(question)
      if (!all.length || question.length > MAX_LENGTH || all.join('').length < MIN_LETTERS) throw new Refused('bad_words')
      if (o.country !== undefined && !/^[A-Za-z]{2}$/.test(o.country)) throw new Refused('bad_country')
      const match = all.map((w) => `"${w}"*`).join(' ')
      const given = { $all: match, $named: `name : (${match})`, $typed: ` ${fold(question)} `, $country: o.country?.toUpperCase() ?? null }
      const found = o.near ? findNear.all({ ...given, $lat: round2(o.near.lat), $lon: round2(o.near.lon) }) : findAnywhere.all(given)
      const others = (r: Record<string, unknown>) => (r.others as string).split('\n').map((o) => ({ uses: Number(o.slice(0, o.indexOf(' '))), name: o.slice(o.indexOf(' ') + 1) }))
      return found.map((r) => shown(r, r.kind === 1 ? closest(question, others(r)) : (r.name as string)))
    },
    /** Up to 8 places nearest the point, nearest first. */
    name(point: Point): Place[] {
      const lat = round2(point.lat), lon = round2(point.lon)
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Refused('bad_point')
      let found: Array<Record<string, unknown>> = []
      for (const d of BOXES) {
        // A box that reaches a pole takes every longitude, since they all meet there.
        const pole = Math.abs(lat) + d >= 90
        const west = pole ? -180 : lon - d, east = pole ? 180 : lon + d
        found = named.all({
          $lat: lat,
          $lon: lon,
          $north: lat + d,
          $south: lat - d,
          $west: Math.max(west, -180),
          $east: Math.min(east, 180),
          // The piece across 180 degrees, or nothing.
          $west2: east > 180 ? -180 : west < -180 ? west + 360 : 1,
          $east2: east > 180 ? east - 360 : west < -180 ? 180 : 0,
        })
        // The box's inner circle: as far as the box reaches on every side.
        const inner = d * KM_PER_DEGREE * (pole ? 1 : Math.cos(((Math.abs(lat) + d) * Math.PI) / 180))
        if (found.length === MAX && (found[MAX - 1]!.km as number) <= inner) break
      }
      return found.map((r) => shown(r))
    },
    /** When the file was built, from what, and how many places it holds. */
    about(): Record<string, unknown> {
      return Object.fromEntries(about.all().map((r) => [r.key as string, JSON.parse(r.value as string)]))
    },
    close: () => db.close(),
  }
}
