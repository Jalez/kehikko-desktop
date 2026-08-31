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
```

The **npm CLI** (`@tauri-apps/cli`) rather than `cargo install tauri-cli`: it
ships a prebuilt binary, so it is a ten-second install instead of a five-minute
one, and it pins with the lockfile. Rust 1.96 builds the app itself. The first
Rust build takes a few minutes and compiles about 230 crates; that is expected.

Tauri **v2**. v1 guidance will mislead you — the security model is different, and
in particular capabilities did not exist there.

### Where the host is

Not compiled in, because a shell whose host directory is a constant has to be
rebuilt to be moved. In order:

1. `$KEHIKKO_HOST_DIR`
2. `~/.config/kehikko-desktop/config.json` — `{"hostDir": "…", "apiPort": 4180}`
3. `~/Projects/kehikko`, which is a **guess**, and the error page says so when it
   is wrong.

A path that is wrong is a shell that starts nothing and says why: the window
opens immediately on a local waiting-room page, and that page is where the
refusal is written — which directory it looked in, which of the three sources
named it, and what to put in the config file. The distinction between "no such
directory", "no `run.sh` in it" and "`run.sh` is not executable" is kept, because
those three send you to different fixes.

The API port is configurable; the page port is always API + 1, because `run.sh`
computes it that way and nothing here is entitled to a different opinion.

### If a host is already running

It is adopted. The shell does not start a second one — and, the half that
matters, does not stop it on quit either. **We only ever kill what we started.**
The alternative is this window closing and taking down the host somebody else's
terminal is holding.

---

## The two configuration items, and why each exists

Both of these look like something a tidy-minded person would delete. Neither is
decoration.

### 1. `ROADMAP_ORIGIN`, set on the host process this shell spawns

Every module composes its own frame policy from it:

```js
frame-ancestors 'self' ${process.env.ROADMAP_ORIGIN ?? 'http://127.0.0.1:4181 http://localhost:4181'}
```

Note the `??`. Setting this variable **replaces** the default rather than adding
to it, so a shell that set only its own origin would silently break the browser
tab — every container blank, for whoever opens <http://127.0.0.1:4181> next. So
the shell sets all four:

```
tauri://localhost http://tauri.localhost http://127.0.0.1:4181 http://localhost:4181
```

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
whatever `ROADMAP_ORIGIN` that terminal had — usually none, so the default. That
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
| **`requestAnimationFrame`** | **Works, with a caveat.** When the window is occluded or in the background, `document.visibilityState` goes `hidden` and rAF **stops firing entirely** — not throttled, stopped. Browsers do this too, but a module that waits on a rAF before reporting its height will appear to hang if it is loaded into a window nobody is looking at. Anything that must complete off-screen should use a timer. This cost an hour of this build: a probe that awaited two rAFs simply never finished. |
| **xterm.js with a live pty** | **Not verified.** Its substrate is fine — `.xterm`, `.xterm-screen`, `.xterm-rows` and `.xterm-viewport` all construct, and canvas, WebGL and WebSocket are all present — but no shell could be started to draw into it. The Terminal module reports "a shell could not be started on this machine", which is its `node-pty` import failing in the module's own server process, with no webview involved. That is a condition on this machine today, not a WebKit finding, and it will reproduce in Chromium. Verifying it framed would have meant unfolding a container on a canvas this task was not allowed to change. |

Nothing was found broken. Nothing here needs a module change.

### Two things that are true of the shell, not of WebKit

- **Tauri's initialization scripts do not reach subframes.** Measured directly: a
  same-origin iframe of the host, opened inside the host's page, has neither the
  injected stylesheet nor `__TAURI_INTERNALS__` in it. So a module cannot see the
  title-bar injection and **cannot call a window command** — the capability below
  reaches the host's page and nothing else.
- **The capability is two commands wide.** `src-tauri/capabilities/titlebar.json`
  grants `core:window:allow-start-dragging` and
  `core:window:allow-toggle-maximize` to window `main` at the host's origin, and
  nothing else. Both were called for real and both returned; `toggle_maximize`
  took the window from 1440 to 1512 wide, which is what a double-click on the
  drag region does. Scoped to a window and an origin: the same calls from a
  window named anything else are refused, with the refusal naming the capability.

---

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
src-tauri/capabilities/     two window commands, scoped to one origin
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
