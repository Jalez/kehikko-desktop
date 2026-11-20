// Notarize one file with Apple, with every wait bounded. Used by release.yml for
// the disk image, and (through dev/release/bin/xcrun) for the app Tauri builds,
// so neither can hold a release for an hour while Apple says "In Progress".
//
// One attempt = upload (retried on an error or a stall) + polling `notarytool
// info` with backoff until the attempt's deadline, then once more at the
// deadline. Still "In Progress": a new submission, up to `attempts` in all, and
// the earlier ones keep being polled; whichever Apple accepts first wins.
// "Invalid" or "Rejected": stop at once with `notarytool log`. An answer that no
// retry can change (an agreement to accept, bad credentials, a revoked
// certificate: `classify`) stops at once too, naming what to do; only network
// trouble, 5xx and timeouts are retried. Credentials are
// passed to notarytool as given and never printed.
import { basename } from 'node:path'

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }
/** Runs `xcrun <args>`, killed after `timeoutMs`. */
export type Run = (args: string[], timeoutMs: number) => Promise<RunResult>
export interface Clock { now(): number; sleep(ms: number): Promise<void> }

const MIN = 60_000

export interface Options {
  file: string
  /** notarytool's credential arguments (--apple-id … --password … --team-id …). */
  auth: string[]
  /** Submissions in all (the first and the resubmissions). */
  attempts: number
  /** How long one submission is waited for before resubmitting. */
  attemptMs: number
  /** Upload tries per submission. */
  uploadTries: number
  /** An upload that takes longer is killed and retried. */
  uploadMs: number
  /** Pause between upload tries (the last value repeats). */
  uploadBackoffMs: number[]
  /** Timeout of `info`, `log` and `stapler`. */
  commandMs: number
  /** Pause between polls (the last value repeats). */
  pollMs: number[]
  log: (line: string) => void
}

export const DEFAULTS: Omit<Options, 'file' | 'auth' | 'log'> = {
  attempts: 3,
  attemptMs: 12 * MIN,
  uploadTries: 3,
  uploadMs: 5 * MIN,
  uploadBackoffMs: [15_000, 45_000],
  commandMs: 2 * MIN,
  pollMs: [15_000, 20_000, 30_000, 45_000, 60_000],
}

export interface Submission { id: string; status: string; attempt: number }

export type Outcome =
  | { ok: true; id: string; message: string; submissions: Submission[]; summary: string }
  | { ok: false; reason: 'invalid' | 'timeout' | 'upload'; submissions: Submission[]; summary: string; log?: string }
  | { ok: false; reason: 'refused'; refusal: Refusal; submissions: Submission[]; summary: string }

/** An answer from Apple that retrying cannot change, and what a person does about it. */
export interface Refusal { kind: 'agreement' | 'credentials' | 'certificate' | 'forbidden'; why: string; action: string }

export const AGREEMENT_ACTION = 'Apple needs the account holder to accept an updated agreement: sign in at https://developer.apple.com/account and accept it, then re-run release.yml on the tag.'

/**
 * Sorts a failed `notarytool` call: a Refusal when no retry can succeed until a
 * person acts, null when it may pass by itself (network, 5xx, timeout, anything
 * unrecognised). Unknown errors stay retryable so a new wording never fails a
 * release that would have gone through.
 */
