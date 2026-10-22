#!/usr/bin/env node
// forest, the typed door: `forest <tool> [<positional>] [--name value …]`, `forest help`, and
// `forest mcp` for the other door. Settings come as flags or from the environment. Keys come only
// from the environment: flags show in the process list and in the shell's history. Objects are
// given as JSON. Every answer is JSON on stdout; a refusal is one line on stderr, and exit status 1.

import type { AddressInfo } from 'node:net'
import { type ParseArgsConfig, parseArgs } from 'node:util'
import { type Context, HOST, INDEX, hostsFrom, refuse } from './forest.ts'
import { serveHttp, serveStdio, withStart } from './mcp.ts'
import { FROM_START, type Start, checkArgs } from './params.ts'
import { TOOLS, help } from './tools.ts'

const SETTINGS = {
  host: { type: 'string', multiple: true },
  index: { type: 'string' },
  profile: { type: 'string' },
} satisfies ParseArgsConfig['options']

type Flags = { host?: string[]; index?: string; profile?: string }

/** The settings and keys a run starts with: each flag, else its variable, else its default. An empty variable is none. */
function settings(flags: Flags): { ctx: Context; start: Start } {
  const env = (name: string) => process.env[name] || undefined
  const hosts = flags.host ?? env('FOREST_HOSTS')?.split(',').map((h) => h.trim()).filter(Boolean)
  const profile = flags.profile ?? env('FOREST_PROFILE')
  const writeKey = env('FOREST_WRITE_KEY')
  const readKey = env('FOREST_READ_KEY')
  return {
    ctx: { hosts: hostsFrom(hosts?.length ? hosts : [HOST]), index: flags.index ?? env('FOREST_INDEX') ?? INDEX },
    start: { ...(profile && { profile }), ...(writeKey && { writeKey }), ...(readKey && { readKey }) },
  }
}

async function main([name, ...rest]: string[]): Promise<void> {
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(help())
    return
  }

  if (name === 'mcp') {
    const { values } = parseArgs({ args: rest, options: { ...SETTINGS, http: { type: 'string' } }, strict: true })
    const { ctx, start } = settings(values)
    if (values.http === undefined) return serveStdio(ctx, start)
    const at = /^(?:(.+):)?(\d{1,5})$/.exec(values.http) ?? refuse('--http is [hostname:]port')
    const hostname = at[1] ?? '127.0.0.1'
    const http = await serveHttp(ctx, start, hostname, Number(at[2]))
    console.error(`forest mcp: http://${hostname}:${(http.address() as AddressInfo).port}`)
    return
  }

  const tool = TOOLS.find((t) => t.name === name) ?? refuse(`no tool ${name}; forest help lists them`)
  // The profile is a setting, and the keys come from the environment: neither is a flag of the tool's.
  const own = tool.params.filter((p) => !(FROM_START as readonly string[]).includes(p.name))
  const options: ParseArgsConfig['options'] = { ...SETTINGS, ...Object.fromEntries(own.map((p) => [p.name, { type: 'string' }])) }
  let parsed
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true })
  } catch (err) {
    return refuse((err as Error).message)
  }
  const { values, positionals } = parsed as { values: Flags & { [name: string]: string | undefined }; positionals: string[] }
  const args: { [name: string]: unknown } = {}
  for (const p of own) {
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
  const slots = own.filter((p) => p.positional)
  if (positionals.length > slots.length) refuse(`${name} takes ${slots.length ? slots.map((p) => `<${p.name}>`).join(' ') : 'nothing'} before its flags`)
  positionals.forEach((value, i) => {
    const slot = slots[i]!
    if (args[slot.name] !== undefined) refuse(`give ${slot.name} once`)
    args[slot.name] = value
  })
  const { ctx, start } = settings(values)
  const out = await tool.run(checkArgs(tool, withStart(tool, start, args)), ctx)
  console.log(JSON.stringify(out, null, 2))
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message)
  process.exitCode = 1
})
