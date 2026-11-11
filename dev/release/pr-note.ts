/**
 * Read the `## Release note` section of a pull request description (BODY) and
 * say what the app's release page will carry for it. Used by the
 * `release-note` action on every host and app pull request, with the same
 * parser the automatic release collects notes with (`parsePrNote`).
 *
 *   BODY="$(gh pr view 12 --json body --jq .body)" bun dev/release/pr-note.ts --out note.md
 *
 * Exits 1 when the section is missing or empty, or does not start with its kind
 * (`Kind: breaking | feature | fix | none`), the kind the app's version follows.
 * With --out, writes the note as the bullet(s) it becomes (an empty file for
 * `none`).
 */
import { writeFileSync } from 'node:fs'

import { KIND_HELP, parsePrNote } from './lib'

const i = process.argv.indexOf('--out')
const out = i >= 0 ? process.argv[i + 1] : undefined
const note = parsePrNote(process.env.BODY)

if (note.kind === 'missing') {
  console.log('::error::The description has no "## Release note" section, or it is empty. Start it with its kind (`Kind: breaking`, `Kind: feature`, `Kind: fix` or `Kind: none`), then one line on what a person using Kehikot notices (**Short bold lead.** One plain sentence.).')
  process.exit(1)
}
if (note.kind === 'invalid') {
  console.log(`::error::The "## Release note" section: ${note.reason}`)
  process.exit(1)
}
if (!note.declared) {
  const example = note.kind === 'none' ? 'replace `none` with `Kind: none`' : 'put `Kind: fix` (or `feature`, `breaking`) on the line above the note'
  console.log(`::error::The "## Release note" section does not say its kind, which the app's version follows (semver). ${KIND_HELP} Here: ${example}.`)
  process.exit(1)
}
const text = note.kind === 'none' ? '' : note.lines.map((line) => `- ${line}`).join('\n') + '\n'
if (out) writeFileSync(out, text)
console.log(note.kind === 'none' ? 'Release note: Kind: none (this change is not mentioned on the release page, and releases nothing by itself).' : `Release note (Kind: ${note.change}):\n${text.trimEnd()}`)
