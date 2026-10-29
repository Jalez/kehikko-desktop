import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { baseline, changelogHas, collectNotes, compareVersions, decideTag, hostShaFromBody, latestTag, type MergedPr, nextPatch, parsePrNote, parseVersion, prsInRange, renderNotes } from './lib'

const HERE = import.meta.dir
const SHA = 'f8d14cd77d4ae37c184cbdd7993f6cc2a1455840'

describe('versions', () => {
  test('X.Y.Z with or without v, and nothing else', () => {
    expect(parseVersion('0.1.88')).toEqual([0, 1, 88])
    expect(parseVersion('v2.33.0')).toEqual([2, 33, 0])
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('1.2.3-beta.1')).toBeNull()
    expect(parseVersion('app-v0.1.2')).toBeNull()
  })

  test('the latest tag is the highest version, not the last in text order', () => {
    expect(latestTag(['refs/tags/v0.1.87', 'refs/tags/v0.1.88', 'refs/tags/v0.1.9'])?.tag).toBe('v0.1.88')
    expect(latestTag(['v1.10.0', 'v1.9.9', 'v2.0.0-rc.1', 'app-v9.0.0', 'latest'])?.tag).toBe('v1.10.0')
    expect(latestTag([])).toBeNull()
  })

  test('next patch and ordering', () => {
    expect(nextPatch([0, 1, 88])).toEqual([0, 1, 89])
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0)
  })
})

describe('tag on merge (modules and the protocol)', () => {
  const tags = ['refs/tags/v1.9.0', 'refs/tags/v1.10.0']

  test('a newer version with notes is tagged', () => {
    expect(decideTag({ packageVersion: '1.11.0', tags, notesFound: true, notesName: 'notes/1.11.0.md' })).toEqual({ action: 'tag', tag: 'v1.11.0', version: '1.11.0', reason: 'v1.11.0 is newer than v1.10.0.' })
  })

  test('the same version is an ordinary push', () => {
    expect(decideTag({ packageVersion: '1.10.0', tags, notesFound: true, notesName: 'x' }).action).toBe('none')
    expect(decideTag({ packageVersion: '1.10.0', tags, notesFound: false, notesName: 'x' }).action).toBe('none')
  })

  test('a newer version without notes, or an older one, is refused and says why', () => {
    const missing = decideTag({ packageVersion: '1.11.0', tags, notesFound: false, notesName: 'notes/1.11.0.md' })
    expect(missing.action).toBe('refuse')
    expect(missing.reason).toContain('notes/1.11.0.md is missing')
    expect(decideTag({ packageVersion: '1.9.5', tags, notesFound: true, notesName: 'x' }).action).toBe('refuse')
    expect(decideTag({ packageVersion: '1.11', tags, notesFound: true, notesName: 'x' }).action).toBe('refuse')
  })

  test('the first release of a repository with no tags', () => {
    expect(decideTag({ packageVersion: '0.1.0', tags: [], notesFound: true, notesName: 'x' })).toMatchObject({ action: 'tag', tag: 'v0.1.0' })
  })

  test('the protocol: a CHANGELOG entry for the version', () => {
    const changelog = '# Changelog\n\n## 2.33.0 — 2026-10-29\n\nText.\n\n## 2.3.0 — old\n'
    expect(changelogHas(changelog, '2.33.0')).toBe(true)
    expect(changelogHas(changelog, '2.3.0')).toBe(true)
    expect(changelogHas(changelog, '2.33.1')).toBe(false)
    expect(changelogHas('## 2.33.0.1', '2.33.0')).toBe(false)
    expect(changelogHas('## [v2.34.0] - 2026', '2.34.0')).toBe(true)
  })
})

describe('a pull request release note', () => {
  const template = (note: string) => `## What changes\n\nStuff.\n\n## Release note\n\n<!--\nOne line for the app's release page.\nOr \`none\`.\n-->\n${note}\n`

  test('the line under the heading, with the template guidance dropped', () => {
    expect(parsePrNote(template('**Faster start.** The canvas opens sooner.'))).toEqual({ kind: 'note', lines: ['**Faster start.** The canvas opens sooner.'] })
  })

  test('a leading bullet mark is dropped; several lines are several bullets', () => {
    expect(parsePrNote(template('- **One.** First thing.\n* **Two.** Second thing.'))).toEqual({ kind: 'note', lines: ['**One.** First thing.', '**Two.** Second thing.'] })
  })

  test('none, in any spelling a person types it', () => {
    for (const none of ['none', 'None', '`none`', 'none.', '- none', '**none**']) expect(parsePrNote(template(none))).toEqual({ kind: 'none' })
  })

  test('the section ends at the next heading of the same level', () => {
    expect(parsePrNote('## Release note\nShown.\n### detail\nAlso part.\n## Testing\nNot part.')).toEqual({ kind: 'note', lines: ['Shown.', '### detail', 'Also part.'] })
  })

  test('the section is its first paragraph: a footer after a blank line is not part of it', () => {
    const footer = '\n\n🤖 Generated with [a tool](https://example.com)\n\nhttps://example.com/session'
    expect(parsePrNote(`## Release note\n\nnone${footer}`)).toEqual({ kind: 'none' })
    expect(parsePrNote(`## Release note\n\n- **One.** First.\n- **Two.** Second.${footer}`)).toEqual({ kind: 'note', lines: ['**One.** First.', '**Two.** Second.'] })
  })

  test('missing: no section, an empty one, only the template comment, or no body at all', () => {
    expect(parsePrNote('## What changes\nStuff.')).toEqual({ kind: 'missing' })
    expect(parsePrNote(template(''))).toEqual({ kind: 'missing' })
    expect(parsePrNote(null)).toEqual({ kind: 'missing' })
    expect(parsePrNote('## Release note\n## Next\nx')).toEqual({ kind: 'missing' })
  })

  test('Windows line ends and "Release notes:" headings are read too', () => {
    expect(parsePrNote('### Release notes:\r\n\r\n**A.** B.\r\n')).toEqual({ kind: 'note', lines: ['**A.** B.'] })
  })
})

