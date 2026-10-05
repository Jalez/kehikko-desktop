# kehikko-desktop

**A window on [Kehikot](https://github.com/Jalez/kehikko), and the thing that owns
the host's lifetime.**

Kehikot is a workbench: a host serving a page on `127.0.0.1:4181` which frames
thirteen independent module servers, each on its own port, in iframes. You have
been running it in a browser tab. This makes it an app window instead.

**The architecture does not change.** Modules stay HTTP servers on their own
origins, framed in iframes, talking `postMessage` to the page that framed them.
Tauri's IPC is not involved and no module ever sees it — from a module's point
of view this window is a browser, and it is: the window loads
`http://127.0.0.1:4181` as an external URL rather than bundling a copy of the
host's page.

What it adds is the thing a tab cannot do.

## Why this exists: eight orphans

Eight module servers were found holding ports on this machine with nothing left
that had started them. Not a crash — an ordinary afternoon of closing a browser
tab. The tab looked like "the app", and closing it stops nothing, because the
servers were never the tab's to own.

A window that owns a process is the whole difference between a workbench you
close and a workbench you close *and* then run `lsof -i` after.

So this shell starts `./run.sh` in the host's directory on launch and stops it on
quit — and it stops the whole **process group**, not the child it holds. That
distinction is the entire fix. `run.sh` ends in `exec bunx vite`: `exec` replaces
the shell's image, so the trap the script installed to kill its API child is gone
the moment Vite starts, and `bun run server/server.ts` is left a child of a
process that no longer knows it exists. Kill the pid and Vite dies while bun
keeps 4180 and every module the host started keeps its port. Signal the group and
nothing is left.

## Running it

```bash
git clone https://github.com/Jalez/kehikko-desktop
cd kehikko-desktop && npm install     # the Tauri CLI, and nothing else
npm run dev                           # or: npm run build, for a .app
npm run install-app                   # build with the host bundled, install to /Applications
```

`npm run build` expects a host binary in `src-tauri/binaries/` (see
[Releases and updates](#releases-and-updates)); `install-app` builds one from
`$KEHIKKO_HOST_DIR` or `~/Projects/kehikko` first, and installs an app without one
— running that checkout instead — when the checkout cannot build it yet.

The **npm CLI** (`@tauri-apps/cli`) rather than `cargo install tauri-cli`: it
ships a prebuilt binary, so it is a ten-second install instead of a five-minute
one, and it pins with the lockfile. Rust 1.96 builds the app itself. The first
Rust build takes a few minutes and compiles about 230 crates; that is expected.

Tauri **v2**. v1 guidance will mislead you — the security model is different, and
in particular capabilities did not exist there.

### Which host it runs

Two kinds, decided at launch:

- **A checkout you named** — dev mode, exactly as before: `./run.sh` in that
  directory, API on `apiPort` (default 4180), page on API + 1. Named by, in order:
  1. `$KEHIKKO_HOST_DIR`
  2. `~/.config/kehikko-desktop/config.json` — `{"hostDir": "…", "apiPort": 4180}`
- **The host the app carries** — otherwise, in any build that has one (every
  release, and `dev/install.sh` when the checkout can build it). A single binary
  in `Kehikot.app/Contents/MacOS/kehikko-host`, serving the page *and* `/host/*`
  on one port: **4170**, or `$KEHIKKO_PORT`, or `{"port": …}` in the config file.
  The window waits for `GET /host/health` before it goes there. Deliberately not
  4180/4181, so a checkout you also run in a terminal is never adopted by
  accident.
- `~/Projects/kehikko` — the old **guess**, and only in a build with no bundled
  host (`npm run dev`, `cargo run`). The error page says when it was a guess.

Naming a checkout always wins: a developer's setup does not change because the
app learned to carry a host.

A path that is wrong is a shell that starts nothing and says why: the window
opens immediately on a local waiting-room page, and that page is where the
refusal is written — which directory it looked in, which source named it, and
what to put in the config file. The distinction between "no such directory", "no
`run.sh` in it" and "`run.sh` is not executable" is kept, because those three
send you to different fixes.

Either way `PATH` is widened with the usual per-user toolchain homes before the
host starts: the bundled host needs no toolchain itself, but the modules it
starts are still checkouts run with bun and git.

### If a host is already running

It is adopted. The shell does not start a second one — and, the half that
matters, does not stop it on quit either. **We only ever kill what we started.**
The alternative is this window closing and taking down the host somebody else's
terminal is holding.

---

## The two configuration items, and why each exists

Both of these look like something a tidy-minded person would delete. Neither is
decoration.

### 1. `KEHIKOT_ORIGIN`, set on the host process this shell spawns

It is set under its old name, `ROADMAP_ORIGIN`, as well, because modules not
yet updated still read that one. Every module composes its own frame policy
from it:

```js
frame-ancestors 'self' ${process.env.KEHIKOT_ORIGIN ?? 'http://127.0.0.1:4181 http://localhost:4181'}
```

Note the `??`. Setting this variable **replaces** the default rather than adding
to it, so a shell that set only its own origin would silently break the browser
tab — every container blank, for whoever opens <http://127.0.0.1:4181> next. So
the shell sets all four:

```
tauri://localhost http://tauri.localhost http://127.0.0.1:4181 http://localhost:4181
```

(For the bundled host the port is its single port, 4170 by default: the page is
served from the same origin as `/host/*`.)

`tauri://localhost` is the window's origin on macOS and Linux;
`http://tauri.localhost` is Windows'.

**The honest part:** as this shell is currently built, the `tauri://` entries are
not what makes it work. The window loads the host's own http page, so the page
framing the modules has origin `http://127.0.0.1:4181` — which the modules'
default already allows. The variable is set because it will be needed the moment
any window frames a module from the app's own protocol, and a variable that is
right in both cases is cheaper than one that is right today.

**Modules the host itself spawns inherit this. Modules you start by hand do
not.** A module you started in your own terminal before opening this window has
whatever `KEHIKOT_ORIGIN` / `ROADMAP_ORIGIN` that terminal had — usually none, so the default. That
is fine today and would not be if this shell ever moved to `tauri://`. The
failure to watch for is the ugliest one in this system: **a blank container, with
the reason only in a console you are not looking at.** If a container is blank,
open the module's own URL directly and read its `content-security-policy` header.

### 2. `app.security.csp`, with `frame-src` covering `http://127.0.0.1:*`

```json
"csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://127.0.0.1:* http://localhost:*; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*"
```

This is Tauri's own CSP, applied to pages Tauri serves — which here is one page,
the waiting room. Without `frame-src` for loopback, any page served from the app
protocol that framed a module would show a blank container with the reason
invisible.

**Also honest:** the host's page is not served by Tauri, so this CSP does not
govern it. What governs the framed modules on the host's page is the host's own
response headers (it sends none) and each module's `frame-ancestors`. The policy
is kept, tight, and written down here because the day somebody bundles a page
into this shell is the day its absence costs an afternoon.

---

## The unified title bar

The window is built with `TitleBarStyle::Overlay` and a hidden title, so the page
runs to the top of the window and the three traffic lights float over the host's
own 32-pixel header. One strip instead of two, and the one that survives is the
one carrying information.

That is one config line. The rest is the consequence, and it lives in
`src-tauri/src/titlebar.rs`:

- **The inset.** The lights land exactly on the host's project control, so the
  header is pushed right by **82px**: the lights are 12pt circles at 20pt spacing
  starting 20pt in, so the last ends at 72, plus a gap. `env(titlebar-area-*)`
  would be the principled source and WKWebView does not implement it — with a
  trap in the measurement, because `CSS.supports('left', 'env(titlebar-area-x)')`
  answers **true** (an `env()` with a fallback is valid syntax either way).
  Resolving it is what tells you: the fallback comes back, the width and height
  are `0px`, and `navigator.windowControlsOverlay` is undefined.
- **Dragging.** With no title bar, the window moves only where the page says
  `data-tauri-drag-region`. The header gets it, and so does every child that is
  empty space; buttons deliberately do not, or every press would move the window.
- **Fullscreen.** macOS takes the lights away, so the inset has to go with them
  or there is a permanent 82-pixel hole. There is no media query for this here
  (`display-mode: fullscreen` is a PWA feature and answers `browser`), so Rust
  pushes the fact on every resize **and on every page load** — the flag lives on
  the document, and before the page-load hook existed the second load in
  fullscreen measured the inset back at 82px.

### This is an injection, and that is a real cost

The shell injects a stylesheet and a script into the host's page before it loads.
It finds the header by structure — the first `<header>` that is not inside
`<main>`, because container headers are `<header>` too — and **if the host's
markup changes, the match stops matching and the lights land back on top of the
project control.** The injection makes that loud rather than silent: it appends a
marker to the (hidden) window title, which the shell reads and prints a line
about to the terminal. Loud is not the same as fixed.

**The durable version is a host change, and it is small.** Precisely:

- The host detects it is inside this shell. The reliable test in the page is
  `typeof window.__TAURI_INTERNALS__ !== 'undefined'` — measured present on the
  host's page in this shell, and measured *absent* in module iframes. A cheaper
  and more explicit alternative is for this shell to set a query parameter or a
  `localStorage` key the host reads; either is fine, but the host should key off
  something it names rather than off a user-agent string, which on WKWebView is
  the same as Safari's.
- On that condition it adds a class — say `in-desktop-shell` — to the element it
  already renders as `<header className="bg-background flex h-8 …">` in
  `src/canvas/Bar.tsx`, plus `data-tauri-drag-region` on that header and on the
  `<span className="flex-1" />` spacer beside it.
- Its own stylesheet then owns the number: `.in-desktop-shell { padding-left:
  82px }`, dropped to `0` when the shell says it is fullscreen (this shell
  already sets `data-kehikko-fullscreen` on `<html>`; the host can read that
  attribute and nothing else needs to be invented).

Once that exists, delete the injection from this repo. It is here because that
repository was not this task's to edit.

---

## Dark from the first frame, which means the native side has to know

Somebody who runs Kehikot dark and quits it used to be shown two white frames on
the way back in. They are two different bugs that look like one flash:

1. **The window.** An `NSWindow` built with no `background_color` is white, and
   it is on screen before a byte of HTML has been parsed. Nothing in a page can
   reach that frame.
2. **The waiting room.** `dist/index.html` painted itself with the system
   colours — `color-scheme: light dark; background: Canvas` — which follows the
   **operating system's** appearance. A person's choice about this workbench is
   not a fact about their Mac, so a dark-mode Kehikot user on a light-mode
   machine got a white screen, correctly implemented and entirely wrong.

The host's page has neither problem: it decides the theme from a
`kehikko.theme` cookie in a blocking script before its body exists and states
its two background colours inline, and its comments are the long version. **But
that cookie is on `http://127.0.0.1:4181` and the waiting room is served at
`tauri://localhost`.** Different origin, nothing to read. So the shell has to be
told.

### Which copy is the truth

**The host's cookie. Always.** `~/.config/kehikko-desktop/theme` — one word,
beside the config file, never inside it, because `config.json` is hand-written
and holds what a person was asked for rather than what was observed — is an
*echo*: "what the host's page last said it was showing". The shell never
computes a theme, never consults the system appearance and never writes the
cookie.

So a disagreement costs exactly one wrong frame in the waiting room and repairs
itself: the host's page reports what it decided as soon as it loads (`announce()`
in the host's `src/host/theme.ts`, called from `main.tsx`), so it survives one
launch and not two. That is a stale cache, not a second decision — the thing
`src/host/theme.ts` argues hardest against, and still only one decision exists.

**On a first run, with nothing stored, it is dark** — because the host defaults
to dark and defends that at length. Following the OS here would not fix the
flash, it would move it: white for a beat, then black when the host's page
arrived. Two defaults that disagree are a flash by construction.

### There is now one command, and there were none

`remember_theme`, and adding it was new ground: this program had no
`invoke_handler` at all. The direction is the reason. `say()` talks to the page
with `eval` and needs no bridge; a fact that only the page knows and only Rust
can act on early enough has to go the other way. Reading the cookie from Rust
would mean a second implementation of the host's decision, and reusing the
window title as a channel — which the title-bar injection does — works for a
one-shot diagnostic and would need polling for a preference.

It is narrow by construction. The host's page is a **remote** origin to Tauri,
and remote content cannot reach an application command unless a capability names
it; `capabilities/theme.json` grants this one command to window `main` at the
host's loopback origins — `127.0.0.1`/`localhost` on 4181 (a checkout's page)
and on 4170 (the bundled host's one port); a host moved to another port keeps
working but does not remember its theme across launches — and `permissions/theme.toml` is what makes it
nameable at all. A module cannot call it — initialization scripts do not reach
subframes, so a module has no `__TAURI_INTERNALS__`, and the capability would
refuse the origin anyway. **Note the port is hard-coded there, as it is in
`titlebar.json`:** a host on a non-default port simply never gets through, and
the shell keeps the last word it had.

In the host repo it degrades silently in a browser — `__TAURI_INTERNALS__` is
undefined, `tell()` returns, nothing is logged. That page runs in a plain tab far
more often than in this window.

### And then the updater's three

`update_status`, `check_for_update` and `apply_update` (`src/update.rs`), so the
host's Updates menu can show the app as one more row beside its modules and
restart into a downloaded release. Same pattern: `permissions/update.toml`,
`capabilities/update.json`, window `main`, 4170 and 4181. Unlike the theme, a
host on a **configured** port is granted them too, at runtime, for exactly that
port (`grant_update_commands_to` in `lib.rs`) — an Updates menu whose "restart"
is refused would be worse than none. The contract is in
[How updates work](#how-updates-work).

### What `background_color` does on macOS, and what it does not

Do not assume it covers everything. It reaches two layers and misses a third:

- the `NSWindow`'s background colour — the frame before any page exists;
- `underPageBackgroundColor` on the `WKWebView`, which is what WebKit shows
  around and behind a page that has not painted;
- **not** the webview's own opaque backdrop. wry only turns that off through a
  private `drawsBackground` key, compiled in behind Tauri's `macos-private-api`
  feature, which is not enabled here and is not worth enabling for this.

That third one is why the waiting room also states its two colours inline and
gets the word through an initialization script — the same belt the host's
`index.html` wears, for the same reason: a class selects nothing until a
stylesheet says what it means.

Measured, on a Mac in **light** system appearance, with the window built by
`cargo build` and launched directly:

| stored | what the waiting room shows |
|---|---|
| nothing (first run) | black — the host's default, not the machine's |
| `light` | white |
| `dark` | black |

And the round trip: with the file deleted, launching against the real host and
letting its page load recreated `~/.config/kehikko-desktop/theme` containing
`dark`, which is `announce()` arriving through the capability. The ACL is the
part most likely to be silently wrong, so it is the part worth having measured.

It does **not** fight `TitleBarStyle::Overlay`. They are independent settings in
tao: the title-bar style sets `titlebarAppearsTransparent` and
`FullSizeContentView`, the colour calls `setBackgroundColor:` on the window, and
the traffic lights are drawn by the system above both. The window is opaque
either way — nothing here sets `transparent`, so nothing goes near
`clearColor`, which is where that combination actually causes trouble.

---

## What survives on WKWebView, and what does not

Tauri uses the system webview: **WKWebView on macOS, not Chromium.** Everything
this workspace has measured before was measured in Chromium, so this is the part
worth reading.

All of it was measured on a real canvas against the live host and live modules,
not a fixture. `src-tauri/examples/webkit-probe.rs` is the instrument — a
throwaway second window that visits a page, runs a script in it, and posts what
it found to a listener on 4999. It starts nothing and stops nothing.

| | |
|---|---|
| **`@container` queries** | **Works.** Anonymous and named (`container: name / inline-size`, `@container name (min-width: 34rem)`) both apply *and re-evaluate* when the container is resized. `10cqi` units supported. Verified on the live canvas: Paper, Notes, Checklist and Notifications lay out correctly in containers narrower than the viewport. |
| **Paper's A4 page** | **Works.** The 794×1123 box measures exactly that, and under `transform: scale(0.5)` its rendered rect is 397×562 — exact, no rounding drift. A 51-page thesis rendered correctly in a container about 640px wide. |
| **`ResizeObserver`** | **Works.** Present, and observed firing. |
| **The module handshake** | **Works.** This is the one to be happiest about — the framed module *says so itself*: Journeys renders "Framed by a host", which it only prints having completed the `postMessage` greeting. Five modules were framed at once on the "writing" canvas and all five answered. |
| **The focus-mode reveal** | **Works.** `elementFromPoint` finds the 8px opt-in strip through a `pointer-events: none` ancestor, which is the mechanism the reveal is built on. |
| **`:has()`, `OffscreenCanvas`, canvas 2D, WebGL 1 and 2, WebSocket** | **All present.** One caveat with teeth: WebGL reports **unavailable on a canvas that is not in the document**. Attach it and both contexts are there. A feature test on a detached canvas would have been recorded here as "WebGL is broken". |
| **macOS local-network permission** | **No prompt, and nothing refused.** Loopback is exempt from the local-network permission — that covers LAN, not `127.0.0.1`. The window loaded `http://127.0.0.1:4181` and a cross-origin `XMLHttpRequest` to another loopback port succeeded, first run, with no dialog. |
| **`requestAnimationFrame`** | **Worked, with a caveat, until the shell took the caveat away — see the section below.** An earlier version of this table said "when the window is occluded or in the background", and *occluded* was the wrong word and the expensive one. **Losing frontmost is enough.** The window does not need to be covered, minimised, moved off screen or obscured by so much as a pixel: click on Finder while the whole window is in plain sight, and `document.visibilityState` goes `hidden` and rAF **stops firing entirely** — not throttled, stopped, zero frames per second for as long as you look elsewhere. A `setInterval` beside it keeps ticking, so the page is still running; only the rendering update is suspended. `src/rendering.rs` now turns this off for the shell's window. It is still true of any WKWebView that does not, so: anything that must complete while the app is not frontmost should use a timer, never a rAF. It cost an hour of the original build — a probe that awaited two rAFs simply never finished — and a day of the one after it. |
| **xterm.js with a live pty** | **Not verified.** Its substrate is fine — `.xterm`, `.xterm-screen`, `.xterm-rows` and `.xterm-viewport` all construct, and canvas, WebGL and WebSocket are all present — but no shell could be started to draw into it. The Terminal module reports "a shell could not be started on this machine", which is its `node-pty` import failing in the module's own server process, with no webview involved. That is a condition on this machine today, not a WebKit finding, and it will reproduce in Chromium. Verifying it framed would have meant unfolding a container on a canvas this task was not allowed to change. |

Nothing in that table needs a module change. One thing in it needed a shell
change, and got one.

### The frozen window, and the private call that unfreezes it

The reported sentence was: *"only by switching to another app it shows what has
been written."* Typing into the terminal produced nothing on screen until the
window lost focus and got it back, and then the whole backlog landed at once.

It is the rAF row above, and it is not the terminal's bug. xterm draws every row
inside an animation frame, funnelled through one `RenderDebouncer` that all
three of its renderers — DOM, canvas and WebGL — sit behind, so the frame that
never arrives is the whole of the rendering. The pty keeps producing, the socket
keeps delivering and `terminal.write()` keeps parsing into the buffer; none of
that is rAF-driven, which is exactly why the backlog is intact when the window
comes back. **It affects every module.** The terminal is only the one that
changes while you are not looking at it.

`src/rendering.rs` sends `-[WKWebView _setWindowOcclusionDetectionEnabled:NO]`
to the window's webview at startup. Measured with the probe, driving
`kehikko-terminal/dev/frozen-while-backgrounded.js`, one line per second,
clicking on Finder in the middle of each run:

```
--freeze-when-backgrounded (the behaviour before this fix)
  {"s":4, "raf":60,"vis":"visible"}
  {"s":5, "raf":4, "vis":"hidden"}     <- Finder frontmost
  {"s":6, "raf":0, "vis":"hidden"}
  {"s":9, "raf":0, "vis":"hidden"}
  {"s":11,"raf":61,"vis":"visible"}    <- window frontmost again

with the SPI applied (what the shell now does)
  {"s":1..30, "raf":60, "vis":"visible"}   every second, no exceptions
```

Thirty seconds, two switches to Finder and back, and the page never once went
`hidden`. Same binary, same script, same automated app switch — the only
difference is the one call.

**It is private API, and that is a distribution decision, not a detail.** The
leading underscore says so. There is no public equivalent; it was looked for.
That is fine for an app somebody builds and installs on their own machine, and
it is a rejection in the Mac App Store, where the check is automated and the
selector is a plain string in the binary. Submitting this means deleting that
call and getting the freeze back. Notarisation for direct distribution does not
care. The call is guarded with `respondsToSelector:`, so a future macOS that
drops the SPI gets a log line and the old behaviour rather than a crash on
launch.

### Two things that are true of the shell, not of WebKit

- **Tauri's initialization scripts do not reach subframes.** Measured directly: a
  same-origin iframe of the host, opened inside the host's page, has neither the
  injected stylesheet nor `__TAURI_INTERNALS__` in it. So a module cannot see the
  title-bar injection and **cannot call a window command** — the capability below
  reaches the host's page and nothing else.
- **The capabilities are three commands wide**, in two files, and the second one
  is described under "Dark from the first frame" above.
  `src-tauri/capabilities/titlebar.json`
  grants `core:window:allow-start-dragging` and
  `core:window:allow-toggle-maximize` to window `main` at the host's origin, and
  nothing else. Both were called for real and both returned; `toggle_maximize`
  took the window from 1440 to 1512 wide, which is what a double-click on the
  drag region does. Scoped to a window and an origin: the same calls from a
  window named anything else are refused, with the refusal naming the capability.

---

## Releases and updates

The app is distributed as a macOS release on
[GitHub Releases](https://github.com/Jalez/kehikko-desktop/releases), for Apple
Silicon (`aarch64`) and Intel (`x64`). A release carries the host; modules still
run from their own checkouts.

### Installing (unsigned, for now)

The app is not signed by Apple yet — it is only *ad-hoc* signed — so the first
open needs one extra step:

1. Download the `.dmg` for your Mac and drag **Kehikot** to Applications.
2. **Right-click → Open** in Finder, and confirm. (Double-clicking says it
   cannot be checked for malicious software and offers no Open button.) If macOS
   says the app is *damaged*, it means the quarantine flag, not the file:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Kehikot.app
   ```

After that it opens normally, and updates do not ask again.

### How updates work

A release build running the host it carries checks
`https://github.com/Jalez/kehikko-desktop/releases/latest/download/latest.json`
in the background (`src-tauri/src/update.rs`) about five seconds after launch,
every four hours after that, and shortly after the Mac wakes from sleep. A newer
version is **downloaded at once, without asking**, and kept in memory once its
signature checks out. Only one check or download runs at a time; a still newer
release found while one is waiting replaces it once it, too, is downloaded and
verified. A failed check (offline, GitHub down) is a line on stderr and a
`failed` state: it never holds up the window.

The shell draws no update UI of its own. **The host's page is the one place a
person sees updates** — an indicator in its header and a "Kehikot app" row in its
Updates menu, beside the modules — built against this contract:

- **Status**, one shape everywhere:
  `{ enabled, current, state, version, progress, error, checkedAt }` —
  `state` is `idle` (not checked yet) | `checking` | `downloading` | `ready` |
  `installing` | `failed` | `uptodate`; `version` is the update's, when there is
  one; `progress` is 0–1 while downloading, `null` while the size is unknown;
  `error` is the last failure until a check succeeds; `checkedAt` is Unix ms;
  `enabled: false` means this build never checks (debug, or a checkout).
- **Commands** (no arguments, via `window.__TAURI_INTERNALS__.invoke`):
  `update_status` → status; `check_for_update` → starts a check unless one is
  running, returns the status right after; `apply_update` → installs the `ready`
  update and relaunches, stopping the host and its modules first (does nothing
  in any other state).
- **Push**: on every change the shell evaluates
  `window.kehikotAppUpdate?.(status)` — a function the host's page defines, the
  same `eval` channel the waiting room's `kehikkoStatus` uses. Called again after
  every page load; while downloading, once per whole percent. A page should still
  ask `update_status` once on mount.

If an update is never applied, **it is installed when the app quits**
(`Update::install` replaces the bundle on disk and does not relaunch on macOS),
so the next launch is the new version. If the bundle's folder is not writable
the updater asks for an administrator password at that point.

A host page that predates this contract never asks `update_status`, so when an
update becomes ready and the page has not once asked, the shell asks itself with
a native alert — **Restart Now** or **Later** — carrying Kehikot's icon. That
alert is an `NSAlert` built in `update.rs` with the icon set explicitly; the
dialog plugin it replaces could fall back to a system-drawn alert with a generic
icon.

**Trying it without a release.** In a debug build, `KEHIKOT_UPDATE_DEMO=1`
drives the same state machine with fake progress and no network — the commands
answer and `kehikotAppUpdate` is called exactly as in a real update — and puts a
small yellow test panel on the host's page that plays the host's half (debug
only, never shipped). `=fail` fails the first download at 60%; `=dialog` shows
the native alert at `ready`. For a real end-to-end run, build the newer version
signed (`TAURI_SIGNING_PRIVATE_KEY`, `--config '{"version":"0.1.2"}'`), serve its
`.app.tar.gz` and a `latest.json` on loopback, and build the older one with
`--config '{"plugins":{"updater":{"endpoints":["http://127.0.0.1:PORT/latest.json"],"dangerousInsecureTransportProtocol":true}}}'`.
Run it from a path with no symlink in it (`/private/tmp`, not `/tmp`: the
updater refuses a symlinked executable path) and on a spare `KEHIKKO_PORT`.

Every update archive is verified against the minisign public key in
`tauri.conf.json` (`plugins.updater.pubkey`) before it is installed. That is
independent of Apple signing and holds without it.

Not checked: debug builds, and an app running a host from a named checkout —
whoever runs one builds this app from source too.

### Cutting a release

1. Bump the version in **all three**: `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `package.json` (the release reads
   `tauri.conf.json`; the workflow fails if the tag disagrees).
2. To pin the host, put a kehikko tag or SHA in `host.ref` (now: `main`).
3. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`.

`.github/workflows/release.yml` (also runnable by hand, *workflow_dispatch*)
creates a draft release, builds both architectures on macOS runners — checking
out `Jalez/kehikko` at `host.ref`, compiling the host with
`bun run build:sidecar --target bun-darwin-{arm64,x64}` into
`src-tauri/binaries/kehikko-host-<target-triple>` — signs the updater archives,
uploads the `.dmg`, the `.app.tar.gz` + `.sig` and a `latest.json` covering both,
and publishes the release once both are in.

Repository secrets it needs:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of the updater private key (`~/.tauri/kehikot-updater.key` on the maintainer's machine) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password — empty for the current key, so this one may be left unset |

Losing that key means installed copies can never be updated again (they only
accept archives signed by it); keep a backup.

The bundled host is wired in through `src-tauri/tauri.bundled.conf.json`
(`bundle.externalBin`), merged with `--config`, rather than in `tauri.conf.json`:
Tauri refuses to build at all when an `externalBin` file is missing, and that
would make `cargo check` and `npm run dev` require a host binary. `npm run build`
and the workflow pass it; `dev/install.sh` passes it when it could build one.

### Adding Apple signing and notarization later

Everything except the secrets is already in place: `bundle.macOS` has
`entitlements: "Entitlements.plist"` (the JIT entitlements a compiled bun
binary needs under the hardened runtime that notarization requires — the
bundler already applies the hardened runtime and these entitlements to the
sidecar today, measured on an ad-hoc build), and the workflow has the
environment variables written out, commented.

1. In an Apple Developer account, create a **Developer ID Application**
   certificate; export it with its key from Keychain as a `.p12` with a password.
2. Add repository secrets:

   | Secret | Value |
   | --- | --- |
   | `APPLE_CERTIFICATE` | `base64 -i cert.p12` |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
   | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Jaakko Rajala (TEAMID)` |
   | `APPLE_ID` | the Apple ID email |
   | `APPLE_PASSWORD` | an [app-specific password](https://support.apple.com/102654) for it |
   | `APPLE_TEAM_ID` | the 10-character team id |

3. Uncomment those six lines in the `tauri-action` step's `env` in
   `release.yml`.
4. In `src-tauri/tauri.conf.json`, remove `"signingIdentity": "-"` from
   `bundle.macOS` (the identity then comes from `APPLE_SIGNING_IDENTITY`; leaving
   `-` would keep ad-hoc signing).
5. Drop the "right-click → Open" paragraph above.

Tauri imports the certificate into a temporary keychain, signs the app and the
sidecar with it, and notarizes and staples when `APPLE_ID`/`APPLE_PASSWORD`/
`APPLE_TEAM_ID` are present. The updater key stays as it is; existing installs
keep updating across the switch.

## What this shell deliberately does not do

It starts a process, opens a window, and stops the process. It has no folder
picker, no registry, no settings screen and no opinion about a canvas — the host
has all of those, on the page this window shows, and every line that reimplements
one is a second copy to keep in agreement with the first.

**A native folder picker is the obvious next thing and is not here.** It would
need the host to accept a folder from somewhere other than its own browser
dialog, which is a host change this task could not make. It belongs in a report,
which is where it is.

## Layout

```
src-tauri/src/lib.rs        the window, the waiting room, and the reaping
src-tauri/src/host.rs       where the host is, whether it is up, how to stop it
src-tauri/src/titlebar.rs   the injection, and the argument against it
src-tauri/src/rendering.rs  one private WebKit call, so the page keeps painting
src-tauri/src/theme.rs      the remembered theme, and why the copy is not the truth
src-tauri/src/update.rs     the updater engine: check, download, install; the host draws the UI
src-tauri/tauri.bundled.conf.json  the bundled host (externalBin), merged at build
src-tauri/Entitlements.plist       JIT entitlements for the bundled host
src-tauri/binaries/         the host binary, built per target (gitignored)
host.ref                    which kehikko ref a release bundles
.github/workflows/release.yml  the release: both arches, signed updates
src-tauri/capabilities/     the commands the host's page may call, scoped to one window and its origins
src-tauri/permissions/      what makes this app's own commands nameable at all
src-tauri/examples/         the WebKit probe that produced the table above
dist/index.html             the only page this shell serves: a waiting room
```

## Should this replace the browser?

**Beside it, for now.** It is strictly better at the one thing it was built for —
nothing is orphaned, and the unified title bar makes the workbench read as an
application rather than as a page — and nothing was found that it is worse at.
But the browser tab is still where devtools are, and every measurement this
project has ever taken of its own layout was taken there. Two of them can run at
once: the shell adopts a host it did not start, so opening the app while a tab is
open costs nothing and stops nothing.

The thing that would make it the only way to run this is the folder picker, and
that is the host's move to make.
