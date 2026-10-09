#!/usr/bin/env node
// forest, the typed door: `forest <action> [<positional>] [--name value …]`, `forest help`, and
// `forest mcp` for the other door. Settings come as flags or from the environment. Keys come only
// from the environment: flags show in the process list and in the shell's history. Objects are
// given as JSON. Every answer is JSON on stdout; a refusal is one line on stderr, and exit status 1.

import type { AddressInfo } from 'node:net'
import { type ParseArgsConfig, parseArgs } from 'node:util'
import { ACTIONS, checkArgs, help } from './actions.ts'
import { type Context, refuse } from './forest.ts'
import { serveHttp, serveStdio } from './mcp.ts'

const SETTINGS = {
  host: { type: 'string', multiple: true },
  index: { type: 'string' },
  profile: { type: 'string' },
} satisfies ParseArgsConfig['options']

type Flags = { host?: string[]; index?: string; profile?: string }

/** The settings and keys a run starts with: each flag, else its variable. An empty variable is none. */
function settings(flags: Flags): Context {
  const env = (name: string) => process.env[name] || undefined
  const hosts = flags.host ?? env('FOREST_HOSTS')?.split(',').map((h) => h.trim()).filter(Boolean)
  const index = flags.index ?? env('FOREST_INDEX')
  const profile = flags.profile ?? env('FOREST_PROFILE')
  return {
    ...(hosts?.length && { hosts }),
    ...(index !== undefined && { index }),
    ...(profile !== undefined && { profile }),
    keys: { write: env('FOREST_WRITE_KEY'), message: env('FOREST_MESSAGE_KEY'), read: env('FOREST_READ_KEY') },
  }
}

async function main([name, ...rest]: string[]): Promise<void> {
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(help())
    return
  }

  if (name === 'mcp') {
    const { values } = parseArgs({ args: rest, options: { ...SETTINGS, http: { type: 'string' } }, strict: true })
    const start = settings(values)
    if (values.http === undefined) return serveStdio(start)
    const at = /^(?:(.+):)?(\d{1,5})$/.exec(values.http) ?? refuse('--http is [hostname:]port')
    const hostname = at[1] ?? '127.0.0.1'
    const http = await serveHttp(start, hostname, Number(at[2]))
    console.error(`forest mcp: http://${hostname}:${(http.address() as AddressInfo).port}/mcp`)
    return
  }

  const action = ACTIONS.find((a) => a.name === name) ?? refuse(`no action ${name}; forest help lists them`)
  const options: ParseArgsConfig['options'] = { ...SETTINGS, ...Object.fromEntries(action.params.map((p) => [p.name, { type: 'string' }])) }
  let parsed
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true })
  } catch (err) {
    return refuse((err as Error).message)
  }
  const { values, positionals } = parsed as { values: Flags & { [name: string]: string | undefined }; positionals: string[] }
  const args: { [name: string]: unknown } = {}
  for (const p of action.params) {
    const flag = values[p.name] as string | undefined
    if (flag === undefined) continue
    if (p.type === 'string') args[p.name] = flag
    else {
      try {
        args[p.name] = JSON.parse(flag)
      } catch {
        refuse(`--${p.name} is not JSON`)
      }
    }
  }
  const slots = action.params.filter((p) => p.positional)
  if (positionals.length > slots.length) refuse(`${name} takes ${slots.length ? slots.map((p) => `<${p.name}>`).join(' ') : 'nothing'} before its flags`)
  positionals.forEach((value, i) => {
    const slot = slots[i]!
    if (args[slot.name] !== undefined) refuse(`give ${slot.name} once`)
    args[slot.name] = value
  })
  const out = await action.run(checkArgs(action, args), settings(values))
  console.log(JSON.stringify(out, null, 2))
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message)
  process.exitCode = 1
})