const pr = (number: number, mergeCommit: string | null, body: string | null, mergedAt = `2026-10-29T1${number % 10}:00:00Z`, repo = 'Jalez/kehikko'): MergedPr => ({ repo, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, body, mergeCommit, mergedAt })

describe('collecting the notes of a release', () => {
  test('only pull requests merged inside the range, once each, oldest first', () => {
    const prs = [pr(3, 'c3', null, '2026-10-29T12:00:00Z'), pr(1, 'c1', null, '2026-10-29T10:00:00Z'), pr(2, 'outside', null), pr(1, 'c1', null, '2026-10-29T10:00:00Z'), pr(4, null, null)]
    expect(prsInRange(prs, new Set(['c1', 'c3'])).map((one) => one.number)).toEqual([1, 3])
  })

  test('notes are kept, none and missing are told apart, and the file is one bullet per line', () => {
    const collected = collectNotes([
      pr(1, 'a', '## Release note\n**Faster start.** The canvas opens sooner.'),
      pr(2, 'b', '## Release note\nnone'),
      pr(3, 'c', 'No section at all.'),
      pr(4, 'd', '## Release note\n- **Quieter Inbox.** Seen items stay seen.', undefined, 'Jalez/kehikko-desktop'),
    ])
    expect(collected.notes.map((one) => one.pr.number)).toEqual([1, 4])
    expect(collected.none.map((one) => one.number)).toEqual([2])
    expect(collected.missing.map((one) => one.number)).toEqual([3])
    expect(renderNotes(collected)).toBe('- **Faster start.** The canvas opens sooner.\n- **Quieter Inbox.** Seen items stay seen.\n')
  })

  test('the rendered notes pass the release gate, and placeholder notes do not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notes-gate-'))
    const gate = async (text: string) => {
      const file = join(dir, '0.1.89.md')
      writeFileSync(file, text)
      const child = Bun.spawn(['bash', join(HERE, 'notes-gate.sh'), file], { stdout: 'pipe' })
      return { code: await child.exited, out: await new Response(child.stdout).text() }
    }
    const good = await gate(renderNotes(collectNotes([pr(1, 'a', '## Release note\n**Faster start.** The canvas opens sooner.')])))
    expect(good).toEqual({ code: 0, out: '- **Faster start.** The canvas opens sooner.\n' })
    expect((await gate('- TODO write this\n')).code).toBe(1)
    expect((await gate('Nothing as a bullet.\n')).code).toBe(1)
  })
})

describe('where the next app release starts', () => {
  const body = `### What's new\n- **A.** B.\n\n<sub>Built from [Jalez/kehikko@f8d14cd](https://github.com/Jalez/kehikko/commit/${SHA}).</sub>`

  test('the host commit is read from the release body', () => {
    expect(hostShaFromBody(body)).toBe(SHA)
    expect(hostShaFromBody('Built from somewhere else')).toBeNull()
    expect(hostShaFromBody(`https://github.com/Jalez/kehikko-desktop/commit/${SHA}`)).toBeNull()
  })

  test('a published latest tag: the next patch, from the commit it was built from', () => {
    expect(baseline({ tags: ['refs/tags/v0.1.9', 'refs/tags/v0.1.88'], releases: [{ tag: 'v0.1.88', draft: false, body }], building: false })).toEqual({ ok: true, tag: 'v0.1.88', version: [0, 1, 88], next: '0.1.89', hostSha: SHA })
  })

  test('a latest tag still building waits; one stuck as a draft or without a release is for a person', () => {
    const tags = ['refs/tags/v0.1.88', 'refs/tags/v0.1.89']
    const releases = [{ tag: 'v0.1.89', draft: true, body }, { tag: 'v0.1.88', draft: false, body }]
    expect(baseline({ tags, releases, building: true })).toMatchObject({ ok: false, wait: true })
    const stuck = baseline({ tags, releases, building: false })
    expect(stuck).toMatchObject({ ok: false, wait: false })
    expect(!stuck.ok && stuck.reason).toContain('only a draft release')
    expect(baseline({ tags, releases: releases.slice(1), building: false })).toMatchObject({ ok: false, wait: false })
  })

  test('a release that does not say its host commit is refused', () => {
    expect(baseline({ tags: ['v0.1.88'], releases: [{ tag: 'v0.1.88', draft: false, body: 'no link' }], building: false })).toMatchObject({ ok: false, wait: false })
  })
})
