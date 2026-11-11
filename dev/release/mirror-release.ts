// Run by release.yml after the app release is published: the same release on
// Jalez/kehikko. Usage: bun dev/release/mirror-release.ts <vX.Y.Z>
// App releases are read with the job's own token (GH_APP_TOKEN); the host
// repository is written with GH_TOKEN (HOST_TAG_TOKEN). Idempotent.
import { APP_REPO, mirrorRelease, realGh } from './mirror'

const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: bun dev/release/mirror-release.ts vX.Y.Z')
  process.exit(2)
}

const read = Bun.spawn(['gh', 'release', 'view', tag, '--repo', APP_REPO, '--json', 'body', '--jq', '.body'], {
  stdout: 'pipe', stderr: 'inherit', env: { ...process.env, GH_TOKEN: process.env.GH_APP_TOKEN ?? process.env.GH_TOKEN },
})
const appBody = await new Response(read.stdout).text()
if ((await read.exited) !== 0) {
  console.error(`could not read the ${tag} release of ${APP_REPO}`)
  process.exit(1)
}

// The app release was just published with --latest.
const r = await mirrorRelease(realGh(), { tag, appBody, latest: true })
console.log(`${r.outcome}: ${r.detail}`)
if (r.outcome === 'conflict') process.exit(1)
