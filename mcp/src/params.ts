// What a tool is: a file in src/tools/ exporting its name, its title, its description, its
// parameters, whether it acts for the person, the hints AI apps group tools by, and its work. A
// tool that acts for the person needs a login; one that reads what is public does not.

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { type Context, refuse } from './forest.ts'
import type { Pack } from './pack.ts'

export type Param = {
  name: string
  type: 'string' | 'object' | 'integer' | 'number' | 'boolean'
  description: string
  required?: boolean
  /** Whether it may also be null. */
  nullable?: boolean
  /** The only values it takes. */
  values?: string[]
  /** The least an integer takes; 0 when omitted. */
  minimum?: number
}

export type Args = { [name: string]: unknown }

/** What a tool works with: the index it reads, how it reaches hosts, and, for a call with a login, the person's pack. */
export type Ctx = Context & {
  /** The fetch every host is reached with: one that reaches only public addresses, unless told otherwise. */
  hostFetch: typeof fetch
  /** The pack the call's token carries, opened in memory for this request; refused with no login. */
  pack: () => Promise<Pack>
  /** The person's own addresses this request has seen, each with what an answer says instead: its profiles' by their labels, and the pay addresses of each profile entry it read. */
  own: Map<string, string>
}

export type Tool = {
  name: string
  /** Its name for people, in an AI app's list of tools. */
  title: string
  /** What it does, in plain words. */
  description: string
  params: Param[]
  /** Whether it acts for the person, and so needs a login. */
  login: boolean
  /** The MCP specification's hints: whether it only reads, may destroy, and reaches outside this copy. */
  annotations: ToolAnnotations
  run: (args: Args, ctx: Ctx) => Promise<unknown>
}

const KINDS: { [type in Param['type']]: string } = { string: 'text', object: 'an object', integer: 'a whole number', number: 'a number', boolean: 'true or false' }

/** A tool's arguments, checked: every required one there, each of its type, and nothing else. */
export function checkArgs(tool: Pick<Tool, 'name' | 'params'>, args: Args): Args {
  for (const name of Object.keys(args)) if (!tool.params.some((p) => p.name === name)) refuse(`${tool.name} takes no ${name}`)
  for (const p of tool.params) {
    const value = args[p.name]
    if (value === undefined) {
      if (p.required) refuse(`${tool.name} needs ${p.name}`)
      continue
    }
    if (value === null && p.nullable) continue
    const least = p.minimum ?? 0
    const ok =
      p.type === 'string'
        ? typeof value === 'string'
        : p.type === 'integer'
          ? Number.isSafeInteger(value) && (value as number) >= least
          : p.type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : p.type === 'boolean'
              ? typeof value === 'boolean'
              : value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!ok) refuse(`${p.name} is ${KINDS[p.type]}${p.type === 'integer' ? `, from ${least}` : ''}${p.nullable ? ', or null' : ''}`)
    if (p.values && !p.values.includes(value as string)) refuse(`${p.name} is one of ${p.values.join(', ')}`)
  }
  return args
}
