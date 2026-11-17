# places

places turns words into places: a town, a section of a city or, in Mexico, a colonia, each with
its point, its size in whole kilometres, its name, a line saying where it is, its country, and the
place as a listing holds it. Words in any language or script find a place by any of its names. No
one types a point or a place's name by hand, and an app and a person's AI asking the same words get
the same answer. Anyone can ask, with a plain GET and no login; the main way is an app or an AI
filling a listing's place. This is the Forest Foundation's copy. Anyone can run another; the main
way is this code, whose one script builds the same file from the same public data. It keeps that
one file, built from GeoNames and Correos de México's postal areas, and nothing of anyone's: the
service stores nothing and logs no question.

## How it works

```
GeoNames: towns, their other names, states ───────┐
GeoNames: Mexico's postal file (colonias' names) ─┼──▶ npm run build ──▶ places.sqlite ──▶ find, name
Correos de México: postal areas (points, sizes) ──┘    (checks it first)  (read-only)
```

`npm run build` (`scripts/build.ts`) downloads every source into memory, writes one SQLite file,
checks it with the service's own code (`scripts/checks.ts`), and only then keeps it: a build whose
checks fail writes no file. The service (`src/`) opens that file read-only and answers from it.

### The data

| What | Source | Gives |
|---|---|---|
| Towns and city sections | GeoNames' `cities500.zip`: every populated place of 500 people or more, and each seat of an administrative area | name, other names, point, people, country |
| Where each is | GeoNames' `admin1CodesASCII.txt`, `admin2Codes.txt` and `countryInfo.txt` | its state, municipio or district, and country's names |
| Mexico's colonias | GeoNames' postal file for Mexico, `zip/MX.zip` | name, municipio, state, postal code. Never its points |
| Each colonia's point and size | Correos de México's postal areas, "Códigos postales por entidad federativa" on datos.gob.mx | the area its postal code covers |

