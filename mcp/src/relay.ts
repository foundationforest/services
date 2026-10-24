// The relay: how what an AI app asks reaches the person's signer, and the answer comes back. A
// signer, Forest on one of the person's devices, opens a WebSocket to /signer and registers each
// connection it serves by signing the socket's challenge with that connection's key. A relayed
// tool's call goes to a live socket for its connection, and its answer comes back: done, with a
// result; needs approval, with a link to open on the person's device; or refused, with why. The
// protocol is in the README, How it works.
//
// The live sockets are the only thing this copy holds between calls, in memory: none is written,
// and a restart drops them all, until each signer opens again.

import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'
import { REGISTER, isConnection, signedBy } from './connection.ts'
import { Refusal, isObject, refuse } from './forest.ts'
import type { Args } from './params.ts'

/** How long a tool's call waits for the signer: under the 60 s the MCP SDK's client waits by default, so the AI hears these words, not a bare timeout. */
export const ANSWER_MS = 45_000
/** How often each socket is pinged; one with no pong by the next ping is closed. Under the 60 s many proxies let a quiet connection live. */
export const PING_MS = 30_000
/** How long a socket has to register its first connection. */
export const REGISTER_MS = 30_000
/** The most connections one socket serves. */
export const MAX_CONNECTIONS = 100
/** The largest frame either way: the index read's cap. */
export const MAX_FRAME = 4 * 1024 * 1024

export const NO_SIGNER = "Forest is not open on any of the person's devices, or it no longer serves this connection: ask them to open Forest on one of their devices, then try again."
const NO_ANSWER = `Forest on the person's device did not answer within ${ANSWER_MS / 1000} seconds. It may still be done: look (profile, inbox) before asking again.`
const CLOSED = "Forest closed on the person's device before it answered. It may or may not be done: look (profile, inbox) before asking again."

type Answer = { status: 'done'; result: { [key: string]: unknown } } | { status: 'approval'; link: string; why?: string } | { status: 'refused'; why: string }

type Socket = {
  ws: WebSocket
  challenge: string
  connections: Set<string>
  asks: Map<string, (answer: Answer | Error) => void>
  alive: boolean
}

// ---------------------------------------------------------------------------------------------
// What a signer's result may hold, by tool: only these fields are passed on, so a signer cannot
// hand an AI app one of the person's addresses by mistake.

const text = (v: unknown, name: string): string => (typeof v === 'string' ? v : refuse(`the signer's answer has no ${name}`))
const whole = (v: unknown, name: string): number => (Number.isSafeInteger(v) ? (v as number) : refuse(`the signer's answer has no ${name}`))
const list = (v: unknown, name: string): unknown[] => (Array.isArray(v) ? v : refuse(`the signer's answer has no ${name}`))
const written = (r: { [key: string]: unknown }) => ({ kind: text(r.kind, 'kind'), id: text(r.id, 'id') })

const RESULTS: { [tool: string]: (r: { [key: string]: unknown }) => { [key: string]: unknown } } = {
  profiles: (r) => ({ profiles: list(r.profiles, 'profiles').map((p) => (isObject(p) ? { market: text(p.market, 'market'), role: text(p.role, 'role') } : refuse("the signer's answer has a profile that is not an object"))) }),
  post: written,
  remove: written,
  message: () => ({}),
  reply: () => ({}),
  inbox: (r) => ({
    messages: list(r.messages, 'messages').map((m) => {
      if (!isObject(m)) return refuse("the signer's answer has a message that is not an object")
      return {
        number: whole(m.number, 'number'),
        from: text(m.from, 'from'),
        time: whole(m.time, 'time'),
        ...(typeof m.text === 'string' && { text: m.text }),
        ...(isObject(m.body) && { body: m.body }),
      }
    }),
  }),
  pay: (r) => ({ evidence: text(r.evidence, 'evidence') }),
}

export class Relay {
  /** Live sockets by connection, the newest last. */
  private readonly live = new Map<string, Socket[]>()
  private readonly sockets = new Map<WebSocket, Socket>()
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  private readonly pinger: NodeJS.Timeout
  /** This copy's origin, which a registration's signature names. */
  private readonly origin: () => string

  constructor(origin: () => string) {
    this.origin = origin
    this.pinger = setInterval(() => {
      for (const ws of this.server.clients) {
        const socket = this.sockets.get(ws)
        if (!socket) continue
        if (!socket.alive) {
          ws.terminate()
          continue
        }
        socket.alive = false
        ws.ping()
      }
    }, PING_MS)
    this.pinger.unref()
  }

  /** How many connections have a live socket: what this copy holds between calls. */
  get size(): number {
    return this.live.size
  }

