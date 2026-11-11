import { describe, expect, test } from 'bun:test'

import { appProtocol, decide, githubGet, type Get, parsePin, readPin } from './protocol-order'

const SHA = 'ff00642e5ce5fcff8e95d187f596440b565111e0'
const HOST_PKG = (pin: string) => JSON.stringify({ dependencies: { 'kehikot-module-protocol': pin } })
const module = (pin: string) => JSON.stringify({ version: '1.0.0', dependencies: { 'kehikot-module-protocol': pin } })
const TAG_PIN = (v: string) => `git+https://github.com/Jalez/kehikko-protocol.git#v${v}`

/** A fake GitHub: the newest app release was built from SHA, whose package.json pins `host`. */
function github(host: string, extra: Record<string, string> = {}): Get {
  const files: Record<string, string> = {
    'repos/Jalez/kehikko-desktop/releases/latest': JSON.stringify({ tag_name: 'v0.3.0', body: `x\n<sub>Built from [Jalez/kehikko@ff00642](https://github.com/Jalez/kehikko/commit/${SHA}).</sub>` }),
    [`repos/Jalez/kehikko/contents/package.json?ref=${SHA}`]: HOST_PKG(host),
    ...extra,
  }
  return async (path) => {
    if (!(path in files)) throw new Error(`GitHub answered 404 for ${path}`)
    return files[path]
  }
}

const run = async (pkg: string, get: Get, installed: string | null = null) => decide(await readPin({ pkg, installed, get }), await appProtocol(get))

describe('pins', () => {
  test('tag, commit, version and the rest', () => {
    expect(parsePin(TAG_PIN('2.80.0'))).toEqual({ kind: 'version', version: '2.80.0', repo: 'Jalez/kehikko-protocol' })
    expect(parsePin('git+ssh://git@github.com/Jalez/kehikko-protocol.git#v2.79.0')).toMatchObject({ kind: 'version', version: '2.79.0' })
    expect(parsePin('git+https://github.com/Jalez/kehikko-protocol.git#abcdef1234567')).toMatchObject({ kind: 'sha', sha: 'abcdef1234567' })
    expect(parsePin('^2.80.0')).toMatchObject({ kind: 'version', version: '2.80.0' })
    expect(parsePin('file:../protocol').kind).toBe('unknown')
    expect(parsePin('git+https://github.com/Jalez/kehikko-protocol.git#main').kind).toBe('unknown')
  })
})

describe('release order', () => {
  test('a pin newer than the app is refused, with the instruction', async () => {
    const said = await run(module(TAG_PIN('2.80.0')), github('git+ssh://git@github.com/Jalez/kehikko-protocol.git#v2.79.0'))
    expect(said.action).toBe('refuse')
    expect(said.message).toBe('This module needs protocol 2.80.0, but the newest Kehikot release (v0.3.0) has 2.79.0. Release the app first (host pinned to 2.80.0, app released), then re-run this workflow.')
  })

  test('equal or older passes', async () => {
    const get = github(TAG_PIN('2.79.0'))
    expect((await run(module(TAG_PIN('2.79.0')), get)).action).toBe('pass')
    expect((await run(module(TAG_PIN('2.41.0')), get)).action).toBe('pass')
  })

  test('a pin by commit is resolved through the protocol package.json there', async () => {
    const get = github(TAG_PIN('2.79.0'), { 'repos/Jalez/kehikko-protocol/contents/package.json?ref=abcdef1234567': JSON.stringify({ version: '2.80.0' }) })
    expect((await run(module('git+https://github.com/Jalez/kehikko-protocol.git#abcdef1234567'), get)).action).toBe('refuse')
  })

  test('an app whose host pins by commit is resolved the same way', async () => {
    const get = github('git+https://github.com/Jalez/kehikko-protocol.git#1234567abc', { 'repos/Jalez/kehikko-protocol/contents/package.json?ref=1234567abc': JSON.stringify({ version: '2.80.0' }) })
    expect((await run(module(TAG_PIN('2.80.0')), get)).action).toBe('pass')
  })

  test('an unreadable pin warns, says why and passes', async () => {
    const said = await run(module('file:../protocol'), github(TAG_PIN('2.79.0')))
    expect(said.action).toBe('warn')
    expect(said.message).toContain('not a tag')
    const nothing = await run(JSON.stringify({ version: '1.0.0' }), github(TAG_PIN('2.79.0')))
    expect(nothing).toMatchObject({ action: 'warn' })
    expect(nothing.message).toContain('pins no kehikot-module-protocol')
  })

  test('an unreadable pin falls back to the installed package version', async () => {
    const said = await run(module('file:../protocol'), github(TAG_PIN('2.79.0')), JSON.stringify({ version: '2.80.0' }))
    expect(said.action).toBe('refuse')
  })

  test('an unreadable app release warns and passes', async () => {
    const offline: Get = async () => {
      throw new Error('GitHub answered 403 (rate limited) for x')
    }
    const said = decide(await readPin({ pkg: module(TAG_PIN('2.80.0')), installed: null, get: offline }), await appProtocol(offline))
    expect(said.action).toBe('warn')
    expect(said.message).toContain('rate limited')
    const noSha = decide({ ok: true, version: '2.80.0' }, await appProtocol(async () => JSON.stringify({ tag_name: 'v0.3.0', body: 'no link' })))
    expect(noSha.message).toContain('does not say which')
  })
})

describe('rate limits', () => {
  const reply = (status: number, headers: Record<string, string> = {}, body = '{}') => new Response(body, { status, headers })

  test('a rate limit is waited out (capped) and retried', async () => {
    const waits: number[] = []
    const answers = [reply(403, { 'x-ratelimit-remaining': '0', 'retry-after': '5' }), reply(429), reply(200, {}, 'ok')]
    const get = githubGet('t', { fetch: (async () => answers.shift()) as unknown as typeof fetch, sleep: async (ms) => void waits.push(ms) })
    expect(await get('repos/x')).toBe('ok')
    expect(waits).toEqual([5000, 4000])
  })

  test('a limit that does not lift gives up with a message that says so; a 404 is not retried', async () => {
    let calls = 0
    const limited = githubGet(undefined, { fetch: (async () => (calls++, reply(429))) as unknown as typeof fetch, sleep: async () => {}, retries: 2 })
    await expect(limited('repos/x')).rejects.toThrow('rate limited')
    expect(calls).toBe(3)
    calls = 0
    const missing = githubGet(undefined, { fetch: (async () => (calls++, reply(404))) as unknown as typeof fetch, sleep: async () => {} })
    await expect(missing('repos/x')).rejects.toThrow('404')
    expect(calls).toBe(1)
  })
})
