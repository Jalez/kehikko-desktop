import { describe, expect, test } from 'bun:test'

import { appReleaseUrl, builtFrom, decide, type Gh, mirrorBody, mirrorRelease, mirrorTitle, whatsNew } from './mirror'

const SHA = '498e1c22e478d9fd03e2f00b3875978904a41b32'
const APP_BODY = `### What's new
#### Breaking

- **Appearance is a tab.** Settings has it.

#### Fixed

- **A fix.** It works.

<sub>Built from [Jalez/kehikko@498e1c2](https://github.com/Jalez/kehikko/commit/${SHA}).</sub>`

describe('reading an app release body', () => {
  test('the built-from commit is the full sha from the link', () => {
    expect(builtFrom(APP_BODY)).toBe(SHA)
  })
  test('a short sha without a link is returned as written', () => {
    expect(builtFrom('Built from Jalez/kehikko@498e1c2')).toBe('498e1c2')
  })
  test('no line, no commit', () => {
    expect(builtFrom("### What's new\n- x")).toBeNull()
  })
  test("What's new stops before the built-from line, groups kept", () => {
    const w = whatsNew(APP_BODY)
    expect(w.startsWith("### What's new\n#### Breaking")).toBe(true)
    expect(w).toContain('#### Fixed')
    expect(w).not.toContain('Built from')
  })
})

describe('the mirrored release', () => {
  test('title and body', () => {
    const url = appReleaseUrl('v0.4.0')
    expect(mirrorTitle('v0.4.0')).toBe('Kehikot v0.4.0')
    expect(url).toBe('https://github.com/Jalez/kehikko-desktop/releases/tag/v0.4.0')
    const body = mirrorBody(APP_BODY, SHA, url)
    expect(body).toBe(`${whatsNew(APP_BODY)}\n\nBuilt from ${SHA}\n\nDownload: ${url}\n`)
  })
})

describe('what to do', () => {
  test('nothing there: tag and release', () => {
    expect(decide('v1.0.0', SHA, { tagCommit: null, releaseExists: false })).toEqual({ action: 'create', tag: true })
  })
  test('tag on the right commit, no release: release only', () => {
    expect(decide('v1.0.0', SHA, { tagCommit: SHA, releaseExists: false })).toEqual({ action: 'create', tag: false })
  })
  test('release exists: skip', () => {
    expect(decide('v1.0.0', SHA, { tagCommit: SHA, releaseExists: true }).action).toBe('skip')
    expect(decide('v1.0.0', SHA, { tagCommit: null, releaseExists: true }).action).toBe('skip')
  })
  test('tag on another commit: conflict, even with a release', () => {
    const other = 'a'.repeat(40)
    expect(decide('v1.0.0', SHA, { tagCommit: other, releaseExists: false }).action).toBe('conflict')
    expect(decide('v1.0.0', SHA, { tagCommit: other, releaseExists: true }).action).toBe('conflict')
  })
})

/** A fake gh over an in-memory host repository. */
function fake(state: { tag?: string; release?: boolean }) {
  const calls: string[][] = []
  const gh: Gh = async (args) => {
    calls.push(args)
    const joined = args.join(' ')
    if (joined.includes('/git/ref/tags/')) return state.tag ? `commit ${state.tag}` : ''
    if (joined.includes('/releases/tags/')) return state.release ? '1' : ''
    if (joined.includes('/git/tags') && args.includes('-f')) return 'objsha'
    return ''
  }
  return { gh, calls }
}

describe('mirrorRelease', () => {
  const writes = (calls: string[][]) => calls.filter((c) => c[0] === 'release' || c.includes('-f'))

  test('creates the tag then the release, with the latest flag', async () => {
    const { gh, calls } = fake({})
    const r = await mirrorRelease(gh, { tag: 'v0.4.0', appBody: APP_BODY, latest: true })
    expect(r.outcome).toBe('created')
    const w = writes(calls)
    expect(w.length).toBe(3)
    expect(w[2]).toContain('--latest=true')
    expect(w[2]).toContain('--verify-tag')
    expect(w[2]).toContain('Kehikot v0.4.0')
  })
  test('a second run writes nothing', async () => {
    const { gh, calls } = fake({ tag: SHA, release: true })
    const r = await mirrorRelease(gh, { tag: 'v0.4.0', appBody: APP_BODY, latest: true })
    expect(r.outcome).toBe('skipped')
    expect(writes(calls)).toEqual([])
  })
  test('an existing tag on the right commit is reused', async () => {
    const { gh, calls } = fake({ tag: SHA })
    const r = await mirrorRelease(gh, { tag: 'v0.4.0', appBody: APP_BODY, latest: false })
    expect(r.outcome).toBe('created')
    expect(writes(calls).length).toBe(1)
    expect(writes(calls)[0]).toContain('--latest=false')
  })
  test('a tag on another commit is reported and nothing written', async () => {
    const { gh, calls } = fake({ tag: 'b'.repeat(40) })
    const r = await mirrorRelease(gh, { tag: 'v0.4.0', appBody: APP_BODY, latest: true })
    expect(r.outcome).toBe('conflict')
    expect(writes(calls)).toEqual([])
  })
  test('a body without a built-from line is skipped', async () => {
    const { gh, calls } = fake({})
    const r = await mirrorRelease(gh, { tag: 'v0.1.0', appBody: "### What's new\n- x", latest: false })
    expect(r.outcome).toBe('skipped')
    expect(calls).toEqual([])
  })
  test('a dry run writes nothing', async () => {
    const { gh, calls } = fake({})
    const r = await mirrorRelease(gh, { tag: 'v0.4.0', appBody: APP_BODY, latest: true, dryRun: true })
    expect(r.outcome).toBe('dry-run')
    expect(writes(calls)).toEqual([])
  })
})
