/**
 * Plan the next automatic app release: what has been merged since the latest
 * release, and what its notes say. Reads GitHub through `gh api` (GH_TOKEN),
 * writes nothing there. `.github/workflows/auto-release.yml` runs it; anyone can
 * run it locally to see what the next release would be:
 *
 *   GH_TOKEN=$(gh auth token) bun dev/release/plan-app.ts
 *
 * `--from vX.Y.Z` plans from an older release instead of the latest (dry runs
 * only: the version it names is then not the real next one).
 *
 * Writes `notes/<version>.md` into --notes-dir (default: a temp dir) when there
 * is something to release, prints a summary, and, under GitHub Actions, sets
 * the step outputs `release`, `reason`, `version`, `tag`, `host_sha` and
 * `notes_file`. Exits 1 when a person has to look (a release stuck as a draft,
 * a host `main` that moved backwards); exits 0 with `release=false` when there is
 * simply nothing to release yet.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { baseline, collectNotes, type MergedPr, prsInRange, type ReleaseInfo, renderNotes } from './lib'

const ROOT = join(import.meta.dir, '..', '..')
const DESKTOP = process.env.DESKTOP_REPO || process.env.GITHUB_REPOSITORY || 'Jalez/kehikko-desktop'
const HOST = process.env.HOST_REPO || 'Jalez/kehikko'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function gh(args: string[]): Promise<string> {
  const child = Bun.spawn(['gh', 'api', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`gh api ${args.filter((a) => !a.startsWith('query=')).join(' ')} failed: ${err.trim()}`)
  return out
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

async function sh(cmd: string[]): Promise<string> {
  const child = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return code === 0 ? out.trim() : ''
}

async function compare(repo: string, base: string, head: string): Promise<{ status: string; commits: Set<string>; since: string }> {
  const first = JSON.parse(await gh([`repos/${repo}/compare/${base}...${head}?per_page=1`, '--jq', '{status, total: .total_commits, date: .merge_base_commit.commit.committer.date}'])) as { status: string; total: number; date: string }
  if (first.status === 'identical' || first.total === 0) return { status: first.status, commits: new Set(), since: first.date }
  const commits = new Set(lines(await gh(['--paginate', `repos/${repo}/compare/${base}...${head}?per_page=100`, '--jq', '.commits[].sha'])))
  return { status: first.status, commits, since: first.date }
}

const SEARCH = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title url body mergedAt mergeCommit { oid } } }
  }
}`

/** Merged pull requests into main since a day before `since` (the range check below is exact; the date only narrows the search). */
async function mergedPrs(repo: string, since: string): Promise<MergedPr[]> {
  const day = new Date(new Date(since).getTime() - 86_400_000).toISOString().slice(0, 10)
  const q = `repo:${repo} is:pr is:merged base:main merged:>=${day}`
  const out = await gh(['graphql', '--paginate', '-f', `query=${SEARCH}`, '-f', `q=${q}`, '--jq', '.data.search.nodes[] | @json'])
  return lines(out).map((line) => {
    const pr = JSON.parse(line) as { number: number; title: string; url: string; body: string | null; mergedAt: string; mergeCommit: { oid: string } | null }
    return { repo, number: pr.number, title: pr.title, url: pr.url, body: pr.body, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? null }
  })
}

function output(values: Record<string, string>) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  for (const [key, value] of Object.entries(values)) {
    if (value.includes('\n')) appendFileSync(file, `${key}<<KEHIKOT_PLAN_END\n${value}\nKEHIKOT_PLAN_END\n`)
    else appendFileSync(file, `${key}=${value}\n`)
  }
}

