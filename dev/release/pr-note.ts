/**
 * Read the `## Release note` section of a pull request description (BODY) and
 * say what the app's release page will carry for it. Used by the
 * `release-note` action on every host and app pull request, with the same
 * parser the automatic release collects notes with (`parsePrNote`).
 *
 *   BODY="$(gh pr view 12 --json body --jq .body)" bun dev/release/pr-note.ts --out note.md
 *
 * Exits 1 when the section is missing or empty. With --out, writes the note as
 * the bullet(s) it becomes (an empty file for `none`).
 */
import { writeFileSync } from 'node:fs'

import { parsePrNote, renderNotes } from './lib'

const i = process.argv.indexOf('--out')
const out = i >= 0 ? process.argv[i + 1] : undefined
const note = parsePrNote(process.env.BODY)

if (note.kind === 'missing') {
  console.log('::error::The description has no "## Release note" section, or it is empty. Add one line on what a person using Kehikot notices (**Short bold lead.** One plain sentence.), or `none`.')
  process.exit(1)
}
const text = note.kind === 'none' ? '' : renderNotes({ notes: [{ pr: null as never, lines: note.lines }], none: [], missing: [] })
if (out) writeFileSync(out, text)
console.log(note.kind === 'none' ? 'Release note: none (this change is not mentioned on the release page).' : `Release note:\n${text.trimEnd()}`)
