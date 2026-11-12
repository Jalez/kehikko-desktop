// Notarize a file with bounded waits (logic and limits: notarize.ts).
//
//   bun dev/release/notarize-run.ts --staple <file>
//     release.yml's disk image: credentials from APPLE_ID, APPLE_PASSWORD and
//     APPLE_TEAM_ID; staples the file when Apple accepts it.
//   bun dev/release/notarize-run.ts --tauri <file> <notarytool arguments…>
//     what dev/release/bin/xcrun runs in place of Tauri's
//     `notarytool submit <zip> --output-format json --wait <credentials>`: prints
//     the JSON Tauri reads ({id, status, message}) and lets Tauri staple.
//
// Progress goes to stderr and, when NOTARIZE_LOG is set, to that file (Tauri
// keeps the stderr of a call that succeeds to itself). The one-line outcome is
// appended to NOTARIZE_RECORD when it is set; release.yml uploads that file so a
// failed release's issue can name the submissions.
import { appendFileSync } from 'node:fs'

import { DEFAULTS, envAuth, notarize, realClock, realRun, staple, tauriArgs } from './notarize'

const argv = process.argv.slice(2)
const tauri = argv[0] === '--tauri'
const doStaple = argv[0] === '--staple'
const rest = tauri || doStaple ? argv.slice(1) : argv

function append(path: string | undefined, line: string) {
  if (!path) return
  try { appendFileSync(path, `${line}\n`) } catch { /* a record is a help, never a failure */ }
}

const log = (line: string) => {
  const stamped = `[notarize ${new Date().toISOString().slice(11, 19)}] ${line}`
  console.error(stamped)
  append(process.env.NOTARIZE_LOG, stamped)
}

let file: string
let auth: string[]
if (tauri) {
  const parsed = tauriArgs(rest)
  if (!parsed) { console.error('usage: notarize-run.ts --tauri <file> <notarytool arguments…>'); process.exit(2) }
  ;({ file, auth } = parsed)
} else {
  const env = envAuth(process.env)
  if (!rest[0] || !env) { console.error('usage: APPLE_ID=… APPLE_PASSWORD=… APPLE_TEAM_ID=… notarize-run.ts [--staple] <file>'); process.exit(2) }
  file = rest[0]
  auth = env
}

const outcome = await notarize({ ...DEFAULTS, file, auth, log }, realRun, realClock)
append(process.env.NOTARIZE_RECORD, outcome.summary)

if (!outcome.ok) {
  if (outcome.log) console.error(`notarytool log:\n${outcome.log}`)
  console.error(outcome.summary)
  process.exit(1)
}

if (tauri) {
  console.log(JSON.stringify({ id: outcome.id, status: 'Accepted', message: outcome.message }))
} else if (doStaple) {
  if (!await staple({ file, commandMs: DEFAULTS.commandMs, log }, realRun, realClock)) {
    const line = `${outcome.summary}; stapling failed`
    append(process.env.NOTARIZE_RECORD, line)
    console.error(line)
    process.exit(1)
  }
  log(`Stapled ${file}`)
}
