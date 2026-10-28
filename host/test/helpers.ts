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
