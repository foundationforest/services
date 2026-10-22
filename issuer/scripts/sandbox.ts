// `npm run sandbox`: the issuer, run by hand against Didit's sandbox application, which mocks every
// provider and never bills. Its key is DIDIT_SANDBOX_API_KEY, the sandbox application's own (a Didit
// key belongs to one application); this script never reads DIDIT_API_KEY, the live one, and refuses
// to start when the two are the same.
//
//   DIDIT_SANDBOX_API_KEY=… npm run sandbox               each session it opens comes to `approve`
//   DIDIT_SANDBOX_API_KEY=… npm run sandbox -- review_…   or to another of Didit's sandbox scenarios
//
// It runs both checks on the sandbox application's two workflows, with the SFace model (`npm run
// fetch -- models` first) and its own seed and file in data/sandbox/. The ID check is offered at a
// price of 1, with a stand-in payment check that counts every payment as landed: nothing in the
// sandbox is paid, and no RPC is asked. PORT, ISSUER_NAME, APP_ORIGINS, HOST_URL and HOST_CREDITS are
// read as `npm start` reads them. Then, by hand: `POST /face/session`, open the page it answers and
// walk through Didit's mocked flow, and `POST /face/note` with the session and a note number.

import { DiditClient } from '../src/didit.ts'
import { readConfig, startIssuer } from '../src/service.ts'

/** The sandbox application's two workflows: the face check's and the ID check's. */
export const SANDBOX = { face: '8b1307a1-6076-41a9-93ba-e050dff5273b', id: '447164ec-8cb0-45fe-8c25-53b45bb2b37e' }

const apiKey = process.env.DIDIT_SANDBOX_API_KEY
if (!apiKey) throw new Error('DIDIT_SANDBOX_API_KEY is not set: the sandbox application’s own Didit key')
if (apiKey === process.env.DIDIT_API_KEY) throw new Error('DIDIT_SANDBOX_API_KEY is the same as DIDIT_API_KEY: the sandbox takes the sandbox application’s key, never the live one')
const scenario = process.argv[2] || 'approve'

// An address no one can pay from: the stand-in payment check never looks.
const NOBODY = '11111111111111111111111111111111'
const { PORT, ISSUER_NAME, APP_ORIGINS, HOST_URL, HOST_CREDITS } = process.env
const config = readConfig({
  PORT,
  ISSUER_NAME,
  APP_ORIGINS,
  HOST_URL,
  HOST_CREDITS,
  DIDIT_API_KEY: apiKey,
  DIDIT_FACE_WORKFLOW_ID: SANDBOX.face,
  DIDIT_ID_WORKFLOW_ID: SANDBOX.id,
  DATABASE_PATH: 'data/sandbox/issuer.sqlite',
  ID_PRICE: '1',
  ID_PAY_TO: NOBODY,
  ID_MINT: NOBODY,
  RPC_URL: 'http://127.0.0.1:1',
})
const didit = (check: 'face' | 'id', workflowId: string) => new DiditClient({ apiKey, workflowId, check, baseUrl: config.diditBaseUrl, scenario })
const issuer = await startIssuer(config, {
  faceCheck: didit('face', SANDBOX.face),
  idCheck: didit('id', SANDBOX.id),
  // Each payment counts as landed, under its own reference, so each opens one session.
  payments: { landed: async (reference) => [reference] },
})
console.log(`issuer (Didit sandbox, scenario ${scenario}): ${issuer.url}`)
console.log(`face key ${issuer.keys.face}, ID key ${issuer.keys.id}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void issuer.close().then(() => process.exit(0))
  })
}
