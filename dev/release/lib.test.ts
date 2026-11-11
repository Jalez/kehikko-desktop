import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { baseline, bump, changelogEntry, changelogHas, checkBump, collectNotes, compareVersions, decideTag, hostShaFromBody, largestChange, latestTag, type MergedPr, nextPatch, nextVersion, notesKind, parseKindLine, parsePrNote, parseVersion, prsInRange, renderNotes } from './lib'

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

  test('the kind, then the line under it, with the template guidance dropped', () => {
    expect(parsePrNote(template('Kind: feature\n**Faster start.** The canvas opens sooner.'))).toEqual({ kind: 'note', change: 'feature', declared: true, lines: ['**Faster start.** The canvas opens sooner.'] })
  })

  test('the kind in any spelling a person types it, with or without a blank line before the note', () => {
    for (const line of ['Kind: breaking', 'kind: Breaking', '**Kind:** breaking', 'Kind: `breaking`', '- Kind: breaking.', '`Kind: breaking`']) {
      expect(parsePrNote(template(`${line}\n\n**Gone.** The old switch is removed.`))).toEqual({ kind: 'note', change: 'breaking', declared: true, lines: ['**Gone.** The old switch is removed.'] })
    }
  })

  test('Kind: none needs no line, and any line under it is not carried', () => {
    expect(parsePrNote(template('Kind: none'))).toEqual({ kind: 'none', declared: true })
    expect(parsePrNote(template('Kind: none\nnone'))).toEqual({ kind: 'none', declared: true })
    expect(parsePrNote(template('Kind: none\n**Tests.** Faster.'))).toEqual({ kind: 'none', declared: true })
  })

  test('an unknown kind, or a release kind with no line, is invalid and says how to fix it', () => {
    const unknown = parsePrNote(template('Kind: minor\n**A.** B.'))
    expect(unknown.kind).toBe('invalid')
    expect(unknown.kind === 'invalid' && unknown.reason).toContain('`Kind: breaking`')
    expect(parsePrNote(template('Kind: fix')).kind).toBe('invalid')
    expect(parsePrNote(template('Kind: fix\nnone')).kind).toBe('invalid')
  })

  test('without a Kind line (merged before kinds): read as before, counted as an undeclared fix', () => {
    expect(parsePrNote(template('**Faster start.** The canvas opens sooner.'))).toEqual({ kind: 'note', change: 'fix', declared: false, lines: ['**Faster start.** The canvas opens sooner.'] })
  })

  test('a leading bullet mark is dropped; several lines are several bullets', () => {
    expect(parsePrNote(template('Kind: fix\n- **One.** First thing.\n* **Two.** Second thing.'))).toEqual({ kind: 'note', change: 'fix', declared: true, lines: ['**One.** First thing.', '**Two.** Second thing.'] })
  })

  test('a bare none, in any spelling a person types it, is none without a declared kind', () => {
    for (const none of ['none', 'None', '`none`', 'none.', '- none', '**none**']) expect(parsePrNote(template(none))).toEqual({ kind: 'none', declared: false })
  })

  test('the section ends at the next heading of the same level', () => {
    expect(parsePrNote('## Release note\nKind: fix\nShown.\n### detail\nAlso part.\n## Testing\nNot part.')).toEqual({ kind: 'note', change: 'fix', declared: true, lines: ['Shown.', '### detail', 'Also part.'] })
  })

  test('the section is its first paragraph: a footer after a blank line is not part of it', () => {
    const footer = '\n\n🤖 Generated with [a tool](https://example.com)\n\nhttps://example.com/session'
    expect(parsePrNote(`## Release note\n\nKind: none${footer}`)).toEqual({ kind: 'none', declared: true })
    expect(parsePrNote(`## Release note\n\nKind: feature\n\n- **One.** First.\n- **Two.** Second.${footer}`)).toEqual({ kind: 'note', change: 'feature', declared: true, lines: ['**One.** First.', '**Two.** Second.'] })
  })

  test('missing: no section, an empty one, only the template comment, or no body at all', () => {
    expect(parsePrNote('## What changes\nStuff.')).toEqual({ kind: 'missing' })
    expect(parsePrNote(template(''))).toEqual({ kind: 'missing' })
    expect(parsePrNote(null)).toEqual({ kind: 'missing' })
    expect(parsePrNote('## Release note\n## Next\nx')).toEqual({ kind: 'missing' })
  })

  test('Windows line ends and "Release notes:" headings are read too', () => {
    expect(parsePrNote('### Release notes:\r\n\r\nKind: fix\r\n**A.** B.\r\n')).toEqual({ kind: 'note', change: 'fix', declared: true, lines: ['**A.** B.'] })
  })
})

const pr = (number: number, mergeCommit: string | null, body: string | null, mergedAt = `2026-10-29T1${number % 10}:00:00Z`, repo = 'Jalez/kehikko'): MergedPr => ({ repo, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, body, mergeCommit, mergedAt })

