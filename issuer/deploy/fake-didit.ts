// A stand-in for Didit, for the devnet issuer only: the issuer runs on devnet without a real face
// check. It answers the two calls the issuer's Didit client makes (issuer/src/didit.ts), in Didit's
// API v3 shape:
//
//   POST /v3/session/                   opens a session: {session_id, url}
//   GET  /v3/session/{id}/decision/     every session it opened passed: approved, one liveness step
//                                       approved, no warning. A session it never opened is a 404.
//
// So every face check "passes", and anyone who asks the devnet issuer for a session can put a
// commitment on devnet's list 0 (the issuer's own limit, five sessions an hour per address, still
// holds). deploy/issuer/start.sh starts it only when DIDIT_API_KEY is unset, on 127.0.0.1 inside the
// issuer's container, where nothing else reaches it. It keeps the ids it opened in memory, and
// nothing else, and logs nothing per request.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_DIDIT_PORT || 8090)
const workflow = process.env.FAKE_DIDIT_WORKFLOW_ID
if (!workflow) throw new Error('FAKE_DIDIT_WORKFLOW_ID is not set')

const opened = new Set<string>()
const decision = /^\/v3\/session\/([0-9a-f-]{36})\/decision\/$/

const server = createServer((req, res) => {
  req.resume()
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'POST' && req.url === '/v3/session/') {
    const id = randomUUID()
    opened.add(id)
    return send(201, { session_id: id, url: `https://fake-didit.invalid/session/${id}`, status: 'Not Started', workflow_id: workflow })
  }
  const match = req.method === 'GET' ? decision.exec(req.url ?? '') : null
  if (match && opened.has(match[1])) {
    return send(200, {
      session_id: match[1],
      status: 'Approved',
      workflow_id: workflow,
      liveness_checks: [{ status: 'Approved', method: 'PASSIVE', warnings: [] }],
      face_matches: null,
    })
  }
  send(404, { detail: 'Not found.' })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-didit: stand-in for Didit on 127.0.0.1:${port}; every session it opens is approved`))
