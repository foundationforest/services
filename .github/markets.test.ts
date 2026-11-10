// The description .github/markets.ts writes for the pull request that moves MARKETS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commits, description, excerpt } from './markets.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const RUN = 'https://github.com/foundationforest/services/actions/runs/1'

test("a merge commit takes its pull request's title, a squash commit keeps its own", () => {
  const log =
    `${A}\nMerge pull request #29 from foundationforest/claude/x\n\nRename the post kind to listing\n\0` +
    `${B}\nSay what vouches are (#30)\n\0` +
    `${A}\nMerge pull request #31 from foundationforest/claude/y\n\0`
  assert.deepEqual(commits(log), [
    `- [\`aaaaaaa\`](https://github.com/foundationforest/markets/commit/${A}) Rename the post kind to listing (foundationforest/markets#29)`,
    `- [\`bbbbbbb\`](https://github.com/foundationforest/markets/commit/${B}) Say what vouches are (foundationforest/markets#30)`,
    `- [\`aaaaaaa\`](https://github.com/foundationforest/markets/commit/${A}) Merge pull request foundationforest/markets#31 from foundationforest/claude/y`,
  ])
})

test('an @name in a title pings nobody, and an address or another repo is left as it is', () => {
  const [line] = commits(`${A}\nThanks @carlos, see a@b.org and foundationforest/standard#5\n`)
  assert.match(line, / Thanks `@carlos`, see a@b\.org and foundationforest\/standard#5$/)
})

const LOG = [
  '2026-11-10T09:41:00.0000000Z ##[group]Run actions/checkout@v7',
  '2026-11-10T09:41:01.0000000Z ##[endgroup]',
  '2026-11-10T09:41:02.0000000Z ##[group]Run npm test | tee "$RUNNER_TEMP/tap"',
  '2026-11-10T09:41:02.0000000Z npm test | tee "$RUNNER_TEMP/tap"',
  '2026-11-10T09:41:02.0000000Z ##[endgroup]',
  '2026-11-10T09:41:03.0000000Z \x1b[31mnot ok 1 - a listing\x1b[39m',
  '2026-11-10T09:41:04.0000000Z ##[error]Process completed with exit code 1.',
  '2026-11-10T09:41:05.0000000Z Post job cleanup.',
].join('\n')

test("a failed job's excerpt is its failing step to its error, without times or colours", () => {
  assert.equal(
    excerpt(LOG),
    [
      'Run npm test | tee "$RUNNER_TEMP/tap"',
      'npm test | tee "$RUNNER_TEMP/tap"',
      'not ok 1 - a listing',
      'Error: Process completed with exit code 1.',
    ].join('\n'),
  )
})

test('an excerpt keeps the last 40 lines, each at most 200 characters, and a log with no error its end', () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(300)}`)
  const lines = excerpt(['##[group]Run npm test', ...long, '##[error]failed'].join('\n')).split('\n')
  assert.equal(lines.length, 40)
  assert.ok(lines.every((l) => l.length <= 201))
  assert.equal(lines.at(-1), 'Error: failed')
  assert.equal(excerpt('one\ntwo\n'), 'one\ntwo')
})

test('the description says the checks passed, or holds each failed job in a fence longer than its backticks', () => {
  const lines = commits(`${B}\nSay what vouches are (#30)\n`)
  const passed = description({ from: A, to: B, run: RUN, commits: lines })
  assert.match(passed, /^Moves `MARKETS` from \[`aaaaaaa`\]\(.+\) to \[`bbbbbbb`\]\(.+\), the markets' main/)
  assert.ok(passed.includes(lines[0]))
  assert.ok(passed.includes(`Every check passed against it in [this run](${RUN}).`))

  const log = '##[group]Run npm test\nexpected ```` here\n##[error]failed'
  const failed = description({ from: A, to: B, run: RUN, commits: lines, failed: [{ job: 'verifier', log }] })
  assert.ok(failed.includes(`A check failed against it in [this run](${RUN}), so this stays open`))
  assert.ok(failed.includes('### verifier\n\n`````\nRun npm test\nexpected ```` here\nError: failed\n`````'))
  assert.ok(!failed.includes('Every check passed'))
})

test("the description stays within GitHub's limit when every job fails at length", () => {
  const huge = ['##[group]Run npm test', ...Array.from({ length: 500 }, () => 'y'.repeat(1000)), '##[error]x'].join('\n')
  const many = commits(Array.from({ length: 250 }, () => `${A}\n${'z'.repeat(1000)}\n`).join('\0'))
  const failed = Array.from({ length: 9 }, (_, i) => ({ job: `job ${i}`, log: huge }))
  const text = description({ from: A, to: B, run: RUN, commits: many, failed })
  assert.ok(text.length <= 65_536)
  assert.ok(text.endsWith(`the rest is in [the run](${RUN}).)\n`))
})