describe('collecting the notes of a release', () => {
  test('only pull requests merged inside the range, once each, oldest first', () => {
    const prs = [pr(3, 'c3', null, '2026-10-29T12:00:00Z'), pr(1, 'c1', null, '2026-10-29T10:00:00Z'), pr(2, 'outside', null), pr(1, 'c1', null, '2026-10-29T10:00:00Z'), pr(4, null, null)]
    expect(prsInRange(prs, new Set(['c1', 'c3'])).map((one) => one.number)).toEqual([1, 3])
  })

  test('notes are kept with their kind, none and missing are told apart, and the file groups the bullets by kind', () => {
    const collected = collectNotes([
      pr(1, 'a', '## Release note\n**Faster start.** The canvas opens sooner.'),
      pr(2, 'b', '## Release note\nKind: none'),
      pr(3, 'c', 'No section at all.'),
      pr(4, 'd', '## Release note\nKind: feature\n- **Quieter Inbox.** Seen items stay seen.', undefined, 'Jalez/kehikko-desktop'),
      pr(5, 'e', '## Release note\nKind: breaking\n**Cleanup moved.** Worktree cleanup is now a module of its own.'),
      pr(6, 'f', '## Release note\nKind: bogus\n**A.** B.'),
      pr(7, 'g', '## Release note\nKind: fix\n**Steadier.** The bar no longer flickers.'),
    ])
    expect(collected.notes.map((one) => [one.pr.number, one.change, one.declared])).toEqual([[1, 'fix', false], [4, 'feature', true], [5, 'breaking', true], [7, 'fix', true]])
    expect(collected.none.map((one) => one.number)).toEqual([2])
    expect(collected.missing.map((one) => one.number)).toEqual([3, 6])
    expect(renderNotes(collected)).toBe(
      '#### Breaking\n\n- **Cleanup moved.** Worktree cleanup is now a module of its own.\n\n#### New\n\n- **Quieter Inbox.** Seen items stay seen.\n\n#### Fixed\n\n- **Faster start.** The canvas opens sooner.\n- **Steadier.** The bar no longer flickers.\n',
    )
  })

  test('a group with nothing in it is left out', () => {
    expect(renderNotes(collectNotes([pr(1, 'a', '## Release note\nKind: fix\n**A.** B.')]))).toBe('#### Fixed\n\n- **A.** B.\n')
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
    expect(good).toEqual({ code: 0, out: '#### Fixed\n\n- **Faster start.** The canvas opens sooner.\n' })
    expect(await gate('Kind: feature\n\n- **A thing.** It works now.\n')).toEqual({ code: 0, out: '\n- **A thing.** It works now.\n' })
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

  test('a published latest tag, and the commit it was built from', () => {
    expect(baseline({ tags: ['refs/tags/v0.1.9', 'refs/tags/v0.1.88'], releases: [{ tag: 'v0.1.88', draft: false, body }], building: false })).toEqual({ ok: true, tag: 'v0.1.88', version: [0, 1, 88], hostSha: SHA })
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

describe('semver: the version a kind asks for', () => {
  test('while 0.x: breaking is the next minor, anything else the next patch', () => {
    expect(bump([0, 1, 140], 'breaking')).toEqual([0, 2, 0])
    expect(bump([0, 1, 140], 'feature')).toEqual([0, 1, 141])
    expect(bump([0, 1, 140], 'fix')).toEqual([0, 1, 141])
  })

  test('from 1.0: breaking is major, feature minor, fix patch', () => {
    expect(bump([3, 4, 5], 'breaking')).toEqual([4, 0, 0])
    expect(bump([3, 4, 5], 'feature')).toEqual([3, 5, 0])
    expect(bump([3, 4, 5], 'fix')).toEqual([3, 4, 6])
  })

  test('the largest kind decides', () => {
    expect(largestChange(['fix', 'breaking', 'feature'])).toBe('breaking')
    expect(largestChange(['fix', 'feature'])).toBe('feature')
    expect(largestChange([])).toBeNull()
  })

  test('the next app version from what was collected; older notes without a kind count as fixes', () => {
    const notes = (...bodies: string[]) => collectNotes(bodies.map((body, i) => pr(i + 1, `c${i}`, `## Release note\n${body}`)))
    expect(nextVersion([0, 1, 140], notes('**A.** B.', 'Kind: fix\n**C.** D.'))).toEqual([0, 1, 141])
    expect(nextVersion([0, 1, 140], notes('Kind: feature\n**A.** B.'))).toEqual([0, 1, 141])
    expect(nextVersion([0, 1, 140], notes('Kind: fix\n**A.** B.', 'Kind: breaking\n**C.** D.'))).toEqual([0, 2, 0])
    expect(nextVersion([1, 2, 3], notes('Kind: fix\n**A.** B.', 'Kind: feature\n**C.** D.'))).toEqual([1, 3, 0])
    expect(nextVersion([0, 1, 140], notes('Kind: none'))).toBeNull()
  })
})

describe('a module\'s (or the protocol\'s) version against its kind', () => {
  const tags = ['refs/tags/v1.18.0', 'refs/tags/v1.19.0']
  const notes = (kind: string) => `<!-- guidance -->\nKind: ${kind}\n\n- **A thing.** It works now.\n`
  const check = (packageVersion: string, text: string | null, t = tags) => checkBump({ packageVersion, tags: t, notes: text, notesName: `notes/${packageVersion}.md` })

  test('the Kind line of a notes file', () => {
    expect(notesKind(notes('feature'))).toEqual({ ok: true, change: 'feature' })
    expect(notesKind("### What's new\n**Kind:** `breaking`\n- x")).toEqual({ ok: true, change: 'breaking' })
    expect(notesKind('- **A thing.** No kind.').ok).toBe(false)
    expect(notesKind(notes('none')).ok).toBe(false)
    expect(notesKind(notes('major')).ok).toBe(false)
    expect(parseKindLine('Kindly note')).toBeNull()
    expect(parseKindLine('Kind: Feature.')).toEqual({ kind: 'feature' })
  })

  test('no bump is not a release, whatever the notes', () => {
    expect(check('1.19.0', null).ok).toBe(true)
  })

  test('a bump that matches its kind passes', () => {
    expect(check('1.19.1', notes('fix')).ok).toBe(true)
    expect(check('1.20.0', notes('feature')).ok).toBe(true)
    expect(check('2.0.0', notes('breaking')).ok).toBe(true)
  })

  test('a bump that does not match its kind fails and names the right version', () => {
    const patchForBreaking = check('1.19.1', notes('breaking'))
    expect(patchForBreaking.ok).toBe(false)
    expect(patchForBreaking.reason).toContain('the version is 2.0.0, not 1.19.1')
    expect(check('1.20.0', notes('fix')).reason).toContain('the version is 1.19.1, not 1.20.0')
    expect(check('1.21.0', notes('feature')).ok).toBe(false)
  })

  test('the 0.x rule: breaking is a minor, feature and fix a patch', () => {
    const zero = ['v0.5.0']
    expect(check('0.6.0', notes('breaking'), zero).ok).toBe(true)
    expect(check('0.5.1', notes('feature'), zero).ok).toBe(true)
    expect(check('0.5.1', notes('fix'), zero).ok).toBe(true)
    expect(check('0.6.0', notes('feature'), zero).ok).toBe(false)
    expect(check('0.5.1', notes('breaking'), zero).ok).toBe(false)
    expect(check('1.0.0', notes('breaking'), zero).ok).toBe(false)
  })

  test('a bump without notes, without a kind, or older than the latest tag fails and says why', () => {
    expect(check('1.20.0', null).reason).toContain('notes/1.20.0.md is missing')
    expect(check('1.20.0', '- **A thing.** No kind.').reason).toContain('has no kind')
    expect(check('1.20.0', notes('none')).reason).toContain('Kind: none')
    expect(check('1.18.5', notes('fix')).reason).toContain('older than the latest tag')
  })

  test('the first release of a repository with no tags only needs its kind', () => {
    expect(check('0.1.0', notes('feature'), []).ok).toBe(true)
    expect(check('0.1.0', '- x', []).ok).toBe(false)
  })

  test('the protocol: the Kind line of a CHANGELOG entry', () => {
    const changelog = '# Changelog\n\nIntro.\n\n## 2.79.0 — 2026-11-11\n\nKind: feature\n\nText.\n\n### Added\n\n- x\n\n## 2.78.0 — 2026-11-10\n\nOld text.\n'
    expect(changelogEntry(changelog, '2.79.0')).toBe('\nKind: feature\n\nText.\n\n### Added\n\n- x\n')
    expect(changelogEntry(changelog, '2.78.0')).toBe('\nOld text.\n')
    expect(changelogEntry(changelog, '2.80.0')).toBeNull()
    expect(checkBump({ packageVersion: '2.79.0', tags: ['v2.78.0'], notes: changelogEntry(changelog, '2.79.0'), notesName: 'x' }).ok).toBe(true)
    expect(checkBump({ packageVersion: '2.78.1', tags: ['v2.78.0'], notes: changelogEntry(changelog, '2.78.0'), notesName: 'x' }).ok).toBe(false)
  })

  test('check-bump.ts, run in a repository with --local, exits 1 with an annotation on a mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-bump-'))
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    git('init', '-q')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.19.0' }))
    git('add', '.')
    git('commit', '-qm', 'one')
    git('tag', 'v1.19.0')
    const run = async (version: string, kind: string) => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
      Bun.spawnSync(['mkdir', '-p', join(dir, 'notes')])
      writeFileSync(join(dir, 'notes', `${version}.md`), notes(kind))
      const child = Bun.spawn(['bun', join(HERE, 'check-bump.ts'), '--local', '--dir', dir], { stdout: 'pipe' })
      return { code: await child.exited, out: await new Response(child.stdout).text() }
    }
    expect((await run('1.20.0', 'feature')).code).toBe(0)
    const bad = await run('1.19.1', 'breaking')
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('::error file=notes/1.19.1.md::')
  })
})
