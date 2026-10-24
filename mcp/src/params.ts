// What a tool is: a file in src/tools/ exporting its name, its description, its parameters, whether
// it goes to the person's signer, and its work. A tool that goes to the signer needs a login; one
// that reads what is public does not.

import { type Context, refuse } from './forest.ts'

export type Param = {
  name: string
  type: 'string' | 'object' | 'integer' | 'number' | 'boolean'
  description: string
  required?: boolean
  /** The only values it takes. */
  values?: string[]
  /** The least an integer takes; 0 when omitted. */
  minimum?: number
}

export type Args = { [name: string]: unknown }

/** What a tool works with: the hosts and index it reads, and, for a call with a login, the person's signer. */
export type Ctx = Context & {
  /** Passes `args` to the signer of the call's connection, and gives back what it may pass on. */
  ask: (tool: string, args: Args) => Promise<unknown>
}

export type Tool = {
  name: string
  /** What it does, in plain words. */
  description: string
  params: Param[]
  /** Whether it goes to the person's signer, and so needs a login. */
  relayed: boolean
  run: (args: Args, ctx: Ctx) => Promise<unknown>
}

/** The market and role of the person's profile a relayed tool acts as. */
export const MARKET: Param = { name: 'market', type: 'string', required: true, description: 'The market of the person\'s profile it acts as, such as tutoring.' }
export const ROLE: Param = { name: 'role', type: 'string', required: true, description: 'The role of the person\'s profile it acts as, such as tutor.' }

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
    if (!ok) refuse(`${p.name} is ${KINDS[p.type]}${p.type === 'integer' ? `, from ${least}` : ''}`)
    if (p.values && !p.values.includes(value as string)) refuse(`${p.name} is one of ${p.values.join(', ')}`)
  }
  return args
}
