/**
 * Release order: a module may not be released (and a module PR is warned) while
 * its pinned `kehikot-module-protocol` is newer than the protocol of the newest
 * PUBLISHED Kehikot app release. A released app cannot install a module that
 * needs more than it speaks, so every app shows "needs a newer Kehikot" until an
 * app release catches up. The order is: protocol tag, host pinned to it, app
 * released, THEN modules.
 *
 *   bun protocol-order.ts --mode refuse   # module-release.yml: exit 1 on a pin ahead of the app
 *   bun protocol-order.ts --mode warn     # module-ci.yml: print a warning, never fail
 *
 * Run in the module's checkout (reads package.json, and node_modules when
 * installed). GH_TOKEN reads GitHub. The pure parts (`parsePin`, `decide`,
 * `readPin`, `appProtocol`) take what they read as arguments; protocol-order.test.ts
 * holds them. The app's protocol is read the way the daily protocol-ahead check
 * in the host reads a host: the newest published release's body says "Built from
 * Jalez/kehikko@<sha>", and that commit's package.json pins the protocol.
 * Whatever cannot be read (offline, rate limited past the retries, a pin that is
 * a path or a range) is a warning and a pass, with the reason.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compareVersions, hostShaFromBody, parseVersion, type Version, versionText } from './lib'

export const PROTOCOL_PACKAGE = 'kehikot-module-protocol'
export const PROTOCOL_REPO = 'Jalez/kehikko-protocol'
export const DESKTOP_REPO = 'Jalez/kehikko-desktop'
export const HOST_REPO = 'Jalez/kehikko'

export type Pin = { kind: 'version'; version: string; repo: string } | { kind: 'sha'; sha: string; repo: string } | { kind: 'unknown'; spec: string }

/** What a dependency spec pins: `…kehikko-protocol.git#v2.80.0`, `…#<sha>`, `^2.80.0` or `2.80.0`. */
export function parsePin(spec: unknown): Pin {
  if (typeof spec !== 'string') return { kind: 'unknown', spec: String(spec) }
  const repo = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#|$)/.exec(spec)?.[1] ?? PROTOCOL_REPO
  const ref = /#(.+)$/.exec(spec)?.[1]
  if (ref !== undefined) {
    if (/^v\d+\.\d+\.\d+$/.test(ref)) return { kind: 'version', version: ref.slice(1), repo }
    if (/^[0-9a-f]{7,40}$/.test(ref)) return { kind: 'sha', sha: ref, repo }
    return { kind: 'unknown', spec }
  }
  const plain = /^[\^~=v]*(\d+\.\d+\.\d+)$/.exec(spec.trim())
  return plain ? { kind: 'version', version: plain[1], repo } : { kind: 'unknown', spec }
}

/** The pin spec in a package.json text, or undefined. */
export function pinSpec(pkg: string | null): unknown {
  if (pkg === null) return undefined
  try {
    const read = JSON.parse(pkg) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    return read.dependencies?.[PROTOCOL_PACKAGE] ?? read.devDependencies?.[PROTOCOL_PACKAGE]
  } catch {
    return undefined
  }
}

/** Reads one GitHub API path (raw file when `raw`); throws on anything but success. */
export type Get = (path: string, raw?: boolean) => Promise<string>

export type Read = { ok: true; version: string } | { ok: false; why: string }

/** A pin as a version: by tag it is the tag; by commit it is the `version` of the protocol's package.json there. */
export async function resolvePin(pin: Pin, get: Get): Promise<Read> {
  if (pin.kind === 'version') return { ok: true, version: pin.version }
  if (pin.kind === 'unknown') return { ok: false, why: `the pin "${pin.spec}" is not a tag (#vX.Y.Z), a commit or a version` }
  try {
    const text = await get(`repos/${pin.repo}/contents/package.json?ref=${pin.sha}`, true)
    const version = (JSON.parse(text) as { version?: unknown }).version
    if (typeof version === 'string' && parseVersion(version)) return { ok: true, version }
    return { ok: false, why: `${pin.repo}@${pin.sha.slice(0, 7)} has no X.Y.Z version in its package.json` }
  } catch (error) {
    return { ok: false, why: `could not read ${pin.repo}@${pin.sha.slice(0, 7)}: ${(error as Error).message}` }
  }
}

/** The module's protocol: its package.json pin, else the installed package's version. */
export async function readPin(input: { pkg: string | null; installed: string | null; get: Get }): Promise<Read> {
  const spec = pinSpec(input.pkg)
  if (spec !== undefined) {
    const found = await resolvePin(parsePin(spec), input.get)
    if (found.ok) return found
    const installed = installedVersion(input.installed)
    return installed ? { ok: true, version: installed } : found
  }
  const installed = installedVersion(input.installed)
  return installed ? { ok: true, version: installed } : { ok: false, why: `package.json pins no ${PROTOCOL_PACKAGE}` }
}

