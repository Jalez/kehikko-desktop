//! Keep the page rendering when the app is not frontmost.
//!
//! ## The failure this prevents
//!
//! The owner's report was: "only by switching to another app it shows what has
//! been written." Typing into the terminal module produced nothing on screen
//! until the window lost focus and got it back, and then the whole backlog
//! appeared at once.
//!
//! It is not the terminal's bug and it is not xterm's. In WKWebView as Tauri
//! hosts it, an app that stops being FRONTMOST has its page marked hidden and
//! `requestAnimationFrame` stops firing entirely. Not throttled — stopped. The
//! window does not need to be covered, minimised, or occluded in any sense a
//! person would recognise; it can be fully on screen, and the moment you click
//! on Finder the frames stop. Measured with `kehikko-terminal`'s
//! `dev/frozen-while-backgrounded.js` driven through `examples/webkit-probe.rs`,
//! one line per second, clicking away at t=16:
//!
//! ```text
//! {"s":5, "raf":60, "vis":"visible"}
//! {"s":16,"raf":60, "vis":"visible"}
//! {"s":17,"raf":28, "vis":"hidden"}    <- clicked on Finder here
//! {"s":18,"raf":0,  "vis":"hidden"}
//! {"s":24,"raf":0,  "vis":"hidden"}    <- and it stays at zero
//! ```
//!
//! A `setInterval` beside it keeps ticking at exactly one second throughout, so
//! the page is still executing: the JavaScript runs, the socket delivers, the
//! pty output is parsed into xterm's buffer. Only the rendering update is
//! suspended — and every row xterm draws goes through one `RenderDebouncer`
//! that schedules an animation frame. The frame never arrives, so nothing
//! paints, and the one pending frame runs the moment the window is frontmost
//! again, which is why the backlog arrives all at once.
//!
//! This is not a terminal problem. It is every module's problem. The terminal
//! is simply the only module that changes while you are not looking at it. A
//! same-origin child frame's rAF was measured stopping and resuming in lockstep
//! with its parent's, to the second, so being framed changes nothing and there
//! is nothing a module can arrange for itself.
//!
//! ## Why the fix is here and not in a module
//!
//! Three fixes were tried on the module side first and all three are dead ends,
//! written down so nobody spends the afternoon again:
//!
//! - `@xterm/addon-canvas` and `@xterm/addon-webgl` sit BEHIND the same
//!   `RenderDebouncer` as the DOM renderer. All three renderers stop together.
//! - A "repaint nudge" — touching a style to force a reflow — has nothing to
//!   nudge. A page whose rendering update is suspended does not paint whatever
//!   you write into it; that is what suspended means.
//! - A timer-driven render is both the per-tick work this workspace refuses
//!   everywhere and, by the point above, equally ineffective.
//!
//! Plain WebKit is not the culprit either: Playwright's headed WebKit painted
//! every keystroke in every configuration tried, including framed exactly as
//! the host frames a module, and with the window sent behind another. It is
//! specific to how a Tauri window hosts a WKWebView. The shell holds the
//! WKWebView, so the shell is the only place the fix can be.
//!
//! ## That the one call below is what fixed it
//!
//! Claimed as a difference, so measured as one. `examples/webkit-probe.rs`
//! takes `--freeze-when-backgrounded`, which skips this file and reproduces the
//! window exactly as it was before this file existed. Same binary, same script,
//! the same automated switch to Finder in the middle of each run — and the
//! frontmost application at the moment of the switch was read back and
//! confirmed to be `Finder`, so the difference is not a switch that failed to
//! happen. macOS 15, Tauri 2.11 / wry 0.55, one line per second:
//!
//! ```text
//! --freeze-when-backgrounded          with the call below
//! {"s":4, "raf":60,"vis":"visible"}   {"s":1, "raf":61,"vis":"visible"}
//! {"s":5, "raf":4, "vis":"hidden"}    {"s":10,"raf":60,"vis":"visible"}
//! {"s":6, "raf":0, "vis":"hidden"}    {"s":13,"raf":61,"vis":"visible"}  <- Finder
//! {"s":9, "raf":0, "vis":"hidden"}    {"s":20,"raf":60,"vis":"visible"}
//! {"s":11,"raf":61,"vis":"visible"}   {"s":30,"raf":61,"vis":"visible"}
//! ```
//!
//! Thirty seconds and two round trips to Finder, and the right-hand column
//! never once reported `hidden` or a frame count below 60. The left-hand column
//! is the same window in the same second, told to skip this file.
//!
//! ## The trade-off somebody distributing this has to know about
//!
//! `-[WKWebView _setWindowOcclusionDetectionEnabled:]` is PRIVATE API. The
//! leading underscore is the convention that says so. There is no public
//! equivalent, and it was looked for before reaching for the underscore:
//! `WKWebView` exposes no supported switch for "keep rendering while my window
//! is not key", and nothing settable on `NSWindow` or `NSApplication` reaches
//! the decision, because WebKit makes it inside its own occlusion tracking and
//! pushes the result into the web process as a page-visibility change. The
//! `WKWebViewConfiguration` and `WKPreferences` surfaces have no public knob
//! for it either.
//!
//! **That is acceptable for an app somebody builds and installs on their own
//! machine. It is not acceptable for the Mac App Store.** App Review rejects
//! private API use and the check is automated against the binary — the selector
//! is a plain string in the executable and will be found. If this shell is ever
//! submitted, this call has to come out, and the freeze comes back with it.
//! That is the actual choice, recorded here rather than discovered at review
//! time. Notarisation for direct distribution is a different, much lighter
//! check and does not care about this.
//!
//! ## Why it cannot crash a future macOS
//!
//! Private API can be removed in any release, with no deprecation period and no
//! warning, and `objc_msgSend` to a selector an object does not implement
//! raises an Objective-C exception — which, unwinding into a Rust frame, is an
//! abort. So the selector is tested with `respondsToSelector:` before it is
//! sent. If a future macOS drops it, the shell prints one line saying which
//! capability it lost and carries on with the old freezing behaviour: a worse
//! app, and still an app.

