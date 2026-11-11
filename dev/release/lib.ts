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
// Semantic versioning: the kind of a change, and the version it asks for.

/** What a release can be: something removed or no longer working the same way, something new, a fix. */
export type Change = 'breaking' | 'feature' | 'fix'
/** A change, or `none`: nothing a person notices, nothing released. */
export type Kind = Change | 'none'

const CHANGES: readonly Change[] = ['fix', 'feature', 'breaking']
export const KINDS: readonly Kind[] = ['breaking', 'feature', 'fix', 'none']

/** The largest of the changes (`breaking` > `feature` > `fix`), or null for none. */
export function largestChange(changes: readonly Change[]): Change | null {
  let best = -1
  for (const change of changes) best = Math.max(best, CHANGES.indexOf(change))
  return best < 0 ? null : CHANGES[best]
}

/**
 * The version a change asks for after `v`. Semver, with 0.x handled the common
 * way while the major is 0:
 *
 *   0.x:   breaking → minor (0.1.9 → 0.2.0); feature and fix → patch
 *   ≥ 1.0: breaking → major; feature → minor; fix → patch
 */
export function bump(v: Version, change: Change): Version {
  if (v[0] === 0) return change === 'breaking' ? [0, v[1] + 1, 0] : [0, v[1], v[2] + 1]
  if (change === 'breaking') return [v[0] + 1, 0, 0]
  if (change === 'feature') return [v[0], v[1] + 1, 0]
  return [v[0], v[1], v[2] + 1]
}

/** The rule above, in words, for error messages. */
export const SEMVER_RULE = 'while 0.x: breaking → minor, feature or fix → patch; from 1.0: breaking → major, feature → minor, fix → patch'

const MARKS = /[`"'*_]/g
const KIND_LINE = /^[`"'*_]*kind[`"'*_]*\s*:/i

/**
 * A `Kind: <kind>` line (bold or backticks allowed, any case): the kind, `invalid`
 * with what was written when it names none of them, or null when the line is
 * not a Kind line at all.
 */
export function parseKindLine(line: string): { kind: Kind } | { invalid: string } | null {
  const said = line.trim().replace(/^[-*+]\s+/, '')
  if (!KIND_LINE.test(said)) return null
  const value = said.replace(KIND_LINE, '').replace(MARKS, '').replace(/[.\s]+$/, '').trim().toLowerCase()
  return (KINDS as readonly string[]).includes(value) ? { kind: value as Kind } : { invalid: value }
}

export const KIND_HELP = 'Start it with one line saying the kind of change: `Kind: breaking` (something removed, or no longer working the same way), `Kind: feature` (something new), `Kind: fix`, or `Kind: none` (nothing a person notices: tests, refactors, docs, CI).'

const NOTES_KIND_HELP = 'Start it with one line saying the kind of change: `Kind: breaking` (something removed, or no longer working the same way), `Kind: feature` (something new) or `Kind: fix`.'

/**
 * The kind a notes text declares: its first line that is not blank and not an
 * HTML comment, or a heading (`# What's new`) before it, must be `Kind: …`.
 * `none` is not a release, so it is refused here too.
 */
export function notesKind(text: string): { ok: true; change: Change } | { ok: false; reason: string } {
  const lines = text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '').split('\n').map((line) => line.trim())
  const first = lines.find((line) => line && !/^#{1,6}\s/.test(line))
  const read = first ? parseKindLine(first) : null
  if (!read) return { ok: false, reason: `has no kind. ${NOTES_KIND_HELP}` }
  if ('invalid' in read) return { ok: false, reason: `says "Kind: ${read.invalid}", which is not a kind. ${NOTES_KIND_HELP}` }
  if (read.kind === 'none') return { ok: false, reason: 'says "Kind: none", but a version bump is a release: say `breaking`, `feature` or `fix`, or do not bump the version.' }
  return { ok: true, change: read.kind }
}

/** The text of a CHANGELOG's entry for a version: from its `## X.Y.Z` heading to the next `##` heading. */
export function changelogEntry(changelog: string, version: string): string | null {
  const escaped = version.replace(/\./g, '\\.')
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => new RegExp(`^#{2,3}\\s+\\[?v?${escaped}\\]?(?![\\w.])`).test(line))
  if (start < 0) return null
  const level = /^#+/.exec(lines[start])![0].length
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

export type BumpCheck = { ok: true; reason: string } | { ok: false; reason: string }

/**
 * Whether a pull request's version matches the kind its notes declare, against
 * the latest `vX.Y.Z` tag: no bump is fine (not a release); a bump must be
 * exactly the next version for the declared kind (`bump`).
 */
export function checkBump(input: { packageVersion: string; tags: readonly string[]; notes: string | null; notesName: string }): BumpCheck {
  const version = parseVersion(input.packageVersion)
  if (!version) return { ok: false, reason: `package.json version "${input.packageVersion}" is not X.Y.Z.` }
  const said = versionText(version)
  const latest = latestTag(input.tags)
  if (latest) {
    const order = compareVersions(version, latest.version)
    if (order === 0) return { ok: true, reason: `package.json is at ${said}, the latest tag; this is not a release.` }
    if (order < 0) return { ok: false, reason: `package.json says ${said}, older than the latest tag ${latest.tag}.` }
  }
  if (input.notes === null) return { ok: false, reason: `package.json says ${said}, but ${input.notesName} is missing. Add it, starting with a \`Kind:\` line.` }
  const kind = notesKind(input.notes)
  if (!kind.ok) return { ok: false, reason: `${input.notesName} ${kind.reason}` }
  if (!latest) return { ok: true, reason: `${said} is the first release (${kind.change}).` }
  const want = versionText(bump(latest.version, kind.change))
  if (want !== said) {
    return {
      ok: false,
      reason: `${input.notesName} says Kind: ${kind.change}, so after ${latest.tag} the version is ${want}, not ${said} (${SEMVER_RULE}). Make package.json ${want} (and the notes with it), or correct the kind.`,
    }
  }
  return { ok: true, reason: `${said} is the ${kind.change} after ${latest.tag}.` }
}

// ---------------------------------------------------------------------------
// The app: release notes from merged pull requests.

export type PrNote =
  /** Lines for the release page. `declared` is false for a note without a Kind line (older PRs), which counts as a fix. */
  | { kind: 'note'; change: Change; declared: boolean; lines: string[] }
  | { kind: 'none'; declared: boolean }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }

