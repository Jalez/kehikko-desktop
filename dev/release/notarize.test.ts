import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Clock, DEFAULTS, envAuth, notarize, type Options, type RunResult, staple, tauriArgs } from './notarize'

const MIN = 60_000
const AUTH = ['--apple-id', 'someone', '--password', 'SECRET-PW', '--team-id', 'TEAM']

/** A fake Apple: `submit` answers from `uploads` in turn; `info <id>` from that id's script in turn (the last answer repeats). */
function fakeApple(opts: {
  uploads: (RunResult | string)[]
  statuses: Record<string, string[]>
  log?: string
}) {
  let now = 0
  const calls: { args: string[]; at: number; timeoutMs: number }[] = []
  const seen: Record<string, number> = {}
  let u = 0
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
  const clock: Clock = { now: () => now, sleep: async ms => { now += ms } }
  const run = async (args: string[], timeoutMs: number): Promise<RunResult> => {
    calls.push({ args, at: now, timeoutMs })
    const [tool, verb, target] = args
    if (tool === 'notarytool' && verb === 'submit') {
      const a = opts.uploads[u++] ?? { code: 1, stdout: '', stderr: 'no more uploads scripted', timedOut: false }
      if (typeof a !== 'string') { if (a.timedOut) now += timeoutMs; return a }
      now += 2_000
      return ok(JSON.stringify({ id: a, message: 'Successfully uploaded file', path: args[2] }))
    }
    if (tool === 'notarytool' && verb === 'info') {
      const script = opts.statuses[target!] ?? ['In Progress']
      const i = seen[target!] = (seen[target!] ?? -1) + 1
      const status = script[Math.min(i, script.length - 1)]!
      if (status === 'ERROR') return { code: 69, stdout: '', stderr: 'network down', timedOut: false }
      return ok(JSON.stringify({ id: target, status, message: status === 'Accepted' ? 'Processing complete' : '' }))
    }
    if (tool === 'notarytool' && verb === 'log') return ok(opts.log ?? '{"issues":[]}')
    if (tool === 'stapler') return ok('The staple and validate action worked!')
    throw new Error(`unexpected xcrun ${args.join(' ')}`)
  }
  return { run, clock, calls, now: () => now }
}

function options(lines: string[], over: Partial<Options> = {}): Options {
  return { ...DEFAULTS, file: '/x/Kehikot_0.1.140_x64.dmg', auth: AUTH, log: l => lines.push(l), ...over }
}