export function classify(r: Pick<RunResult, 'stdout' | 'stderr' | 'timedOut'>): Refusal | null {
  if (r.timedOut) return null
  const text = `${r.stderr}\n${r.stdout}`
  if (/required agreement|agreement[^\n]*(missing|expired)/i.test(text)) {
    return { kind: 'agreement', why: 'a required agreement is missing or has expired (HTTP 403)', action: AGREEMENT_ACTION }
  }
  if (/revoked|certificate[^\n]*(expired|not valid)/i.test(text)) {
    return {
      kind: 'certificate', why: 'the signing certificate was revoked or has expired',
      action: 'Create a new Developer ID Application certificate at https://developer.apple.com/account, replace the signing secrets (dev/set-signing-secrets.sh), then re-run release.yml on the tag.',
    }
  }
  if (/status code: 401|invalid credentials|unable to authenticate|invalid (username|password|app-specific)|no team found|team id[^\n]*(invalid|not valid)/i.test(text)) {
    return {
      kind: 'credentials', why: 'Apple refused the notarization credentials (HTTP 401)',
      action: 'Check the APPLE_ID, APPLE_PASSWORD (an app-specific password) and APPLE_TEAM_ID secrets: make a new app-specific password at https://account.apple.com and store it, then re-run release.yml on the tag.',
    }
  }
  if (/status code: 403/i.test(text)) {
    return {
      kind: 'forbidden', why: 'Apple answered 403 Forbidden',
      action: 'Sign in at https://developer.apple.com/account and check that the membership is active and the account may notarize, then re-run release.yml on the tag.',
    }
  }
  return null
}

/** The one-line outcome of a refusal, for the record, the log and the issue. */
export function refusalSummary(name: string, f: Refusal): string {
  return `${name}: NOT notarized, Apple refused: ${f.why}. Not retried, because retrying cannot help. Action: ${f.action}`
}

const IN_PROGRESS = 'In Progress'
const FAILED = new Set(['Invalid', 'Rejected'])

function parse(stdout: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stdout.trim())
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

function minutes(ms: number): string {
  return `${Math.round(ms / 6_000) / 10} min`
}

function pick(list: number[], i: number): number {
  return list[Math.min(i, list.length - 1)] ?? 0
}

function firstLine(r: RunResult): string {
  if (r.timedOut) return 'timed out'
  const text = (r.stderr || r.stdout).trim().split('\n').find(l => l.trim()) ?? ''
  return `exit ${r.code}${text ? `: ${text.slice(0, 300)}` : ''}`
}

export function describe(subs: Submission[]): string {
  return subs.map(s => `${s.id} ${s.status} (submission ${s.attempt})`).join(', ')
}

async function upload(o: Options, run: Run, clock: Clock, attempt: number): Promise<string | Refusal | null> {
  for (let t = 1; t <= o.uploadTries; t++) {
    o.log(`Submission ${attempt}: uploading ${basename(o.file)} (try ${t} of ${o.uploadTries})`)
    const r = await run(['notarytool', 'submit', o.file, ...o.auth, '--output-format', 'json'], o.uploadMs)
    const id = r.code === 0 && !r.timedOut ? parse(r.stdout)?.id : undefined
    if (typeof id === 'string' && id) {
      o.log(`Submission ${attempt}: id ${id}`)
      return id
    }
    o.log(`Submission ${attempt}: upload failed (${r.code === 0 && !r.timedOut ? 'no submission id in the answer' : firstLine(r)})`)
    const refusal = r.code === 0 ? null : classify(r)
    if (refusal) return refusal
    if (t < o.uploadTries) await clock.sleep(pick(o.uploadBackoffMs, t - 1))
  }
  return null
}

async function info(o: Options, run: Run, id: string): Promise<{ status: string; message: string } | Refusal | null> {
  const r = await run(['notarytool', 'info', id, ...o.auth, '--output-format', 'json'], o.commandMs)
  const v = r.code === 0 && !r.timedOut ? parse(r.stdout) : null
  if (!v || typeof v.status !== 'string') {
    const refusal = r.code === 0 ? null : classify(r)
    if (refusal) return refusal
    o.log(`Could not read the status of ${id} (${firstLine(r)}); asking again`)
    return null
  }
  return { status: v.status, message: typeof v.message === 'string' ? v.message : '' }
}

async function notaryLog(o: Options, run: Run, id: string): Promise<string> {
  const r = await run(['notarytool', 'log', id, ...o.auth], o.commandMs)
  return r.code === 0 && !r.timedOut ? r.stdout : `(could not read the log: ${firstLine(r)})`
}

function refused(name: string, refusal: Refusal, subs: Submission[], o: Options): Outcome {
  const summary = refusalSummary(name, refusal)
  o.log(summary)
  return { ok: false, reason: 'refused', refusal, submissions: subs, summary }
}