  /** An HTTP upgrade to /signer. */
  upgrade(req: IncomingMessage, stream: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, stream, head, (ws) => this.open(ws))
  }

  private open(ws: WebSocket): void {
    const socket: Socket = { ws, challenge: randomBytes(32).toString('base64url'), connections: new Set(), asks: new Map(), alive: true }
    this.sockets.set(ws, socket)
    const waiting = setTimeout(() => socket.connections.size || ws.close(1008, `no connection registered within ${REGISTER_MS / 1000} seconds`), REGISTER_MS)
    waiting.unref()
    ws.on('pong', () => (socket.alive = true))
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('frames are JSON text')
        this.frame(socket, JSON.parse(data.toString()) as unknown)
      } catch (err) {
        ws.close(1008, (err as Error).message.slice(0, 120))
      }
    })
    ws.on('close', () => {
      clearTimeout(waiting)
      this.sockets.delete(ws)
      for (const connection of socket.connections) {
        const left = (this.live.get(connection) ?? []).filter((s) => s !== socket)
        if (left.length) this.live.set(connection, left)
        else this.live.delete(connection)
      }
      for (const settle of socket.asks.values()) settle(new Refusal(CLOSED))
      socket.asks.clear()
    })
    ws.send(JSON.stringify({ type: 'challenge', challenge: socket.challenge }))
  }

  /** A frame from a signer: a registration, or an answer. Anything else closes the socket. */
  private frame(socket: Socket, frame: unknown): void {
    if (!isObject(frame)) throw new Error('a frame is a JSON object')
    if (frame.type === 'register') {
      const { connection, sig } = frame
      const refused = (why: string) => socket.ws.send(JSON.stringify({ type: 'refused', connection, why }))
      if (!isConnection(connection)) return refused('a connection is an Ed25519 public key, its 32 bytes in base64url')
      if (!signedBy(connection, `${REGISTER}${this.origin()}\n${socket.challenge}`, sig)) return refused("the connection's key did not sign this socket's challenge")
      if (!socket.connections.has(connection)) {
        if (socket.connections.size >= MAX_CONNECTIONS) return refused(`a socket serves at most ${MAX_CONNECTIONS} connections`)
        socket.connections.add(connection)
        this.live.set(connection, [...(this.live.get(connection) ?? []), socket])
      }
      socket.ws.send(JSON.stringify({ type: 'registered', connection }))
      return
    }
    if (frame.type === 'answer') {
      const settle = typeof frame.id === 'string' ? socket.asks.get(frame.id) : undefined
      if (!settle) return // An answer to no ask, or a late one, is dropped.
      socket.asks.delete(frame.id as string)
      if (frame.status === 'done' && isObject(frame.result)) return settle({ status: 'done', result: frame.result })
      if (frame.status === 'approval' && typeof frame.link === 'string' && URL.canParse(frame.link) && new URL(frame.link).protocol === 'https:') {
        return settle({ status: 'approval', link: frame.link, ...(typeof frame.why === 'string' && { why: frame.why }) })
      }
      if (frame.status === 'refused' && typeof frame.why === 'string') return settle({ status: 'refused', why: frame.why })
      return settle(new Refusal('the signer answered in a way this server cannot pass on'))
    }
    throw new Error(`no frame of type ${String(frame.type)}`)
  }

  /**
   * `tool` with `args`, asked of the newest live socket for `connection`, once, never again: a pay
   * is never sent twice. What the AI app gets: the result's known fields when done; the link when
   * it needs the person's yes; a refusal in plain words otherwise.
   */
  async ask(connection: string, tool: string, args: Args): Promise<unknown> {
    const socket = this.live.get(connection)?.at(-1) ?? refuse(NO_SIGNER)
    const id = randomBytes(8).toString('hex')
    const answer = await new Promise<Answer | Error>((resolve) => {
      const timer = setTimeout(() => {
        socket.asks.delete(id)
        resolve(new Refusal(NO_ANSWER))
      }, ANSWER_MS)
      socket.asks.set(id, (a) => {
        clearTimeout(timer)
        resolve(a)
      })
      socket.ws.send(JSON.stringify({ type: 'ask', id, connection, tool, args }))
    })
    if (answer instanceof Error) throw answer
    if (answer.status === 'refused') refuse(`The person's signer refused: ${answer.why}`)
    if (answer.status === 'approval') return { status: 'needs approval', link: answer.link, ...(answer.why && { why: answer.why }) }
    const shape = RESULTS[tool] ?? refuse(`no tool ${tool}`)
    return { status: 'done', ...shape(answer.result) }
  }

  /** Every socket closed, and the pings stopped. */
  close(): void {
    clearInterval(this.pinger)
    for (const ws of this.server.clients) ws.terminate()
    this.server.close()
  }
}