describe('notarize', () => {
  test('accepted on the first try', async () => {
    const lines: string[] = []
    const apple = fakeApple({ uploads: ['sub-1'], statuses: { 'sub-1': ['In Progress', 'In Progress', 'Accepted'] } })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toBe('sub-1')
    expect(r.message).toBe('Processing complete')
    expect(r.summary).toContain('Kehikot_0.1.140_x64.dmg: Accepted, submission sub-1')
    expect(apple.calls.filter(c => c.args[1] === 'submit')).toHaveLength(1)
    // never waits with notarytool's own unbounded --wait
    expect(apple.calls.some(c => c.args.includes('--wait'))).toBe(false)
  })

  test('in progress past the deadline: checked once more, resubmitted, the new one accepted', async () => {
    const lines: string[] = []
    const apple = fakeApple({
      uploads: ['sub-1', 'sub-2'],
      statuses: { 'sub-1': ['In Progress'], 'sub-2': ['In Progress', 'Accepted'] },
    })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toBe('sub-2')
    const submits = apple.calls.filter(c => c.args[1] === 'submit')
    expect(submits).toHaveLength(2)
    // the second submission went out only after the first one's deadline, and
    // sub-1 was asked once more right at that deadline
    const firstUploadDone = 2_000
    expect(submits[1]!.at).toBeGreaterThanOrEqual(firstUploadDone + 12 * MIN)
    const lastSub1Check = apple.calls.filter(c => c.args[1] === 'info' && c.args[2] === 'sub-1' && c.at <= submits[1]!.at).at(-1)!
    expect(lastSub1Check.at).toBe(firstUploadDone + 12 * MIN)
    expect(lines.join('\n')).toContain('Still In Progress after 12 min: sub-1 In Progress (submission 1); submitting again')
    expect(r.submissions.map(s => s.id)).toEqual(['sub-1', 'sub-2'])
  })

  test('an earlier submission accepted while a resubmission waits wins', async () => {
    const lines: string[] = []
    const polls = Array(30).fill('In Progress')
    const apple = fakeApple({
      uploads: ['sub-1', 'sub-2'],
      statuses: { 'sub-1': [...polls, 'Accepted'], 'sub-2': ['In Progress'] },
    })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.id).toBe('sub-1')
  })

  test('accepted at the final check after the deadline: no resubmission', async () => {
    const lines: string[] = []
    // pollMs fixed at 3 min with a 10 min window: checks at 0, 3, 6, 9 and the final one at 10
    const apple = fakeApple({ uploads: ['sub-1'], statuses: { 'sub-1': ['In Progress', 'In Progress', 'In Progress', 'In Progress', 'Accepted'] } })
    const r = await notarize(options(lines, { pollMs: [3 * MIN], attemptMs: 10 * MIN }), apple.run, apple.clock)
    expect(r.ok).toBe(true)
    expect(apple.calls.filter(c => c.args[1] === 'submit')).toHaveLength(1)
    expect(apple.calls.filter(c => c.args[1] === 'info').at(-1)!.at).toBe(2_000 + 10 * MIN)
  })

  test('still in progress after every submission: fails naming every id and status', async () => {
    const lines: string[] = []
    const apple = fakeApple({ uploads: ['sub-1', 'sub-2', 'sub-3'], statuses: {} })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('timeout')
    expect(r.summary).toContain('NOT notarized, Apple had not finished after 3 submissions')
    expect(r.summary).toContain('sub-1 In Progress (submission 1), sub-2 In Progress (submission 2), sub-3 In Progress (submission 3)')
    expect(apple.calls.filter(c => c.args[1] === 'submit')).toHaveLength(3)
    // bounded: three windows of 12 min plus the uploads
    expect(apple.now()).toBeLessThanOrEqual(3 * 12 * MIN + 3 * 2_000)
  })

  test('invalid: fails at once with the log, no resubmission', async () => {
    const lines: string[] = []
    const apple = fakeApple({
      uploads: ['sub-1', 'sub-2'],
      statuses: { 'sub-1': ['In Progress', 'Invalid'] },
      log: '{"issues":[{"message":"The binary is not signed."}]}',
    })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid')
    expect(r.log).toContain('The binary is not signed.')
    expect(r.summary).toContain('Apple answered Invalid for submission sub-1')
    expect(apple.calls.filter(c => c.args[1] === 'submit')).toHaveLength(1)
    expect(apple.calls.some(c => c.args[1] === 'log' && c.args[2] === 'sub-1')).toBe(true)
    expect(apple.now()).toBeLessThan(2 * MIN)
  })

  test('an upload error or stall is retried, then the submission goes on', async () => {
    const lines: string[] = []
    const apple = fakeApple({
      uploads: [
        { code: 1, stdout: '', stderr: 'Error: HTTP status code: 500', timedOut: false },
        { code: -1, stdout: '', stderr: '', timedOut: true },
        'sub-1',
      ],
      statuses: { 'sub-1': ['Accepted'] },
    })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.id).toBe('sub-1')
    const submits = apple.calls.filter(c => c.args[1] === 'submit')
    expect(submits).toHaveLength(3)
    expect(submits.every(c => c.timeoutMs === DEFAULTS.uploadMs)).toBe(true)
    const text = lines.join('\n')
    expect(text).toContain('upload failed (exit 1: Error: HTTP status code: 500)')
    expect(text).toContain('upload failed (timed out)')
  })

  test('every upload failing: fails as an upload failure', async () => {
    const lines: string[] = []
    const bad = { code: 1, stdout: '', stderr: 'offline', timedOut: false }
    const apple = fakeApple({ uploads: Array(9).fill(bad), statuses: {} })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('upload')
    expect(r.summary).toContain('every upload to Apple failed (3 submissions, 3 tries each)')
    expect(apple.calls.filter(c => c.args[1] === 'submit')).toHaveLength(9)
  })

  test('a status that cannot be read is asked again', async () => {
    const lines: string[] = []
    const apple = fakeApple({ uploads: ['sub-1'], statuses: { 'sub-1': ['ERROR', 'ERROR', 'Accepted'] } })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(r.ok).toBe(true)
    expect(lines.join('\n')).toContain('Could not read the status of sub-1 (exit 69: network down)')
  })

  test('credentials reach notarytool and never the log', async () => {
    const lines: string[] = []
    const apple = fakeApple({ uploads: ['sub-1'], statuses: { 'sub-1': ['Invalid'] } })
    const r = await notarize(options(lines), apple.run, apple.clock)
    expect(apple.calls.every(c => c.args.includes('SECRET-PW'))).toBe(true)
    expect(lines.join('\n')).not.toContain('SECRET-PW')
    expect(r.summary).not.toContain('SECRET-PW')
  })
})

describe('staple', () => {
  test('retried until it works', async () => {
    let n = 0
    let now = 0
    const lines: string[] = []
    const ok = await staple({ file: '/x/a.dmg', commandMs: 1000, log: l => lines.push(l) },
      async () => (++n < 3 ? { code: 65, stdout: '', stderr: 'Could not find ticket', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false }),
      { now: () => now, sleep: async ms => { now += ms } })
    expect(ok).toBe(true)
    expect(n).toBe(3)
  })
})