function installedVersion(pkg: string | null): string | null {
  try {
    const version = (JSON.parse(pkg ?? '') as { version?: unknown }).version
    return typeof version === 'string' && parseVersion(version) ? version : null
  } catch {
    return null
  }
}

export interface App {
  /** The release's version, `0.3.0`. */
  release: string
  /** The protocol that app speaks. */
  protocol: string
}

export type AppRead = { ok: true; app: App } | { ok: false; why: string }

/** The newest published app release and the protocol the host commit it was built from pins. */
export async function appProtocol(get: Get, desktopRepo = DESKTOP_REPO, hostRepo = HOST_REPO): Promise<AppRead> {
  let release: { tag_name?: string; body?: string | null }
  try {
    release = JSON.parse(await get(`repos/${desktopRepo}/releases/latest`)) as typeof release
  } catch (error) {
    return { ok: false, why: `could not read the newest ${desktopRepo} release: ${(error as Error).message}` }
  }
  const version = parseVersion(release.tag_name ?? '')
  if (!version) return { ok: false, why: `the newest ${desktopRepo} release is tagged "${release.tag_name}", not vX.Y.Z` }
  const sha = hostShaFromBody(release.body, hostRepo)
  if (!sha) return { ok: false, why: `the ${release.tag_name} release does not say which ${hostRepo} commit it was built from` }
  let pkg: string
  try {
    pkg = await get(`repos/${hostRepo}/contents/package.json?ref=${sha}`, true)
  } catch (error) {
    return { ok: false, why: `could not read ${hostRepo}@${sha.slice(0, 7)}: ${(error as Error).message}` }
  }
  const found = await resolvePin(parsePin(pinSpec(pkg)), get)
  if (!found.ok) return { ok: false, why: `${hostRepo}@${sha.slice(0, 7)}: ${found.why}` }
  return { ok: true, app: { release: versionText(version), protocol: found.version } }
}

export type Decision = { action: 'pass' | 'warn' | 'refuse'; message: string }

/** Pin newer than the app → refuse; equal or older → pass; either unreadable → warn and pass. */
export function decide(module: Read, app: AppRead): Decision {
  if (!module.ok) return { action: 'warn', message: `Release order not checked: ${module.why}.` }
  if (!app.ok) return { action: 'warn', message: `Release order not checked: ${app.why}.` }
  const need = parseVersion(module.version) as Version
  const have = parseVersion(app.app.protocol) as Version
  if (compareVersions(need, have) > 0) {
    return {
      action: 'refuse',
      message: `This module needs protocol ${module.version}, but the newest Kehikot release (v${app.app.release}) has ${app.app.protocol}. Release the app first (host pinned to ${module.version}, app released), then re-run this workflow.`,
    }
  }
  return { action: 'pass', message: `Protocol ${module.version} is within what the newest Kehikot release (v${app.app.release}) speaks (${app.app.protocol}).` }
}

/** GitHub over fetch, retrying a rate limit (403/429 with a reset or retry-after, capped) and a server error. */
export function githubGet(token: string | undefined, options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; retries?: number; maxWaitMs?: number } = {}): Get {
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const retries = options.retries ?? 3
  const maxWait = options.maxWaitMs ?? 60_000
  return async (path, raw = false) => {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(`https://api.github.com/${path}`, {
        headers: { accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'user-agent': 'kehikot-release-order', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      })
      if (response.ok) return response.text()
      const limited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      if ((limited || response.status >= 500) && attempt < retries) {
        const after = Number(response.headers.get('retry-after'))
        const reset = Number(response.headers.get('x-ratelimit-reset'))
        const wanted = after > 0 ? after * 1000 : reset > 0 ? reset * 1000 - Date.now() : 2000 * 2 ** attempt
        await sleep(Math.min(Math.max(wanted, 1000), maxWait))
        continue
      }
      throw new Error(`GitHub answered ${response.status}${limited ? ' (rate limited)' : ''} for ${path}`)
    }
  }
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

if (import.meta.main) {
  const i = process.argv.indexOf('--mode')
  const mode = i >= 0 ? process.argv[i + 1] : 'refuse'
  const dir = process.cwd()
  const get = githubGet(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)
  const module = await readPin({ pkg: read(join(dir, 'package.json')), installed: read(join(dir, 'node_modules', PROTOCOL_PACKAGE, 'package.json')), get })
  // The app is only asked when there is a pin to compare it with.
  const app: AppRead = module.ok ? await appProtocol(get) : { ok: false, why: 'no module pin' }
  const decision = decide(module, app)
  if (decision.action === 'refuse') {
    console.log(`::${mode === 'warn' ? 'warning' : 'error'} file=package.json::${decision.message}`)
    process.exit(mode === 'warn' ? 0 : 1)
  }
  console.log(decision.action === 'warn' ? `::warning::${decision.message}` : decision.message)
}
