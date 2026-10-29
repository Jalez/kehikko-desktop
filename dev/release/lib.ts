/**
 * The decisions behind Kehikot's automatic releases, as pure functions: which
 * version comes next, what a pull request's release note says, which merged
 * pull requests a release covers, and the notes file it writes. The commands
 * beside this file (`plan-app.ts`, `plan-tag.ts`, `pr-note.ts`) only read
 * GitHub and call these; `lib.test.ts` is what holds them.
 */

export type Version = readonly [number, number, number]

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/

/** `1.2.3` or `v1.2.3`, nothing else (no pre-release, no build). */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export const versionText = (v: Version) => `${v[0]}.${v[1]}.${v[2]}`

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The highest `vX.Y.Z` among tag names (`v1.2.3` or `refs/tags/v1.2.3`); others are ignored. */
export function latestTag(tags: readonly string[]): { tag: string; version: Version } | null {
  let best: { tag: string; version: Version } | null = null
  for (const raw of tags) {
    const tag = raw.replace(/^refs\/tags\//, '')
    if (!tag.startsWith('v')) continue
    const version = parseVersion(tag)
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag, version }
  }
  return best
}

export const nextPatch = (v: Version): Version => [v[0], v[1], v[2] + 1]

// ---------------------------------------------------------------------------
// Modules and the protocol: tag on merge.

export type TagDecision =
  | { action: 'tag'; tag: string; version: string; reason: string }
  | { action: 'none'; reason: string }
  | { action: 'refuse'; reason: string }

/**
 * Whether a push to `main` releases: package.json's version is newer than every
 * `vX.Y.Z` tag, and its notes are written. Equal is the ordinary case (a change
 * that is not a release). Older, or newer without notes, is a mistake to show.
 */
export function decideTag(input: { packageVersion: string; tags: readonly string[]; notesFound: boolean; notesName: string }): TagDecision {
  const version = parseVersion(input.packageVersion)
  if (!version) return { action: 'refuse', reason: `package.json version "${input.packageVersion}" is not X.Y.Z.` }
  const tag = `v${versionText(version)}`
  const latest = latestTag(input.tags)
  if (latest) {
    const order = compareVersions(version, latest.version)
    if (order === 0) return { action: 'none', reason: `${tag} is already tagged; this push is not a release.` }
    if (order < 0) return { action: 'refuse', reason: `package.json says ${versionText(version)}, older than the latest tag ${latest.tag}.` }
  }
  if (!input.notesFound) return { action: 'refuse', reason: `package.json says ${versionText(version)}, but ${input.notesName} is missing; nothing is tagged. Add it in a PR.` }
  return { action: 'tag', tag, version: versionText(version), reason: latest ? `${tag} is newer than ${latest.tag}.` : `${tag} is the first release.` }
}

/** Whether a CHANGELOG has an entry for a version: a heading `## X.Y.Z` (anything may follow). */
export function changelogHas(changelog: string, version: string): boolean {
  const escaped = version.replace(/\./g, '\\.')
  return new RegExp(`^#{2,3}\\s+\\[?v?${escaped}\\]?(?![\\w.])`, 'm').test(changelog)
}

// ---------------------------------------------------------------------------
// The app: release notes from merged pull requests.

export type PrNote = { kind: 'note'; lines: string[] } | { kind: 'none' } | { kind: 'missing' }

const NONE = /^[`"'*_]*none[`"'*_.]*$/i

/**
 * The `## Release note` section of a pull request description: the first
 * paragraph under the heading (the lines up to a blank line, or the next
 * heading of the same or a higher level), with HTML comments (the template's
 * guidance) removed and a leading bullet mark dropped. Whatever follows a blank
 * line (a footer, a signature) is not part of it. `none` (in any case, in backticks) means nothing for the release
 * page. No section, or a section left empty, is `missing`.
 */
export function parsePrNote(body: string | null | undefined): PrNote {
  const text = (body ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s+release\s+notes?\s*:?\s*$/i.test(line.trim()))
  if (start < 0) return { kind: 'missing' }
  const level = /^#+/.exec(lines[start].trim())![0].length
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s/.exec(line.trim())
    if (heading && heading[1].length <= level) break
    const said = line.trim().replace(/^[-*+]\s+/, '').trim()
    if (said) out.push(said)
    else if (out.length) break
  }
  if (!out.length) return { kind: 'missing' }
  if (out.every((line) => NONE.test(line))) return { kind: 'none' }
  return { kind: 'note', lines: out.filter((line) => !NONE.test(line)) }
}

