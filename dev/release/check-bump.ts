/**
 * Check, on a module's (or the protocol's) pull request, that a version bump
 * matches the kind of change its notes declare. Kehikot follows semver; the
 * rule is `bump` in lib.ts (while 0.x: breaking → minor, otherwise patch; from
 * 1.0: breaking → major, feature → minor, fix → patch). Run in the
 * repository's checkout by the `version-kind` action (module-ci.yml, the
 * protocol's ci.yml):
 *
 *   bun check-bump.ts --notes 'notes/{version}.md'      # a module
 *   bun check-bump.ts --changelog CHANGELOG.md          # the protocol
 *
 * package.json at the latest `vX.Y.Z` tag: not a release, passes. Newer: the
 * notes (or the CHANGELOG's `## X.Y.Z` entry) must exist and start with
 * `Kind: breaking | feature | fix`, and the version must be exactly the one
 * that kind asks for after the latest tag. Tags are read from GitHub (`gh api`,
 * GH_TOKEN, GITHUB_REPOSITORY), or from `git tag` with --local. Exits 1, with a
 * GitHub error annotation saying how to fix it, when it does not match.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { changelogEntry, checkBump } from './lib'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function run(cmd: string[]): Promise<string> {
  const child = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed: ${err.trim()}`)
  return out
}

const dir = arg('dir') ?? process.cwd()
const packageVersion = String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '')
const changelog = arg('changelog')
const notesPattern = arg('notes') ?? 'notes/{version}.md'

let notes: string | null = null
let notesName: string
if (changelog) {
  notesName = `${changelog}'s "## ${packageVersion}" entry`
  const path = join(dir, changelog)
  notes = existsSync(path) ? changelogEntry(readFileSync(path, 'utf8'), packageVersion) : null
} else {
  const file = notesPattern.replace('{version}', packageVersion)
  notesName = file
  notes = existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null
}

const tags = process.argv.includes('--local')
  ? (await run(['git', '-C', dir, 'tag', '--list', 'v*'])).split('\n')
  : (await run(['gh', 'api', '--paginate', `repos/${process.env.GITHUB_REPOSITORY}/git/matching-refs/tags/v`, '--jq', '.[].ref'])).split('\n')

const result = checkBump({ packageVersion, tags: tags.map((t) => t.trim()).filter(Boolean), notes, notesName })
if (result.ok) {
  console.log(result.reason)
} else {
  const file = changelog ?? notesPattern.replace('{version}', packageVersion)
  console.log(`::error file=${file}::${result.reason}`)
  process.exit(1)
}
