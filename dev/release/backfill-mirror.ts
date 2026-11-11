// One-off: mirror every published app release onto Jalez/kehikko, oldest first,
// so the newest ends up "latest". Uses the caller's own `gh` auth.
//   bun dev/release/backfill-mirror.ts --dry-run    # plan only
//   bun dev/release/backfill-mirror.ts              # create
// Idempotent: tags and releases that exist are skipped. Sleeps ~1 s between
// creations to stay under GitHub's secondary rate limits.
import { APP_REPO, mirrorRelease, realGh } from './mirror'

const dryRun = process.argv.includes('--dry-run')
const gh = realGh()

type Row = { tagName: string; isDraft: boolean; isPrerelease: boolean; publishedAt: string }
const rows: Row[] = JSON.parse(await gh(['api', '--paginate', `repos/${APP_REPO}/releases?per_page=100`, '--jq', '[.[] | {tagName: .tag_name, isDraft: .draft, isPrerelease: .prerelease, publishedAt: .published_at}]']).then((s) => {
  // --paginate with --jq prints one array per page
  return JSON.stringify(s.trim().split('\n').flatMap((l) => JSON.parse(l)))
}))

const semver = /^v(\d+)\.(\d+)\.(\d+)$/
const releases = rows
  .filter((r) => !r.isDraft && semver.test(r.tagName))
  .sort((a, b) => {
    const [x, y] = [a, b].map((r) => semver.exec(r.tagName)!.slice(1).map(Number))
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })

console.log(`${releases.length} published releases${dryRun ? ' (dry run)' : ''}`)
const skipped: string[] = []
const conflicts: string[] = []
let created = 0
for (const [i, r] of releases.entries()) {
  const body = (await gh(['release', 'view', r.tagName, '--repo', APP_REPO, '--json', 'body', '--jq', '.body'])).toString()
  const res = await mirrorRelease(gh, { tag: r.tagName, appBody: body, latest: i === releases.length - 1, dryRun })
  console.log(`${res.tag}: ${res.outcome} - ${res.detail}`)
  if (res.outcome === 'created') {
    created++
    await Bun.sleep(1000)
  }
  if (res.outcome === 'skipped') skipped.push(`${res.tag} (${res.detail})`)
  if (res.outcome === 'conflict') conflicts.push(`${res.tag} (${res.detail})`)
}
console.log(`\ncreated: ${created}`)
if (skipped.length) console.log(`skipped:\n  ${skipped.join('\n  ')}`)
if (conflicts.length) {
  console.log(`conflicts:\n  ${conflicts.join('\n  ')}`)
  process.exit(1)
}
