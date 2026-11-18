import { describe, expect, test } from 'bun:test'

import { FAILED_TITLE, type FailedIssue, type Gh, healFailedIssues, issueTag, tagLine } from './failed-issue'

function fake(issues: FailedIssue[], published: string[]) {
  const closed: { number: number; comment: string }[] = []
  const gh: Gh = {
    openFailures: async () => issues.filter((i) => !closed.some((c) => c.number === i.number)),
    isPublished: async (t) => published.includes(t),
    close: async (number, comment) => void closed.push({ number, comment }),
  }
  return { gh, closed }
}
const issue = (number: number, body: string, title = FAILED_TITLE): FailedIssue => ({ number, title, body })

describe('which tag a failure is about', () => {
  test('the Tag line the report writes', () => {
    expect(issueTag(`Building v0.7.17 failed.\n\n${tagLine('v0.7.17')}\n\nRun: x`)).toBe('v0.7.17')
  })
  test('no tag, no line', () => {
    expect(tagLine('')).toBe('')
  })
  test('issues written before the Tag line: the sentence names it', () => {
    expect(issueTag('Building v0.7.17 failed; the tag and a draft release exist.')).toBe('v0.7.17')
    expect(issueTag('Tagging v1.2.3 failed. If the ruleset refused it')).toBe('v1.2.3')
    expect(issueTag('Notarization failed: Apple did not accept a file of v0.7.9 within the bounded attempts.')).toBe('v0.7.9')
  })
  test('a planning failure has no tag', () => {
    expect(issueTag('Planning failed: a release note was refused.')).toBeNull()
  })
  test('a tag mentioned in passing is not the failure tag', () => {
    expect(issueTag('Planning failed. Compare with v0.7.1 by hand.')).toBeNull()
  })
})

describe('closing a failure whose tag is published', () => {
  test('release.yml publishing the tag closes its issue, naming the release', async () => {
    const { gh, closed } = fake([issue(140, 'Building v0.7.17 failed.\nTag: v0.7.17')], ['v0.7.17'])
    const r = await healFailedIssues(gh, { only: 'v0.7.17', why: 'release.yml published it' })
    expect(r.closed).toEqual([{ number: 140, tag: 'v0.7.17' }])
    expect(r.blocking).toEqual([])
    expect(closed[0].comment).toContain('v0.7.17 is published')
  })
  test('only the published tag: a failure for another tag stays open', async () => {
    const { gh, closed } = fake([issue(1, 'Tag: v0.7.17'), issue(2, 'Tag: v0.7.18')], ['v0.7.17', 'v0.7.18'])
    const r = await healFailedIssues(gh, { only: 'v0.7.17', why: 'x' })
    expect(closed.map((c) => c.number)).toEqual([1])
    expect(r.blocking).toEqual([2])
  })
  test('the plan heals every issue whose tag is published and proceeds', async () => {
    const { gh } = fake([issue(1, 'Tag: v0.7.17'), issue(2, 'Tag: v0.7.16')], ['v0.7.17', 'v0.7.16'])
    const r = await healFailedIssues(gh, { why: 'plan' })
    expect(r.closed.length).toBe(2)
    expect(r.blocking).toEqual([])
  })
  test('a draft or missing release is still a failure', async () => {
    const { gh, closed } = fake([issue(3, 'Tag: v0.7.18')], [])
    const r = await healFailedIssues(gh, { why: 'plan' })
    expect(closed).toEqual([])
    expect(r.blocking).toEqual([3])
  })
  test('an issue with no tag is never closed', async () => {
    const { gh, closed } = fake([issue(4, 'Planning failed: bad note.')], ['v0.7.17'])
    const r = await healFailedIssues(gh, { why: 'plan' })
    expect(closed).toEqual([])
    expect(r.blocking).toEqual([4])
  })
  test('another issue with a similar title is left alone', async () => {
    const { gh, closed } = fake([issue(5, 'Tag: v0.7.17', 'Automatic app release failed again')], ['v0.7.17'])
    const r = await healFailedIssues(gh, { why: 'plan' })
    expect(closed).toEqual([])
    expect(r.blocking).toEqual([])
  })
})
