// Test helpers: the plug on a loopback port, and a clock tests can move.

import { Host, type HostOptions } from '../src/plug.ts'

export async function startPlug(options: HostOptions = {}): Promise<Host> {
  const host = new Host(options)
  await host.listen()
  return host
}

export class Clock {
  t: number
  constructor(t: number) {
    this.t = t
  }
  now = () => this.t
  advance(ms: number) {
    this.t += ms
    return this.t
  }
}

/** A loopback port free now: for a host whose public origin, which its credits carry, must name its own port. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}
