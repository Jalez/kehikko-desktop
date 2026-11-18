// The "Automatic app release failed" issue, and when it stops being true.
//
// While one is open, auto-release.yml releases nothing. It is opened when a
// release fails and nobody used to close it when the build was later re-run on
// the same tag and succeeded: a published v0.7.17 sat behind an open issue for
// hours. Two callers close it, both through `healFailedIssues`:
//   - release.yml, right after it publishes a tag (`close-for <tag>`);
//   - auto-release.yml's plan, for any open issue whose tag is already
//     published (`heal`), so a missed close never blocks the next release.
// Usage: bun dev/release/failed-issue.ts close-for <vX.Y.Z> | heal
// Prints `issue=<number>` (the failure that is STILL blocking, or empty) for
// `heal`, so the plan step can pass it on.

import { appendFileSync } from 'node:fs'

export const FAILED_TITLE = 'Automatic app release failed'
const TAG_RE = /\bv\d+\.\d+\.\d+\b/

export interface FailedIssue {
  number: number
  title: string
  body: string
}

export interface Gh {
  /** Open issues whose title is exactly FAILED_TITLE. */
  openFailures(): Promise<FailedIssue[]>
  /** True when the release exists and is not a draft. */
  isPublished(tag: string): Promise<boolean>
  /** Comment, then close. */
  close(issue: number, comment: string): Promise<void>
}

/** The line the report step writes so an issue can be matched to its tag. */
export function tagLine(tag: string): string {
  return tag ? `Tag: ${tag}` : ''
}

/** The release tag a failure issue is about: its `Tag:` line, else the tag its sentence names. */
export function issueTag(body: string): string | null {
  const marked = /^Tag:\s*(v\d+\.\d+\.\d+)\s*$/m.exec(body)
  if (marked) return marked[1]
  const said = /\b(?:Building|Tagging|Notarization failed:[^\n]*?of)\s+(v\d+\.\d+\.\d+)\b/.exec(body)
  if (said) return said[1]
  return null
}

export interface Healed {
  closed: { number: number; tag: string }[]
  /** Open failures that still block: no tag known, or the tag is not published. */
  blocking: number[]
}

/**
 * Close every open failure issue whose tag is published. `only` limits it to one tag
 * (the release that has just published). Never closes an issue it cannot tie to a tag.
 */
export async function healFailedIssues(gh: Gh, opts: { only?: string; why: string }): Promise<Healed> {
  const out: Healed = { closed: [], blocking: [] }
  for (const issue of await gh.openFailures()) {
    if (issue.title !== FAILED_TITLE) continue
    const tag = issueTag(issue.body ?? '')
    if (!tag || (opts.only && tag !== opts.only) || !(await gh.isPublished(tag))) {
      out.blocking.push(issue.number)
      continue
    }
    await gh.close(issue.number, `${tag} is published, so this failure is resolved (${opts.why}). Closing it; automatic releases continue.`)
    out.closed.push({ number: issue.number, tag })
  }
  return out
}

export function realGh(repo: string): Gh {
  const run = async (args: string[], allowFail = false): Promise<string> => {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    if ((await p.exited) !== 0) {
      if (allowFail) return ''
      throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.trim() || out.trim()}`)
    }
    return out
  }
  return {
    async openFailures() {
      const json = await run(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--search', `in:title "${FAILED_TITLE}"`, '--json', 'number,title,body'])
      return JSON.parse(json || '[]') as FailedIssue[]
    },
    async isPublished(tag) {
      const draft = await run(['release', 'view', tag, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft'], true)
      return draft.trim() === 'false'
    },
    async close(issue, comment) {
      await run(['issue', 'close', String(issue), '--repo', repo, '--comment', comment])
    },
  }
}

if (import.meta.main) {
  const [cmd, tag] = process.argv.slice(2)
  const repo = process.env.GITHUB_REPOSITORY ?? 'Jalez/kehikko-desktop'
  if (cmd === 'close-for' && tag && TAG_RE.test(tag)) {
    const r = await healFailedIssues(realGh(repo), { only: tag, why: `release.yml published it` })
    for (const c of r.closed) console.log(`Closed #${c.number}: ${c.tag} is published.`)
    if (!r.closed.length) console.log(`No open "${FAILED_TITLE}" issue for ${tag}.`)
  } else if (cmd === 'heal') {
    const r = await healFailedIssues(realGh(repo), { why: 'found by the next automatic release' })
    for (const c of r.closed) console.log(`::notice::Closed #${c.number} ("${FAILED_TITLE}"): ${c.tag} is already published, so it no longer blocks a release.`)
    const first = r.blocking[0]
    if (first !== undefined) {
      console.log(`::notice::Issue #${first} is open: an earlier automatic release failed. Fix it and close the issue; until then nothing is released.`)
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `issue=${first ?? ''}\n`)
    else console.log(`issue=${first ?? ''}`)
  } else {
    console.error('usage: bun dev/release/failed-issue.ts close-for <vX.Y.Z> | heal')
    process.exit(2)
  }
}