function summary(text: string) {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

async function main() {
  const desktopSha = process.env.DESKTOP_SHA || process.env.GITHUB_SHA || (await sh(['git', 'rev-parse', 'HEAD']))
  const hostRef = (process.env.HOST_REF || readFileSync(join(ROOT, 'host.ref'), 'utf8')).trim()

  const tags = lines(await gh(['--paginate', `repos/${DESKTOP}/git/matching-refs/tags/v`, '--jq', '.[].ref']))
  const releases = lines(await gh([`repos/${DESKTOP}/releases?per_page=30`, '--jq', '.[] | {tag: .tag_name, draft, body} | @json'])).map((line) => JSON.parse(line) as ReleaseInfo)
  const running = await Promise.all(['in_progress', 'queued', 'waiting', 'pending'].map(async (status) => Number(await gh([`repos/${DESKTOP}/actions/workflows/release.yml/runs?status=${status}&per_page=1`, '--jq', '.total_count']))))
  // --from vX.Y.Z plans as if that were the latest release: a dry run's way to
  // see the notes a range would get. The workflow passes it only in a dry run.
  const from = arg('from') || process.env.PLAN_FROM || ''
  const base = baseline({ tags: from ? [from] : tags, releases, building: !from && running.some((n) => n > 0), hostRepo: HOST })

  if (!base.ok) {
    summary(`## No release\n\n${base.reason}`)
    output({ release: 'false', reason: base.reason })
    process.exit(base.wait ? 0 : 1)
  }

  const hostSha = /^[0-9a-f]{40}$/.test(hostRef) ? hostRef : (await gh([`repos/${HOST}/commits/${hostRef}`, '--jq', '.sha'])).trim()
  const host = await compare(HOST, base.hostSha, hostSha)
  if (host.status !== 'ahead' && host.status !== 'identical') {
    const reason = `${HOST}@${hostRef} (${hostSha.slice(0, 7)}) is ${host.status} of ${base.hostSha.slice(0, 7)}, the commit ${base.tag} was built from; a release only moves the host forward.`
    summary(`## No release\n\n${reason}`)
    output({ release: 'false', reason })
    process.exit(1)
  }
  const desktop = await compare(DESKTOP, base.tag, desktopSha)

  const prs = [
    ...(host.commits.size ? prsInRange(await mergedPrs(HOST, host.since), host.commits) : []),
    ...(desktop.commits.size ? prsInRange(await mergedPrs(DESKTOP, desktop.since), desktop.commits) : []),
  ]
  const collected = collectNotes(prs)
  const tag = `v${base.next}`
  const say = (pr: MergedPr) => `${pr.repo}#${pr.number} ${pr.title}`

  const report = [
    `## Next app release: ${collected.notes.length ? tag : 'none'}`,
    '',
    `- Latest release: ${base.tag}, built from ${HOST}@${base.hostSha.slice(0, 7)}`,
    `- Host now: ${HOST}@${hostSha.slice(0, 7)} (${hostRef}), ${host.commits.size} commit(s) ahead`,
    `- App now: ${DESKTOP}@${desktopSha.slice(0, 7)}, ${desktop.commits.size} commit(s) since ${base.tag}`,
    `- Merged pull requests: ${prs.length} (${collected.notes.length} with a note, ${collected.none.length} \`none\`, ${collected.missing.length} without a Release note section)`,
    ...collected.notes.map(({ pr, lines: said }) => `  - note: ${say(pr)}: ${said.join(' / ')}`),
    ...collected.none.map((pr) => `  - none: ${say(pr)}`),
    ...collected.missing.map((pr) => `  - no section (skipped): ${say(pr)}`),
  ]

  if (!collected.notes.length) {
    const reason = prs.length ? `None of the ${prs.length} merged pull request(s) has a release note.` : `Nothing merged since ${base.tag}.`
    summary([...report, '', reason].join('\n'))
    output({ release: 'false', reason, host_sha: hostSha })
    return
  }

  const notes = renderNotes(collected)
  const dir = arg('notes-dir') || mkdtempSync(join(tmpdir(), 'kehikot-notes-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${base.next}.md`)
  writeFileSync(file, notes)
  summary([...report, '', `### notes/${base.next}.md`, '', '```markdown', notes.trimEnd(), '```'].join('\n'))
  output({ release: 'true', reason: `${collected.notes.length} merged pull request(s) with a release note.`, version: base.next, tag, host_sha: hostSha, notes_file: file })
}

await main()
