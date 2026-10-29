// `npm run sandbox`: the verifier, run by hand against Didit's sandbox application, which mocks every
// provider and never bills. Its key is DIDIT_SANDBOX_API_KEY, the sandbox application's own (a Didit
// key belongs to one application); this script never reads DIDIT_API_KEY, the live one, and refuses
// to start when the two are the same.
//
//   DIDIT_SANDBOX_API_KEY=… npm run sandbox               each session it opens comes to `approve`
//   DIDIT_SANDBOX_API_KEY=… npm run sandbox -- review_…   or to another of Didit's sandbox scenarios
//
// It runs both checks on the sandbox application's two workflows, with the SFace model (`npm run
// fetch -- models` first) and its own seed and file in data/sandbox/. PORT, VERIFIER_NAME, APP_ORIGINS,
// HOST_URL, FACE_CREDITS and ID_CREDITS are read as `npm start` reads them. Then, by hand: `POST /face/session`, open the page it answers and
// walk through Didit's mocked flow, and `POST /face/stamp` with the session and a stamp number.

import { DiditClient } from '../src/didit.ts'
import { readConfig, startVerifier } from '../src/service.ts'

/** The sandbox application's two workflows: the face check's and the ID check's. */
export const SANDBOX = { face: '8b1307a1-6076-41a9-93ba-e050dff5273b', id: '447164ec-8cb0-45fe-8c25-53b45bb2b37e' }

const apiKey = process.env.DIDIT_SANDBOX_API_KEY
if (!apiKey) throw new Error('DIDIT_SANDBOX_API_KEY is not set: the sandbox application’s own Didit key')
if (apiKey === process.env.DIDIT_API_KEY) throw new Error('DIDIT_SANDBOX_API_KEY is the same as DIDIT_API_KEY: the sandbox takes the sandbox application’s key, never the live one')
const scenario = process.argv[2] || 'approve'

const { PORT, VERIFIER_NAME, APP_ORIGINS, HOST_URL, FACE_CREDITS, ID_CREDITS } = process.env
const config = readConfig({
  PORT,
  VERIFIER_NAME,
  APP_ORIGINS,
  HOST_URL,
  FACE_CREDITS,
  ID_CREDITS,
  DIDIT_API_KEY: apiKey,
  DIDIT_FACE_WORKFLOW_ID: SANDBOX.face,
  DIDIT_ID_WORKFLOW_ID: SANDBOX.id,
  DATABASE_PATH: 'data/sandbox/verifier.sqlite',
})
const didit = (check: 'face' | 'id', workflowId: string) => new DiditClient({ apiKey, workflowId, check, baseUrl: config.diditBaseUrl, scenario })
const verifier = await startVerifier(config, {
  faceCheck: didit('face', SANDBOX.face),
  idCheck: didit('id', SANDBOX.id),
})
console.log(`verifier (Didit sandbox, scenario ${scenario}): ${verifier.url}`)
console.log(`face key ${verifier.keys.face}, ID key ${verifier.keys.id}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void verifier.close().then(() => process.exit(0))
  })
}
