// Cuts schema.org's published vocabulary down to what a validator needs, for vocabulary.json:
// every class and data type with its parents, every property with its domain and range, and every
// enumeration member with its type. Comments and labels are dropped.
//
//   node test/schemaorg/extract.ts                 fetches the pinned release, checks its hash
//   node test/schemaorg/extract.ts <file.jsonld>   reads a copy already on disk, checks its hash
//
// Pinned: schema.org 30.1, the release https://schema.org/version/latest served on 2026-09-25.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE = '30.1'
export const SOURCE = `https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/releases/${RELEASE}/schemaorg-current-https.jsonld`
export const SHA256 = '0a4b8c4c910fc831ec8695196510973390906a5ee34dc6b862dfec4d21a12f74'

type Ref = { '@id': string }
type RawNode = { '@id': string; '@type': string | string[]; 'rdfs:subClassOf'?: Ref | Ref[]; 'schema:domainIncludes'?: Ref | Ref[]; 'schema:rangeIncludes'?: Ref | Ref[] }

const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])
const local = (id: string) => (id.startsWith('schema:') ? id.slice('schema:'.length) : null)

export function extract(text: string) {
  const hash = createHash('sha256').update(text).digest('hex')
  if (hash !== SHA256) throw new Error(`schema.org ${RELEASE}: sha256 ${hash}, expected ${SHA256}`)
  const nodes = (JSON.parse(text) as { '@graph': RawNode[] })['@graph']
  const classes: Record<string, string[]> = {}
  const properties: Record<string, { domain: string[]; range: string[] }> = {}
  const members: Record<string, string[]> = {}
  const dataTypes: string[] = []
  for (const n of nodes) {
    const id = local(n['@id'])
    if (!id) continue
    const types = list(n['@type'])
    if (types.includes('rdfs:Class')) {
      classes[id] = list(n['rdfs:subClassOf']).map((r) => local(r['@id'])).filter((x): x is string => x !== null).sort()
      if (types.includes('schema:DataType')) dataTypes.push(id)
    } else if (types.includes('rdf:Property')) {
      properties[id] = {
        domain: list(n['schema:domainIncludes']).map((r) => local(r['@id'])!).filter(Boolean).sort(),
        range: list(n['schema:rangeIncludes']).map((r) => local(r['@id'])!).filter(Boolean).sort(),
      }
    } else {
      // An enumeration member: typed by its enumeration.
      const of = types.map(local).filter((x): x is string => x !== null)
      if (of.length) members[id] = of.sort()
    }
  }
  const sorted = <V>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
  return { release: RELEASE, source: SOURCE, sha256: SHA256, dataTypes: dataTypes.sort(), classes: sorted(classes), properties: sorted(properties), members: sorted(members) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const from = process.argv[2]
  const text = from ? readFileSync(from, 'utf8') : await (await fetch(SOURCE)).text()
  const out = join(dirname(fileURLToPath(import.meta.url)), 'vocabulary.json')
  // One entry per line: small, and a new release diffs line by line.
  const v = extract(text)
  const block = (o: Record<string, unknown>) => `{\n${Object.entries(o).map(([k, x]) => `  ${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(',\n')}\n }`
  const body = Object.entries(v).map(([k, x]) => ` ${JSON.stringify(k)}: ${x && typeof x === 'object' && !Array.isArray(x) ? block(x as Record<string, unknown>) : JSON.stringify(x)}`)
  writeFileSync(out, `{\n${body.join(',\n')}\n}\n`)
  console.log(`wrote ${out}`)
}
