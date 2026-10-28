// The live link: how what an AI app asks reaches the person's app, and its answer comes back, as the
// standard's signers/ says (README.md, The live link). The person's app, Forest on one of their
// devices, opens a WebSocket to /signer and registers each connection it serves by signing the
// socket's challenge with that connection's key (checkRegister). An ask goes to a live socket for
// its connection, once (askFrame), and its answer comes back: done, waiting or refused, passed on
// with only the fields the standard names for it (checkAnswer).
//
// What is this copy's own, the connector's to choose: how long it waits for an answer, which socket
// an ask goes to (the newest), the pings, and the limits below. The live sockets are the only thing
// it holds between calls, in memory: none is written, and a restart drops them all, until each of
// the person's devices opens again.

import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { b64u } from '@foundationforest/records'
import { type Answer, type Ask, askFrame, checkAnswer, checkRegister, readFrame } from '@foundationforest/signers'
import { type WebSocket, WebSocketServer } from 'ws'
import { Refusal, refuse } from './forest.ts'

/** How long a tool's call waits for the person's app: under the 60 s the MCP SDK's client waits by default, so the AI hears these words, not a bare timeout. */
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
const NO_ANSWER = `Forest on the person's device did not answer within ${ANSWER_MS / 1000} seconds. It may still be done: read before asking again.`
const CLOSED = "Forest closed on the person's device before it answered. It may or may not be done: read before asking again."
const UNREAD = 'the app answered in a way this server cannot pass on'

type Socket = {
  ws: WebSocket
  challenge: string
  connections: Set<string>
  asks: Map<string, (answer: unknown) => void>
  alive: boolean
}

export class Link {
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
    const socket: Socket = { ws, challenge: b64u.encode(randomBytes(32)), connections: new Set(), asks: new Map(), alive: true }
    this.sockets.set(ws, socket)
    const waiting = setTimeout(() => socket.connections.size || ws.close(1008, `no connection registered within ${REGISTER_MS / 1000} seconds`), REGISTER_MS)
    waiting.unref()
    ws.on('pong', () => (socket.alive = true))
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('frames are JSON text')
        this.frame(socket, data.toString())
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

  /** A frame from the person's app: a registration, or an answer. Anything else closes the socket. */
  private frame(socket: Socket, text: string): void {
    const frame = readFrame(text)
    if (frame.type === 'register') {
      const { connection, sig } = frame
      const refused = (why: string) => socket.ws.send(JSON.stringify({ type: 'refused', connection, why }))
      if (!checkRegister(connection, this.origin(), socket.challenge, sig)) return refused("the connection's key did not sign this socket's challenge")
      if (!socket.connections.has(connection)) {
        if (socket.connections.size >= MAX_CONNECTIONS) return refused(`a socket serves at most ${MAX_CONNECTIONS} connections`)
        socket.connections.add(connection)
        this.live.set(connection, [...(this.live.get(connection) ?? []), socket])
      }
      socket.ws.send(JSON.stringify({ type: 'registered', connection }))
      return
    }
    if (frame.type === 'answer') {
      const { type: _type, id, ...answer } = frame
      const settle = socket.asks.get(id)
      if (!settle) return // An answer to no ask, or a late one, is dropped.
      socket.asks.delete(id)
      return settle(answer)
    }
    throw new Error(`a ${frame.type} frame is not one the person's app sends`)
  }

  /**
   * `ask`, sent to the newest live socket for `connection`, once, never again: a payment is never
   * asked twice. What the AI app gets: the answer with only the fields the standard names for it;
   * a refusal in plain words when no app answers.
   */
  async ask(connection: string, ask: Ask): Promise<Answer> {
    const socket = this.live.get(connection)?.at(-1) ?? refuse(NO_SIGNER)
    const id = randomBytes(8).toString('hex')
    const answer = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        socket.asks.delete(id)
        resolve(new Refusal(NO_ANSWER))
      }, ANSWER_MS)
      socket.asks.set(id, (a) => {
        clearTimeout(timer)
        resolve(a)
      })
      socket.ws.send(askFrame(id, connection, ask))
    })
    if (answer instanceof Error) throw answer
    try {
      return checkAnswer(answer, ask)
    } catch {
      return refuse(UNREAD)
    }
  }

  /** Every socket closed, and the pings stopped. */
  close(): void {
    clearInterval(this.pinger)
    for (const ws of this.server.clients) ws.terminate()
    this.server.close()
  }
}
