import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the built app declares beside Tauri's defaults (`src-tauri/Info.plist`, merged by Tauri).
 *
 * Module frames are framed at `<label>.kehikot.localhost:<port>` over plain http. App Transport
 * Security refuses that name unless the app excepts it, and then every frame falls back to its
 * module's raw port. Measured in WKWebView inside an app bundle: without the exception the
 * host's address check answers "Load failed"; with it, 200.
 */
const plist = readFileSync(join(import.meta.dir, '../../src-tauri/Info.plist'), 'utf8')

test('the frame addresses under kehikot.localhost are excepted from App Transport Security, and only they', () => {
  const ats = plist.slice(plist.indexOf('<key>NSAppTransportSecurity</key>'))
  expect(ats).toContain('<key>NSExceptionDomains</key>')
  expect(ats).toMatch(/<key>kehikot\.localhost<\/key>\s*<dict>[\s\S]*<key>NSIncludesSubdomains<\/key>\s*<true\/>[\s\S]*<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/)
  expect(plist).not.toContain('NSAllowsArbitraryLoads')
})

test('it is a property list', () => {
  if (process.platform !== 'darwin') return
  expect(() => execFileSync('plutil', ['-lint', join(import.meta.dir, '../../src-tauri/Info.plist')])).not.toThrow()
})