const NONE = /^[`"'*_]*none[`"'*_.]*$/i

/**
 * The `## Release note` section of a pull request description. Its first line
 * declares the kind of change, `Kind: breaking | feature | fix | none`; then
 * comes the note: the first paragraph after it (the lines up to a blank line,
 * or the next heading of the same or a higher level), with HTML comments (the
 * template's guidance) removed and a leading bullet mark dropped. Whatever
 * follows a blank line (a footer, a signature) is not part of it.
 *
 * `Kind: none`, or a bare `none` (in any case, in backticks), means nothing for
 * the release page. A section without a Kind line is read the way it was before
 * kinds (`declared: false`; the check refuses it, the planner counts it as a
 * fix). No section, or a section left empty, is `missing`; an unknown kind, or
 * a release kind with no line under it, is `invalid`.
 */
export function parsePrNote(body: string | null | undefined): PrNote {
  const text = (body ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s+release\s+notes?\s*:?\s*$/i.test(line.trim()))
  if (start < 0) return { kind: 'missing' }
  const level = /^#+/.exec(lines[start].trim())![0].length
  let rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => {
    const heading = /^(#{1,6})\s/.exec(line.trim())
    return heading !== null && heading[1].length <= level
  })
  if (end >= 0) rest = rest.slice(0, end)
  const firstAt = rest.findIndex((line) => line.trim())
  if (firstAt < 0) return { kind: 'missing' }
  const declared = parseKindLine(rest[firstAt])
  if (declared && 'invalid' in declared) return { kind: 'invalid', reason: `"Kind: ${declared.invalid}" is not a kind. ${KIND_HELP}` }
  if (declared) rest = rest.slice(firstAt + 1)
  const out: string[] = []
  for (const line of rest) {
    const said = line.trim().replace(/^[-*+]\s+/, '').trim()
    if (said) out.push(said)
    else if (out.length) break
  }
  if (declared?.kind === 'none') return { kind: 'none', declared: true }
  if (declared) {
    const note = out.filter((line) => !NONE.test(line))
    if (!note.length) return { kind: 'invalid', reason: `"Kind: ${declared.kind}" has no line under it. Add one line on what a person using Kehikot notices (**Short bold lead.** One plain sentence.), or say \`Kind: none\`.` }
    return { kind: 'note', change: declared.kind, declared: true, lines: note }
  }
  if (!out.length) return { kind: 'missing' }
  if (out.every((line) => NONE.test(line))) return { kind: 'none', declared: false }
  return { kind: 'note', change: 'fix', declared: false, lines: out.filter((line) => !NONE.test(line)) }
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
  /** `declared` false: a note without a Kind line, merged before kinds, counted as a fix. */
  notes: { pr: MergedPr; change: Change; declared: boolean; lines: string[] }[]
  none: MergedPr[]
  /** No section, an empty one, or one the check would refuse (an unknown kind): skipped. */
  missing: MergedPr[]
}

export function collectNotes(prs: readonly MergedPr[]): Collected {
  const out: Collected = { notes: [], none: [], missing: [] }
  for (const pr of prs) {
    const note = parsePrNote(pr.body)
    if (note.kind === 'note') out.notes.push({ pr, change: note.change, declared: note.declared, lines: note.lines })
    else if (note.kind === 'none') out.none.push(pr)
    else out.missing.push(pr)
  }
  return out
}

/** The next app version after `v` for what was collected: the largest kind among the notes decides. Null when there is nothing to release. */
export function nextVersion(v: Version, collected: Pick<Collected, 'notes'>): Version | null {
  const change = largestChange(collected.notes.map((one) => one.change))
  return change ? bump(v, change) : null
}

/** The headings the notes are grouped under, largest kind first. */
export const GROUPS: readonly { change: Change; heading: string }[] = [
  { change: 'breaking', heading: 'Breaking' },
  { change: 'feature', heading: 'New' },
  { change: 'fix', heading: 'Fixed' },
]

/**
 * `notes/<version>.md` as the app's release gate reads it: the bullets grouped
 * by kind under `#### Breaking`, `#### New` and `#### Fixed` (level 4, so they
 * sit inside the release body's `### What's new`), one bullet per line, groups
 * with nothing left out.
 */
export function renderNotes(collected: Pick<Collected, 'notes'>): string {
  const blocks = GROUPS.map(({ change, heading }) => {
    const bullets = collected.notes.filter((one) => one.change === change).flatMap(({ lines }) => lines.map((line) => `- ${line}`))
    return bullets.length ? `#### ${heading}\n\n${bullets.join('\n')}` : ''
  }).filter(Boolean)
  return blocks.join('\n\n') + '\n'
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
  | { ok: true; tag: string; version: Version; hostSha: string }
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
  return { ok: true, tag: latest.tag, version: latest.version, hostSha }
}