export interface MergedPr {
  repo: string
  number: number
  title: string
  url: string
  body: string | null
  mergeCommit: string | null
  mergedAt: string
}

/** The merged pull requests whose merge (or squash) commit is one of the commits a release adds, oldest first. */
export function prsInRange(prs: readonly MergedPr[], commits: ReadonlySet<string>): MergedPr[] {
  const seen = new Set<string>()
  return prs
    .filter((pr) => pr.mergeCommit && commits.has(pr.mergeCommit))
    .filter((pr) => {
      const key = `${pr.repo}#${pr.number}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number)
}

export interface Collected {
  notes: { pr: MergedPr; lines: string[] }[]
  none: MergedPr[]
  missing: MergedPr[]
}

export function collectNotes(prs: readonly MergedPr[]): Collected {
  const out: Collected = { notes: [], none: [], missing: [] }
  for (const pr of prs) {
    const note = parsePrNote(pr.body)
    if (note.kind === 'note') out.notes.push({ pr, lines: note.lines })
    else if (note.kind === 'none') out.none.push(pr)
    else out.missing.push(pr)
  }
  return out
}

/** `notes/<version>.md` as the app's release gate reads it: one bullet per line, nothing else. */
export function renderNotes(collected: Collected): string {
  return collected.notes.flatMap(({ lines }) => lines.map((line) => `- ${line}`)).join('\n') + '\n'
}

/** The full commit the app release was built from, read from its body's "Built from Jalez/kehikko@…" link. */
export function hostShaFromBody(body: string | null | undefined, hostRepo = 'Jalez/kehikko'): string | null {
  const escaped = hostRepo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const m = new RegExp(`github\\.com/${escaped}/commit/([0-9a-f]{40})`).exec(body ?? '')
  return m ? m[1] : null
}

export interface ReleaseInfo {
  tag: string
  draft: boolean
  body: string | null
}

export type Baseline =
  | { ok: true; tag: string; version: Version; next: string; hostSha: string }
  | { ok: false; wait: boolean; reason: string }

/**
 * Where the next app release starts from: the highest `vX.Y.Z` tag, which must
 * have a PUBLISHED release saying which host commit it was built from. A tag
 * whose release is a draft or missing is either still building (`wait`, when a
 * release run is in progress) or failed, which a person has to look at.
 */
export function baseline(input: { tags: readonly string[]; releases: readonly ReleaseInfo[]; building: boolean; hostRepo?: string }): Baseline {
  const latest = latestTag(input.tags)
  if (!latest) return { ok: false, wait: false, reason: 'There is no vX.Y.Z tag yet; cut the first release by hand.' }
  const release = input.releases.find((one) => one.tag === latest.tag)
  if (!release || release.draft) {
    if (input.building) return { ok: false, wait: true, reason: `${latest.tag} is still being built; the next run will look again.` }
    return { ok: false, wait: false, reason: `${latest.tag} has ${release ? 'only a draft release' : 'no release'} and nothing is building it. Finish or remove it (re-run release.yml on the tag, or delete the draft and the tag).` }
  }
  const hostSha = hostShaFromBody(release.body, input.hostRepo)
  if (!hostSha) return { ok: false, wait: false, reason: `The ${latest.tag} release does not say which host commit it was built from ("Built from Jalez/kehikko@…").` }
  return { ok: true, tag: latest.tag, version: latest.version, next: versionText(nextPatch(latest.version)), hostSha }
}
