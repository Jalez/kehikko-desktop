// Mirror an app release onto the host repository (Jalez/kehikko) as a release
// with no binaries: the tag vX.Y.Z on the commit the app was built from, the
// same "What's new", and a link to the download. Pure helpers here; the
// workflow step (mirror-release.ts) and the backfill (backfill-mirror.ts) share
// `mirrorRelease`, which is idempotent.

export const HOST_REPO = 'Jalez/kehikko'
export const APP_REPO = 'Jalez/kehikko-desktop'

const SHA_RE = /Built from \[?Jalez\/kehikko@([0-9a-f]{7,40})\]?(?:\([^)]*\/commit\/([0-9a-f]{40})\))?/i

/** The commit an app release body says it was built from (the full sha when the link carries it). */
export function builtFrom(body: string): string | null {
  const m = SHA_RE.exec(body)
  if (!m) return null
  return (m[2] ?? m[1]).toLowerCase()
}

/** The "### What's new" section of an app release body, without the "Built from" line. */
export function whatsNew(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => /^###\s+What's new\s*$/i.test(l))
  const from = start === -1 ? 0 : start
  const out: string[] = []
  for (const line of lines.slice(from)) {
    if (/Built from/i.test(line)) break
    out.push(line)
  }
  const text = out.join('\n').trim()
  return text
}

/** The title of the mirrored release. */
export function mirrorTitle(tag: string): string {
  return `Kehikot ${tag}`
}

/** The body of the mirrored release: What's new, the host commit, the download link. */
export function mirrorBody(appBody: string, sha: string, appReleaseUrl: string): string {
  const notes = whatsNew(appBody)
  return `${notes}\n\nBuilt from ${sha}\n\nDownload: ${appReleaseUrl}\n`
}

export function appReleaseUrl(tag: string): string {
  return `https://github.com/${APP_REPO}/releases/tag/${tag}`
}

export type Existing = {
  /** the commit the tag peels to in the host repository, or null when there is no such tag */
  tagCommit: string | null
  releaseExists: boolean
}

export type Step =
  | { action: 'skip'; reason: string }
  | { action: 'create'; tag: boolean }
  | { action: 'conflict'; reason: string }

/** What to do for one version, given what the host repository already has. */
export function decide(tag: string, sha: string, have: Existing): Step {
  if (have.tagCommit !== null && have.tagCommit !== sha) {
    return { action: 'conflict', reason: `${tag} already exists in ${HOST_REPO} at ${have.tagCommit.slice(0, 7)}, not at ${sha.slice(0, 7)}.` }
  }
  if (have.releaseExists) return { action: 'skip', reason: `${tag} already has a release in ${HOST_REPO}.` }
  return { action: 'create', tag: have.tagCommit === null }
}

/** The one place `gh` is called, so tests can stand in for it. Returns stdout; throws on failure. */
export type Gh = (args: string[], opts?: { allowFail?: boolean }) => Promise<string>

export type MirrorResult = { tag: string; outcome: 'created' | 'skipped' | 'conflict' | 'dry-run'; detail: string }

/** The commit a tag in the host repository peels to, or null when it is absent. */
export async function hostTagCommit(gh: Gh, tag: string): Promise<string | null> {
  const ref = await gh(['api', `repos/${HOST_REPO}/git/ref/tags/${tag}`, '--jq', '.object.type + " " + .object.sha'], { allowFail: true })
  if (!ref.trim()) return null
  const [type, sha] = ref.trim().split(' ')
  if (type === 'commit') return sha
  const peeled = await gh(['api', `repos/${HOST_REPO}/git/tags/${sha}`, '--jq', '.object.sha'])
  return peeled.trim()
}

export async function hostReleaseExists(gh: Gh, tag: string): Promise<boolean> {
  const out = await gh(['api', `repos/${HOST_REPO}/releases/tags/${tag}`, '--jq', '.id'], { allowFail: true })
  return out.trim() !== ''
}

/** Create the host tag and release for one app release; skip what exists. */
export async function mirrorRelease(
  gh: Gh,
  o: { tag: string; appBody: string; latest: boolean; dryRun?: boolean },
): Promise<MirrorResult> {
  const { tag } = o
  const sha = builtFrom(o.appBody)
  if (!sha || sha.length !== 40) return { tag, outcome: 'skipped', detail: 'no full "Built from" commit in the release body' }
  const have: Existing = { tagCommit: await hostTagCommit(gh, tag), releaseExists: await hostReleaseExists(gh, tag) }
  const step = decide(tag, sha, have)
  if (step.action === 'skip') return { tag, outcome: 'skipped', detail: step.reason }
  if (step.action === 'conflict') return { tag, outcome: 'conflict', detail: step.reason }
  if (o.dryRun) return { tag, outcome: 'dry-run', detail: `would ${step.tag ? 'tag and ' : ''}release ${tag} at ${sha.slice(0, 7)}${o.latest ? ' (latest)' : ''}` }

  const url = appReleaseUrl(tag)
  if (step.tag) {
    const obj = await gh([
      'api', `repos/${HOST_REPO}/git/tags`, '-f', `tag=${tag}`, '-f', `object=${sha}`, '-f', 'type=commit',
      '-f', `message=Kehikot ${tag}\n${url}`, '--jq', '.sha',
    ])
    await gh(['api', `repos/${HOST_REPO}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${obj.trim()}`])
  }
  const create = [
    'release', 'create', tag, '--repo', HOST_REPO, '--verify-tag', '--title', mirrorTitle(tag),
    '--notes', mirrorBody(o.appBody, sha, url), `--latest=${o.latest}`,
  ]
  // A tag just made through the API is sometimes not yet visible to the release call.
  for (let attempt = 1; ; attempt++) {
    try {
      await gh(create)
      break
    } catch (e) {
      if (attempt >= 5 || !/doesn't exist|not found/i.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  return { tag, outcome: 'created', detail: `${step.tag ? 'tagged and ' : ''}released ${tag} at ${sha.slice(0, 7)}${o.latest ? ' (latest)' : ''}` }
}

/** A `Gh` backed by the real CLI. */
export function realGh(): Gh {
  return async (args, opts) => {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    if (code !== 0) {
      if (opts?.allowFail) return ''
      throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.trim() || out.trim()}`)
    }
    return out
  }
}
