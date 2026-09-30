// A strict check of JSON-LD against schema.org's own vocabulary (vocabulary.json, cut from a pinned
// release by extract.ts):
//   - every `@type` is a schema.org class;
//   - every property is a schema.org property whose domain takes the node's type (or a parent);
//   - every value fits the property's range: a typed node or a reference whose type (or a parent)
//     is in the range; text only where the range takes Text, a URL, a date or a time; a number only
//     where it takes Number; an enumeration member only where it takes that enumeration;
//   - every `@id` reference points at a node in the same graph.
// It checks the vocabulary, not any search engine's own rules for rich results.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Vocabulary = {
  release: string
  dataTypes: string[]
  classes: Record<string, string[]>
  properties: Record<string, { domain: string[]; range: string[] }>
  members: Record<string, string[]>
}

const vocab: Vocabulary = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vocabulary.json'), 'utf8'))
export const RELEASE = vocab.release

const ancestry = new Map<string, Set<string>>()
function ancestors(cls: string): Set<string> {
  let out = ancestry.get(cls)
  if (out) return out
  out = new Set([cls])
  for (const parent of vocab.classes[cls] ?? []) for (const a of ancestors(parent)) out.add(a)
  ancestry.set(cls, out)
  return out
}

const within = (types: string[], range: string[]) => types.some((t) => range.some((r) => ancestors(t).has(r)))
const TEXTY = ['Text', 'Date', 'DateTime', 'Time']
const SCHEMA = 'https://schema.org/'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }
const isObj = (x: Json): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const typesOf = (n: Obj): string[] => (n['@type'] === undefined ? [] : Array.isArray(n['@type']) ? (n['@type'] as string[]) : [n['@type'] as string])

export function validateJsonLd(doc: Json): string[] {
  const errors: string[] = []
  if (!isObj(doc)) return ['a JSON-LD document is an object']
  if (doc['@context'] !== 'https://schema.org' && doc['@context'] !== 'https://schema.org/') errors.push(`@context is ${JSON.stringify(doc['@context'])}, not https://schema.org`)
  const top: Json[] = Array.isArray(doc['@graph']) ? doc['@graph'] : [doc]

  // Every node that carries a type, by its @id, so references can be followed.
  const byId = new Map<string, Obj>()
  const collect = (x: Json) => {
    if (Array.isArray(x)) return x.forEach(collect)
    if (!isObj(x)) return
    if (typeof x['@id'] === 'string' && x['@type'] !== undefined) byId.set(x['@id'], x)
    for (const [k, v] of Object.entries(x)) if (!k.startsWith('@')) collect(v)
  }
  top.forEach(collect)

  const node = (n: Obj, at: string) => {
    const types = typesOf(n)
    if (!types.length) return errors.push(`${at}: a node with no @type`)
    for (const t of types) {
      if (!(t in vocab.classes)) errors.push(`${at}: ${t} is not a schema.org class`)
      else if (vocab.dataTypes.some((d) => ancestors(t).has(d))) errors.push(`${at}: ${t} is a data type, not a node type`)
    }
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith('@')) continue
      const prop = vocab.properties[key]
      if (!prop) {
        errors.push(`${at}: ${key} is not a schema.org property`)
        continue
      }
      if (prop.domain.length && !within(types, prop.domain)) errors.push(`${at}: ${key} does not apply to ${types.join('/')} (it applies to ${prop.domain.join(', ')})`)
      for (const [i, v] of (Array.isArray(value) ? value : [value]).entries()) valueOf(v, prop.range, `${at}.${key}${Array.isArray(value) ? `[${i}]` : ''}`, key)
    }
  }

  const valueOf = (v: Json, range: string[], at: string, key: string) => {
    if (typeof v === 'string') {
      if (v.startsWith(SCHEMA) && vocab.members[v.slice(SCHEMA.length)]) {
        if (!within(vocab.members[v.slice(SCHEMA.length)], range)) errors.push(`${at}: ${v} is not one of ${range.join(', ')}`)
        return
      }
      if (!within(TEXTY, range) && !range.some((r) => ancestors(r).has('Text'))) errors.push(`${at}: text where ${key} takes ${range.join(', ')}`)
      return
    }
    if (typeof v === 'number') {
      if (!range.some((r) => ancestors(r).has('Number')) && !within(['Number'], range)) errors.push(`${at}: a number where ${key} takes ${range.join(', ')}`)
      return
    }
    if (typeof v === 'boolean') {
      if (!range.includes('Boolean')) errors.push(`${at}: true/false where ${key} takes ${range.join(', ')}`)
      return
    }
    if (!isObj(v)) return errors.push(`${at}: ${JSON.stringify(v)} is not a value schema.org takes`)
    if (v['@type'] === undefined) {
      const id = v['@id']
      const target = typeof id === 'string' ? byId.get(id) : undefined
      if (!target) return errors.push(`${at}: a reference to ${JSON.stringify(id)}, which is not in the graph`)
      if (!within(typesOf(target), range)) errors.push(`${at}: ${typesOf(target).join('/')} where ${key} takes ${range.join(', ')}`)
      return
    }
    if (!within(typesOf(v), range)) errors.push(`${at}: ${typesOf(v).join('/')} where ${key} takes ${range.join(', ')}`)
    node(v, at)
  }

  top.forEach((n, i) => (isObj(n) ? node(n, `@graph[${i}]`) : errors.push(`@graph[${i}] is not a node`)))
  return errors
}
