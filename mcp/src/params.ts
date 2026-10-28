// What a tool is: a file in src/tools/ exporting its name, its description, its parameters, whether
// it goes to the person's app, and its work. A tool that goes to the person's app needs a login;
// one that reads what is public does not.

import { type Answer, type Ask, checkAsk } from '@foundationforest/signers'
import { type Context, refuse } from './forest.ts'

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

/** What a tool works with: the index it reads, and, for a call with a login, the person's app. */
export type Ctx = Context & {
  /** Sends the ask to the person's app over the live link, and gives back its answer, checked. */
  ask: (ask: Ask) => Promise<Answer>
}

export type Tool = {
  name: string
  /** What it does, in plain words. */
  description: string
  params: Param[]
  /** Whether it goes to the person's app, and so needs a login. */
  toApp: boolean
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

/** A tool's arguments as the standard's ask of the tool's name, checked (checkAsk), or a refusal naming what does not fit. */
export function askOf(name: Ask['ask'], args: Args): Ask {
  try {
    return checkAsk({ ask: name, ...args })
  } catch (err) {
    return refuse(`not an ask the person's app takes: ${(err as Error).message}`)
  }
}