use tauri::WebviewWindow;

/// Ask WebKit to stop marking this window's page hidden when the app is not
/// frontmost. See the module comment for what this costs and why it lives here.
///
/// Best-effort by construction, and returns nothing for that reason. Every
/// failure path — a non-macOS build, a runtime that hands back no webview, a
/// selector that no longer exists — logs a sentence and returns. There is
/// nothing a caller could usefully do about any of them, because the only
/// alternative to "rendering keeps working" is "rendering behaves exactly as it
/// did before this file existed", and refusing to open the window over that
/// would be absurd.
pub fn keep_rendering_while_backgrounded(window: &WebviewWindow) {
    #[cfg(not(target_os = "macos"))]
    {
        // Nothing to do. The behaviour measured above is WKWebView's; every
        // other platform this could build for has a different webview with a
        // different set of opinions, none of them measured here. Claiming a fix
        // for them would be a claim nobody checked.
        let _ = window;
    }

    #[cfg(target_os = "macos")]
    {
        // `with_webview` hands the closure the platform webview pointer on the
        // main thread, which is the only thread AppKit and WebKit accept a
        // message on. It returns `Err` only when the window has already gone.
        if let Err(e) = window.with_webview(|webview| {
            let ptr = webview.inner() as *mut objc2::runtime::AnyObject;
            unsafe { disable_window_occlusion_detection(ptr) };
        }) {
            eprintln!(
                "kehikko-desktop: could not reach the WKWebView to keep it rendering in the background ({e}). \
                 The window will stop painting while another app is frontmost. See src/rendering.rs."
            );
        }
    }
}

/// Send `_setWindowOcclusionDetectionEnabled:NO`, if the object still answers
/// to it.
///
/// # Safety
///
/// `webview` must be a live `WKWebView`, and this must run on the main thread.
/// Both are guaranteed by the only caller: Tauri's `with_webview` hands over
/// exactly that pointer, on exactly that thread, for the duration of the
/// closure.
#[cfg(target_os = "macos")]
unsafe fn disable_window_occlusion_detection(webview: *mut objc2::runtime::AnyObject) {
    use objc2::runtime::{Bool, Sel};
    use objc2::msg_send;

    if webview.is_null() {
        eprintln!(
            "kehikko-desktop: the platform webview pointer was null, so background rendering was left as \
             WebKit's default. See src/rendering.rs."
        );
        return;
    }

    // Written as a registered selector rather than `sel!(…)`, because the
    // `sel!` macro will not parse a name beginning with an underscore. That is
    // not a workaround for a limitation — it is the macro correctly refusing to
    // pretend an SPI name is an ordinary Objective-C method, and
    // `Sel::register` is the documented way to name one anyway. No binding
    // crate will ever declare this method: it is private, so it is generated
    // from no public header.
    let selector: Sel = Sel::register(c"_setWindowOcclusionDetectionEnabled:");

    let responds: Bool = unsafe { msg_send![&*webview, respondsToSelector: selector] };
    if !responds.as_bool() {
        // The guard that earns its keep. Sending a selector an object does not
        // implement raises, and a raise here is an abort — the app would die on
        // launch on the first macOS that drops the SPI, with nothing in the
        // crash report anybody could act on.
        eprintln!(
            "kehikko-desktop: this macOS's WKWebView no longer answers to \
             _setWindowOcclusionDetectionEnabled:, so the window will stop painting while another app is \
             frontmost — everything the terminal writes will arrive at once when you switch back. Nothing is \
             broken; a private WebKit call this shell relied on has gone. See src/rendering.rs."
        );
        return;
    }

    let _: () = unsafe { msg_send![&*webview, _setWindowOcclusionDetectionEnabled: Bool::NO] };

    // Deliberately silent on success. A line per launch saying that a thing
    // worked is noise in the same terminal the host is already printing to; the
    // two failure paths above are the ones somebody needs to see, and they only
    // print when something is actually wrong.
}