describe('arguments', () => {
  test("Tauri's call: the file and the credentials, without --wait and the output format", () => {
    expect(tauriArgs(['/tmp/Kehikot.zip', '--output-format', 'json', '--wait', ...AUTH])).toEqual({ file: '/tmp/Kehikot.zip', auth: AUTH })
    expect(tauriArgs(['/tmp/Kehikot.zip', '--output-format', 'json', '--wait', '--key-id', 'K', '--key', '/t/AuthKey.p8', '--issuer', 'I']))
      .toEqual({ file: '/tmp/Kehikot.zip', auth: ['--key-id', 'K', '--key', '/t/AuthKey.p8', '--issuer', 'I'] })
    expect(tauriArgs(['--wait'])).toBeNull()
  })
  test('credentials from the environment, all three or none', () => {
    expect(envAuth({ APPLE_ID: 'a', APPLE_PASSWORD: 'p', APPLE_TEAM_ID: 't' })).toEqual(['--apple-id', 'a', '--password', 'p', '--team-id', 't'])
    expect(envAuth({ APPLE_ID: 'a', APPLE_PASSWORD: '', APPLE_TEAM_ID: 't' })).toBeNull()
  })
})

describe('the xcrun shim', () => {
  const shim = join(import.meta.dir, 'bin', 'xcrun')
  // a `bun` that prints what it was given, first on PATH
  const dir = mkdtempSync(join(tmpdir(), 'xcrun-shim-'))
  writeFileSync(join(dir, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  chmodSync(join(dir, 'bun'), 0o755)
  const runShim = (args: string[]) => Bun.spawnSync(['bash', shim, ...args], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } })

  test("Tauri's waiting submit goes to notarize-run.ts --tauri", () => {
    const r = runShim(['notarytool', 'submit', '/tmp/K.zip', '--output-format', 'json', '--wait', '--team-id', 'T'])
    const out = r.stdout.toString().trim().split('\n')
    expect(out[0]).toBe(join(import.meta.dir, 'notarize-run.ts'))
    expect(out.slice(1)).toEqual(['--tauri', '/tmp/K.zip', '--output-format', 'json', '--wait', '--team-id', 'T'])
  })
})

describe('notarize-run.ts', () => {
  const cli = join(import.meta.dir, 'notarize-run.ts')
  const dir = mkdtempSync(join(tmpdir(), 'notarize-run-'))
  const xcrun = join(dir, 'xcrun')
  // answers like notarytool: an id for submit, then the status in $STATUS
  writeFileSync(xcrun, `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "notarytool submit") echo '{"id":"sub-9","message":"Successfully uploaded file"}' ;;
  "notarytool info") echo "{\\"id\\":\\"sub-9\\",\\"status\\":\\"$STATUS\\",\\"message\\":\\"Processing complete\\"}" ;;
  "notarytool log") echo '{"issues":[{"message":"not signed"}]}' ;;
  "stapler staple") echo stapled ;;
esac
`)
  chmodSync(xcrun, 0o755)
  const record = join(dir, 'record.txt')
  const runCli = (args: string[], status: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(['bun', cli, ...args], { env: { ...process.env, NOTARIZE_XCRUN: xcrun, NOTARIZE_RECORD: record, NOTARIZE_LOG: '', STATUS: status, ...env } })

  test('--tauri answers the JSON Tauri reads, and nothing else on stdout', () => {
    const r = runCli(['--tauri', '/tmp/K.zip', '--output-format', 'json', '--wait', ...AUTH], 'Accepted')
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout.toString())).toEqual({ id: 'sub-9', status: 'Accepted', message: 'Processing complete' })
    expect(r.stderr.toString()).not.toContain('SECRET-PW')
  })

  test('--staple staples after Accepted; Invalid exits 1 with the log and records the ids', () => {
    const env = { APPLE_ID: 'a', APPLE_PASSWORD: 'SECRET-PW', APPLE_TEAM_ID: 't' }
    const ok = runCli(['--staple', '/tmp/K.dmg'], 'Accepted', env)
    expect(ok.exitCode).toBe(0)
    expect(Bun.file(join(dir, 'calls')).size).toBeGreaterThan(0)
    const bad = runCli(['--staple', '/tmp/K.dmg'], 'Invalid', env)
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr.toString()).toContain('not signed')
    expect(bad.stderr.toString()).not.toContain('SECRET-PW')
  })

  test('the record has one line per file', async () => {
    const text = await Bun.file(record).text()
    expect(text).toContain('K.zip: Accepted, submission sub-9')
    expect(text).toContain('K.dmg: NOT notarized, Apple answered Invalid for submission sub-9')
    expect(text).not.toContain('SECRET-PW')
  })
})
