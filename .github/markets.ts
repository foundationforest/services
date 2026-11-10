// Writes the description of the pull request that moves MARKETS (.github/workflows/markets.yml): the
// markets' commits it brings in and, when a check failed, each failed job's failing step.
//
//   node .github/markets.ts <from> <to> <run's address> <commits file> [<failed directory>]
//
// The commits file is the markets' `git log --first-parent --reverse -z --format=%H%n%B <from>..<to>`.
// The failed directory, given only when a check failed, holds one <job>.log per failed job, its log
// as GitHub serves it.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKETS = 'https://github.com/foundationforest/markets'
const LINES = 40 // of a failing step, its last
const WIDTH = 200 // characters, at most, of a line
const MAX = 65_000 // characters: GitHub takes a description of at most 65,536

/** One list line per commit on the markets' main: its link, then its title. A merge commit's title is
 *  its pull request's, the first line of its body, when it has one. */
export function commits(log: string): string[] {
  return log
    .split('\0')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, subject = '', ...body] = c.split('\n')
      const merge = /^Merge pull request #(\d+) from /.exec(subject)
      const named = body.find((l) => l.trim())?.trim()
      const title = merge && named ? `${named} (#${merge[1]})` : subject
      return `- [\`${sha.slice(0, 7)}\`](${MARKETS}/commit/${sha}) ${plain(cut(title))}`
    })
}

// A markets' "#29" links to the markets' pull request, not to this repo's #29, and an "@name" pings
// nobody.
function plain(title: string): string {
  return title
    .replace(/(?<![\w/])#(\d+)/g, 'foundationforest/markets#$1')
    .replace(/(?<![\w`])@([\w-]+)/g, '`@$1`')
}

function cut(line: string): string {
  return line.length > WIDTH ? `${line.slice(0, WIDTH)}…` : line
}

/** A failed job's failing step, from its Run line to its first error, without the log's times and
 *  colours: its last LINES lines, each at most WIDTH characters. A log with no error gives its end. */
export function excerpt(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
  const error = lines.findIndex((l) => l.startsWith('##[error]'))
  const end = error < 0 ? lines.length : error + 1
  const start = Math.max(0, lines.slice(0, end).findLastIndex((l) => l.startsWith('##[group]Run ')))
  const step = lines
    .slice(start, end)
    .filter((l) => l !== '##[endgroup]')
    .map((l) => cut(l.replace(/^##\[group\]/, '').replace(/^##\[error\]/, 'Error: ')))
  while (step.length && !step[step.length - 1].trim()) step.pop()
  return step.slice(-LINES).join('\n')
}

// A code fence longer than any run of backticks in the text it holds.
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

export interface Move {
  from: string
  to: string
  run: string
  commits: string[]
  /** Each failed job's name and log; undefined when every check passed. */
  failed?: { job: string; log: string }[]
}

/** The pull request's description. */
export function description(move: Move): string {
  const at = (sha: string) => `[\`${sha.slice(0, 7)}\`](${MARKETS}/commit/${sha})`
  const parts = [
    `Moves \`MARKETS\` from ${at(move.from)} to ${at(move.to)}, the markets' main, which brings in:`,
    move.commits.join('\n'),
  ]
  if (!move.failed) {
    parts.push(`Every check passed against it in [this run](${move.run}).`)
  } else {
    parts.push(
      `A check failed against it in [this run](${move.run}), so this stays open, and each day's run tries ` +
        `again with the markets' main.`,
    )
    for (const { job, log } of move.failed) parts.push(`### ${job}`, fenced(excerpt(log)))
  }
  const text = parts.join('\n\n') + '\n'
  const more = `\n\n(Cut here, at GitHub's limit: the rest is in [the run](${move.run}).)\n`
  return text.length > MAX ? text.slice(0, MAX - more.length) + more : text
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [from, to, run, commitsFile, failedDir] = process.argv.slice(2)
  if (!commitsFile) throw new Error('usage: markets.ts <from> <to> <run> <commits file> [<failed directory>]')
  const failed =
    failedDir === undefined
      ? undefined
      : readdirSync(failedDir)
          .filter((f) => f.endsWith('.log'))
          .sort()
          .map((f) => ({ job: f.slice(0, -'.log'.length), log: readFileSync(join(failedDir, f), 'utf8') }))
  const lines = commits(readFileSync(commitsFile, 'utf8'))
  process.stdout.write(description({ from, to, run, commits: lines, failed }))
}
