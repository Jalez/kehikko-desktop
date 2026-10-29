/**
 * Decide whether a push to `main` of a module (or the protocol) is a release:
 * package.json's version is newer than every `vX.Y.Z` tag and its notes are
 * written. Run in the repository's checkout by the `tag-on-merge` action:
 *
 *   bun plan-tag.ts --notes 'notes/{version}.md'      # a module
 *   bun plan-tag.ts --changelog CHANGELOG.md          # the protocol
 *
 * Tags are read from GitHub (`gh api`, GH_TOKEN, GITHUB_REPOSITORY), or from
 * `git tag` when --local is given. Prints the decision and, under GitHub
 * Actions, sets `action` (tag | none), `tag`, `version` and `reason`. Exits 1
 * when the push looks like a release that cannot be one (a version older than
 * the latest tag, or newer without notes), so the run shows red.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { changelogHas, decideTag } from './lib'

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
const notesName = changelog ? `a "## ${packageVersion}" entry in ${changelog}` : notesPattern.replace('{version}', packageVersion)
const notesFound = changelog
  ? existsSync(join(dir, changelog)) && changelogHas(readFileSync(join(dir, changelog), 'utf8'), packageVersion)
  : existsSync(join(dir, notesPattern.replace('{version}', packageVersion)))

const tags = process.argv.includes('--local')
  ? (await run(['git', '-C', dir, 'tag', '--list', 'v*'])).split('\n')
  : (await run(['gh', 'api', '--paginate', `repos/${process.env.GITHUB_REPOSITORY}/git/matching-refs/tags/v`, '--jq', '.[].ref'])).split('\n')

const decision = decideTag({ packageVersion, tags: tags.map((t) => t.trim()).filter(Boolean), notesFound, notesName })
console.log(`${decision.action}: ${decision.reason}`)
if (process.env.GITHUB_OUTPUT) {
  const values = decision.action === 'tag' ? { action: 'tag', tag: decision.tag, version: decision.version, reason: decision.reason } : { action: 'none', tag: '', version: '', reason: decision.reason }
  for (const [key, value] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
if (decision.action === 'refuse') {
  console.log(`::error::${decision.reason}`)
  process.exit(1)
}
