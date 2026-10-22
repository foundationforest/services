// What a tool is, for both doors: a file in src/tools/ exporting its name, its description (the key
// it needs, first), its parameters and its work. The profile it acts for and the key it needs are
// parameters like any other, by three names the doors know: a call that carries none of them uses
// the ones the copy started with.

import type { Context } from './forest.ts'
import { refuse } from './forest.ts'

export type Param = {
  name: string
  type: 'string' | 'object' | 'integer' | 'number' | 'boolean'
  description: string
  required?: boolean
  /** The only values it takes. */
  values?: string[]
  /** The least an integer takes; 0 when omitted. */
  minimum?: number
  /** Given first, without its flag, at the typed door. */
  positional?: boolean
}

export type Args = { [name: string]: unknown }

export type Tool = {
  name: string
  /** What it does, in plain words, starting with the key it needs: `No key.`, `Write key.` or `Read key.` */
  description: string
  params: Param[]
  run: (args: Args, ctx: Context) => Promise<unknown>
}

export const PROFILE: Param = { name: 'profile', type: 'string', description: "The address of the profile acted for, as the person's app gives it." }
export const WRITE_KEY: Param = { name: 'writeKey', type: 'string', description: "The write key, as the person's app gives it: its 32 bytes in base64url." }
export const READ_KEY: Param = { name: 'readKey', type: 'string', description: "The read key, as the person's app gives it: its 32 bytes in base64url." }

/** The parameters a call may leave out when the copy started with them. */
export const FROM_START = [PROFILE.name, WRITE_KEY.name, READ_KEY.name] as const
export type Start = { [name in (typeof FROM_START)[number]]?: string }

/** A post's or a review's id: `<prefix>/<id>` in the profile's folder. */
export const id = (prefix: string): Param => ({ name: 'id', type: 'string', positional: true, description: `The id in ${prefix}/<id>: needed to update or remove; a fresh one when left out to post.` })
/** What a write does at its path. */
export const ACTION: Param = { name: 'action', type: 'string', required: true, positional: true, values: ['post', 'update', 'remove'], description: 'post a new one, update one, or remove one.' }

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