export async function notarize(o: Options, run: Run, clock: Clock): Promise<Outcome> {
  const name = basename(o.file)
  const subs: Submission[] = []
  const started = clock.now()

  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    const id = await upload(o, run, clock, attempt)
    if (id && typeof id !== 'string') return refused(name, id, subs, o)
    if (id) subs.push({ id, status: IN_PROGRESS, attempt })
    const pending = () => subs.filter(s => s.status !== 'Accepted' && !FAILED.has(s.status))
    if (pending().length === 0) continue

    const deadline = clock.now() + o.attemptMs
    for (let poll = 0; ; poll++) {
      for (const s of pending()) {
        const got = await info(o, run, s.id)
        if (!got) continue
        if ('action' in got) return refused(name, got, subs, o)
        if (got.status !== s.status) o.log(`${s.id}: ${got.status}`)
        s.status = got.status
        if (got.status === 'Accepted') {
          const summary = `${name}: Accepted, submission ${s.id} (submission ${s.attempt} of ${attempt} sent), after ${minutes(clock.now() - started)}`
          o.log(summary)
          return { ok: true, id: s.id, message: got.message || 'Processing complete', submissions: subs, summary }
        }
        if (FAILED.has(got.status)) {
          const log = await notaryLog(o, run, s.id)
          const summary = `${name}: NOT notarized, Apple answered ${got.status} for submission ${s.id}. Submissions: ${describe(subs)}`
          o.log(summary)
          return { ok: false, reason: 'invalid', submissions: subs, summary, log }
        }
      }
      const left = deadline - clock.now()
      if (left <= 0) break
      await clock.sleep(Math.min(pick(o.pollMs, poll), left))
    }
    o.log(`Still ${IN_PROGRESS} after ${minutes(o.attemptMs)}: ${describe(pending())}${attempt < o.attempts ? '; submitting again' : ''}`)
  }

  const reason = subs.length === 0 ? 'upload' : 'timeout'
  const summary = reason === 'upload'
    ? `${name}: NOT notarized, every upload to Apple failed (${o.attempts} submissions, ${o.uploadTries} tries each)`
    : `${name}: NOT notarized, Apple had not finished after ${o.attempts} submissions and ${minutes(clock.now() - started)}. Submissions: ${describe(subs)}`
  o.log(summary)
  return { ok: false, reason, submissions: subs, summary }
}

/** `stapler staple`, retried: right after "Accepted" the ticket can take a moment to be served. */
export async function staple(o: Pick<Options, 'file' | 'commandMs' | 'log'>, run: Run, clock: Clock, tries = 3, pauseMs = 20_000): Promise<boolean> {
  for (let t = 1; t <= tries; t++) {
    const r = await run(['stapler', 'staple', o.file], o.commandMs)
    if (r.code === 0 && !r.timedOut) return true
    o.log(`Stapling ${basename(o.file)} failed (${firstLine(r)}), try ${t} of ${tries}`)
    if (t < tries) await clock.sleep(pauseMs)
  }
  return false
}

/** Splits what Tauri passes after `notarytool submit` into the file and the credentials. */
export function tauriArgs(args: string[]): { file: string; auth: string[] } | null {
  const [file, ...rest] = args
  if (!file || file.startsWith('-')) return null
  const auth: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--wait') continue
    if (a === '--output-format' || a === '-f') { i++; continue }
    if (a === '--timeout') { i++; continue }
    auth.push(a)
  }
  return { file, auth }
}

export function envAuth(env: Record<string, string | undefined>): string[] | null {
  const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = env
  if (!APPLE_ID || !APPLE_PASSWORD || !APPLE_TEAM_ID) return null
  return ['--apple-id', APPLE_ID, '--password', APPLE_PASSWORD, '--team-id', APPLE_TEAM_ID]
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

/** The real xcrun, by its full path, so the shim in dev/release/bin is never re-entered
 * (NOTARIZE_XCRUN replaces it in the tests). */
export const realRun: Run = async (args, timeoutMs) => {
  const proc = Bun.spawn([process.env.NOTARIZE_XCRUN || '/usr/bin/xcrun', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}