GeoNames is at https://download.geonames.org/export, under CC BY 4.0. Correos de México's areas are
its edition 11 (2025-01-15), under CC BY 4.0, as
[open-mexico/mexico-geojson](https://github.com/open-mexico/mexico-geojson) copied them from
datos.gob.mx, one GeoJSON file a state, at its tag `2025.1`, commit `8b32f43`.

- **A town** is every place in `cities500` but those GeoNames marks as no longer there: abandoned
  (`PPLQ`), historical (`PPLH`) and destroyed (`PPLW`). It keeps every other name GeoNames gives it,
  in any language or script, its codes and spellings among them, once each, but those its own name
  already matches. Its size is its band, by its people:

  | People | Band | `radiusKm` |
  |---|---|---|
  | under 10,000 | 0 | 1 |
  | 10,000 to 49,999 | 1 | 2 |
  | 50,000 to 199,999 | 2 | 3 |
  | 200,000 to 999,999 | 3 | 5 |
  | 1,000,000 to 4,999,999 | 4 | 10 |
  | 5,000,000 and over | 5 | 20 |

- **A colonia** is each name, municipio and postal code in the postal file, once. Its point is the
  centre of its postal area: each part's centre weighed by its area, each hole's taken away. Its
  size is the radius of a circle as big as the area, rounded up to whole kilometres, at least 1. A
  colonia whose postal code has no area, or an area of none, is left out. Colonias of one postal
  area share its point and size. A colonia is in band 0.
- **Its context** is its municipio (or GeoNames' second level elsewhere: a district, a county or a
  province), its state, its country, and a colonia's postal code, with any part that repeats the
  name or the part before it left out: "San Pedro Garza García, Nuevo León, Mexico, 66220". Mexico's
  states have one name each: "Ciudad de México" for GeoNames' "Mexico City" and the postal file's
  "Distrito Federal", and "Coahuila", "Michoacán" and "Veracruz" for the postal file's long names.
- **Alone, in a listing,** a colonia's name goes with its municipio, "Del Valle, San Pedro
  Garza García"; a city section's with its city, "Chamberí, Madrid"; a town's with its state,
  "Monterrey, Nuevo León". GeoNames gives a section no city, so its city is the place with the most
  people within 30 km of it, in its country, that is not a section itself; with none, its state. A
  part that is the name itself gives way to the next: the state, then the country.
- **The checks** ask the file what the service would be asked, such as "del valle" near San Pedro
  Garza García giving Del Valle, 66220, within a kilometre of its centre, "москва" giving Moscow,
  and the counts of towns, countries and colonias; `scripts/checks.ts` lists them all.

### Finding

Each word matches the start of a word, whatever its accents and capitals, and every word must
match: in a place's own name, in one of its other names, or in its own name and its context
together. **The order:** a name, its own or another, holding every word comes before a match that
needs the context; then, with a point, a place within 30 km before one farther, a bigger band, the
whole name typed before part of it, its own name before another, and the nearest; with none, a
place of 200,000 people or more, the whole name typed, its own name before another, a bigger band,
and the most people; then by name. Up to 8 places.

Near a person, a bigger place is likelier meant than a small namesake: San Pedro Garza García before
a colonia named San Pedro. Far from anyone, a namesake is likelier than a town that only starts with
the words: a Del Valle before Sant Cugat del Vallès, unless the town is big, as San Nicolás de los
Garza is. A whole name typed counts before whose name it is: "münchen" is Munich, by its other name
München, before Ottobrunn bei München, whose own name only holds the word.

**When another name matched,** it is the name shown, so a person gets the place in their own words
and no one needs to know their language: the one written as the words were typed, but for capitals;
else the whole name typed, but for accents; else one written with capitals, where its script has
them, since GeoNames' names all in lower case are machine spellings; else the shortest. Its own name
matching, even as the start of a word, is shown instead: "rom" gives Rome.

**Naming a point** gives up to 8 places whose points are nearest it, nearest first; places at one
point by band, then people, then name. A colonia's point is its postal area's centre, so the
colonias of one area come together and the person picks.

Every point it is given is rounded to two decimals, about a kilometre, before anything reads it.

## Its API

GET and HEAD only, JSON, open to any origin (`access-control-allow-origin: *`), cached a day
(`cache-control: public, max-age=86400`): answers change only with a new file, which comes only
with a new image.

| Path | Answer |
|---|---|
| `/` | `{ built, counts, sources, find, name, credit }`: when the file was built, `counts` its `towns`, `countries`, `colonias`, the towns' other `names`, the places left out as no longer there (`gone`) and the colonias with no postal area (`colonias_without_area`), and `sources` each file it read: `{ url, bytes, sha256, modified }`, `modified` the source's Last-Modified |
| `/v1/find?q=<words>`, with `country=<XX>` and `near=<lat>,<lon>` if wanted | `{ places, credit }`: up to 8, best first. `country` two letters (ISO 3166), in any case |
| `/v1/name?near=<lat>,<lon>` | `{ places, credit }`: up to 8, nearest first |

A place is `{ name, context, lat, lon, radiusKm, country, place }`: `name` the name that matched,
`lat` and `lon` in degrees to four decimals, `radiusKm` in whole kilometres, `country` two letters
in capitals, for showing a list. `place` is the same place as a listing holds it, in the markets'
place, `{ lat, lon, radiusKm, name, country }`: `lat` and `lon` as decimal text, a name that stands
alone, so an app and an AI write the same value:

```json
{ "lat": "40.434", "lon": "-3.7038", "radiusKm": 3, "name": "Chamberí, Madrid", "country": "ES" }
```

`credit` names GeoNames and Correos de México, each under CC BY 4.0.

Errors are `{ "error": "<code>" }`:

| Code | Status | When |
|---|---|---|
| `bad_words` | 400 | No words, fewer than 2 letters in them, or more than 100 characters |
| `bad_point` | 400 | `near` is not `<lat>,<lon>` in degrees, or is missing from `/v1/name` |
| `bad_country` | 400 | `country` is not two letters |
| `not_found` | 404 | Any other path |
| `get_only` | 405 | Any method but GET and HEAD |
| `failed` | 500 | The service could not answer |

## How we run it

- **The image:** `deploy/Dockerfile`, built from the repo root: Node 22.22.2, this directory, and
  `npm run build` run inside it, so the file is in the image and there is no volume; started as
  `node src/main.ts`. Its build downloads about 340 MB, so it is built again only when `places/`
  changes.
- **Where:** one replica of the image; a copy that answers more runs more replicas, each with the
  same file.
- **Free,** with no rate limit. **Stores** nothing. **Logs** one line when it starts, and for a
  request that fails its error's kind only, never its path, its question or the error's message.
- **Its numbers, and why:**
  - 8 places an answer: enough for a person to pick from;
  - 30 km is near: a city and its suburbs, and as far as a city section looks for its city;
  - 200,000 people is big: a town that size outranks a namesake when no point is given;
  - 2 letters at least: one letter matches about 170,000 places; two match about 100,000 names
    and take about 120 ms, 220 at most. Most words take under 5 ms;
  - 100 characters at most, and points to two decimals;
  - a source that answers 429 or 5xx asked again up to 5 times, after the wait it asks for or 10,
    20, 40 and 80 seconds: GitHub's raw files answer 429 to many downloads from one address.
- **Public:** everything it answers, and the file, which anyone builds again. **Secret:** none.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | `./data` | Where `npm run build` writes `places.sqlite`, and where the service reads it |
| `PORT` | `8080` | |

A missing file stops the start, naming it.

```
cd places && npm ci
npm run check && npm test
npm run build                        # downloads about 340 MB, writes data/places.sqlite
npm start
```

`test/` covers, on loopback, with a small world of its own in the sources' formats: the whole build
(what it keeps and leaves out, each centre and size against squares worked out by hand, holes,
parts, codes as numbers, other names, context lines, names alone, bands, the checks that stop
it, a busy source), and the service over HTTP (matching, other names in two scripts and the one
shown, both orders, a country, rounding, naming a point across 180 degrees and from a pole, each
answer's place against the markets' patterns, the credit, headers, every error, and that it writes
and logs nothing).

## Promises

- **No login, no account, free:** a plain GET, open to any origin.
- **The service stores nothing.** It opens its one file read-only, keeps nothing between requests
  and logs no question: the same question gets the same answer, whoever asks.
- **Every point it is given is rounded to two decimals before it is used:** 25.664, -100.374 and
  25.656, -100.366 get the same answer.
- **Its data is public and credited:** one script builds the file from GeoNames and Correos de
  México's postal areas; every answer credits both, and `/` gives each file's address and SHA-256.
- **A colonia's point is its postal area's centre,** never the postal file's point.

## Limits

- **Colonias in Mexico only:** elsewhere, towns and city sections of 500 people or more, as
  GeoNames lists them.
- **Colonias of one postal area share its point and size,** about five an area.
- **A centre can fall outside its area:** 594 of the 36,182 postal areas bend or come in parts.
- **A town's size is its band,** from its people, not its area.
- **Another name is matched alone,** never with the context: "münchen germany" finds no Munich.
- **Only the names GeoNames gives:** a colonia has its one name; a town missing a name people use is
  not found by it.
- **A section's city is the biggest place near it,** which can be a neighbouring city, and a name
  that stands alone puts other names with the state or city in GeoNames' own word, often English:
  "München, Bavaria".
- **Kosovo's places carry `XK`,** GeoNames' code, which the markets' countries list does not hold:
  the 77 of them make a place no listing takes until it does.
- **Words match from their start:** no spelling mistakes, no middle of a word.
- **Only colonias GeoNames' postal file holds,** and of those, 3,692 whose postal code has no area,
  or an area of none, are left out.
- **The data is as of the image's build:** GeoNames changes every day and keeps no old files, so two
  builds can differ.
- **Names as their sources write them,** countries in English.
- **A hosting provider's own request logs** may hold each request's address and path, its words and
  its point as sent: only a caller who rounds a point before sending keeps it rough there.

## FAQ

**Why not the postal file's points?**
45% of them (63,807 of the 140,963 colonias kept) lie outside their own postal area. The postal
file's point for Del Valle, 66220, is about 19 km from it.

**Why is the size rounded up?**
So the circle is at least as big as the area. Del Valle's postal area, 66220, is 3.6 km², a circle
of 1.07 km: rounded to the nearest, 1 km, its circle would cover less than the area.

**Why a service, and not a file in the app?**
The file is about 130 MB, and an app and a person's AI must get the same answer.

**Why the copy of Correos de México's areas, and not datos.gob.mx?**
The copy holds Correos de México's edition 11 as GeoJSON, one file a state, at a commit that never
changes, so every build reads the same bytes.
