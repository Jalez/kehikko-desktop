//! A window on the Kehikot workbench, and the owner of the host's lifetime.
//!
//! This program is deliberately small, and the smallness is the design. It
//! starts one process, opens one window on a page that process serves, and
//! stops that process when the window goes away. It does not have a folder
//! picker, a module registry, a settings screen or an opinion about a canvas:
//! the host already has all of those, on a page this window shows. Every line
//! that reimplements one of them is a second copy to keep in agreement with the
//! first.
//!
//! Nothing here touches Tauri's IPC, and no module ever will. A module is an
//! HTTP server on its own origin, framed in an iframe, talking `postMessage` to
//! the page that framed it. That page is the host's, served over http, exactly
//! as in a browser tab. From a module's point of view this window is a browser.

mod host;
mod titlebar;

/// The title-bar injection, exposed so the probe example can build a window
/// that behaves exactly like the shell's. Nothing else uses it.
pub fn titlebar_script() -> String {
    titlebar::script()
}

/// Whether the window is fullscreen, said to the page. Exposed for the probe.
pub fn fullscreen_script(on: bool) -> String {
    titlebar::fullscreen_script(on)
}

/// Keep the page told whether the window is fullscreen.
///
/// Fullscreen takes the traffic lights away, so the inset that clears them has
/// to go too — otherwise there is a permanent 82-pixel hole in the header where
/// the lights used to be. There is no media query for this in WKWebView
/// (`display-mode: fullscreen` is a PWA feature and answers `browser` here,
/// measured), so the fact is pushed from this side on every resize.
pub fn watch_fullscreen(window: &tauri::WebviewWindow) {
    let w = window.clone();
    let start = w.is_fullscreen().unwrap_or(false);
    let was = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(start));
    let _ = w.eval(&titlebar::fullscreen_script(start));
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            let now = w.is_fullscreen().unwrap_or(false);
            if was.swap(now, Ordering::SeqCst) != now {
                let _ = w.eval(&titlebar::fullscreen_script(now));
            }
        }
    });
}

use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The process group of the host we started, or 0 for "we started nothing".
///
/// An atomic rather than a `Mutex` because the terminal-interrupt handler reads
/// it, and taking a lock in a signal handler is how a program deadlocks on the
/// way out — the one moment when hanging is least forgivable.
static GROUP: AtomicI32 = AtomicI32::new(0);

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let settings = host::settings();
            let page_port = settings.api_port + 1;

            // The window opens NOW, on a local page, and says what it is doing.
            // The alternative — block until the host answers, then open — is a
            // dock icon bouncing for forty seconds on a first run while `bun
            // install` runs, with no way to tell that from a hang.
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kehikot")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // Injected before every page load, the host's included. See
                // `titlebar.rs` for what it does and what is wrong with doing
                // it this way.
                .initialization_script(titlebar::script())
                // On EVERY page, not only on the transition. The fullscreen
                // flag lives on the document, so a reload — or the first
                // navigation from the waiting room to the host — loses it, and
                // the inset comes back as an 82-pixel hole where the traffic
                // lights are not. Measured: the second page load in fullscreen
                // reported the inset back at 82px before this hook existed.
                .on_page_load(|webview, _| {
                    let on = webview.is_fullscreen().unwrap_or(false);
                    let _ = webview.eval(&titlebar::fullscreen_script(on));
                });

            // The window has no title bar of its own: the page runs to the top
            // of the window and the three lights float over the host's strip.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            let window = builder.build()?;

            watch_fullscreen(&window);

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let page = format!("http://127.0.0.1:{page_port}");

                // Somebody is already serving that port. Adopt it: do not start
                // a second host, and — the half that matters — do not stop it
                // on quit. We only ever kill what we started, because the
                // alternative is this window closing and taking down the host
                // somebody else's terminal is holding.
                if host::listening(page_port) {
                    say(&handle, &format!(
                        "Found a host already answering on {page}. Using it — this window will not stop it when you quit, because it did not start it."
                    ), Phase::Adopted);
                    go(&handle, &page);
                    return;
                }

                let script = match host::startable(&settings.dir) {
                    Ok(script) => script,
                    Err(refusal) => {
                        say(&handle, &format!(
                            "{}\n\nThat path came from {}.\n\nSet the right one in {} as {{\"hostDir\": \"/path/to/kehikko\"}}, or run this with KEHIKKO_HOST_DIR set, and reopen the window.",
                            refusal.sentence(),
                            settings.source,
                            host::config_path().display()
                        ), Phase::Failed);
                        return;
                    }
                };

                say(&handle, &format!("Starting the host in {}…", settings.dir.display()), Phase::Starting);

                let child = match host::start(&settings.dir, &script, settings.api_port) {
                    Ok(child) => child,
                    Err(e) => {
                        say(&handle, &format!("Could not run {}: {e}", script.display()), Phase::Failed);
                        return;
                    }
                };

                // The child led its own process group, so its pid IS the group
                // id. See `host::start` for why the group and not the pid.
                let pgid = child.id() as i32;
                GROUP.store(pgid, Ordering::SeqCst);
                arm_terminal_signals();

                if host::wait_until_up(page_port, Duration::from_secs(120)) {
                    go(&handle, &page);
                } else {
                    say(&handle, &format!(
                        "The host was started in {} but nothing answered on {page} within two minutes. Look at the terminal this was launched from: run.sh prints why it failed there, and it is usually a port already held or a failed `bun install`.",
                        settings.dir.display()
                    ), Phase::Failed);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building the Kehikot shell")
        .run(|_app, event| match event {
            // Both, and in this order. `ExitRequested` is where a graceful quit
            // arrives with time to spare; `Exit` catches the paths that skip it.
            // `reap()` is written to be harmless the second time.
            RunEvent::ExitRequested { .. } | RunEvent::Exit => reap(),
            _ => {}
        });
}

/// Send the host's page to the window.
///
/// `navigate` rather than a second window, so there is exactly one window for
/// the life of the app and no flash of a second one.
fn go(handle: &tauri::AppHandle, page: &str) {
    if let Some(window) = handle.get_webview_window("main") {
        if let Ok(url) = page.parse() {
            let _ = window.navigate(url);
        }
    }

    // Did the title-bar injection find the host's header? The page has no IPC
    // to answer with and is not getting one for a diagnostic, so it answers by
    // appending to the window title — which is hidden, and therefore free to
    // use as a channel. This is the whole of the reporting: a line in the
    // terminal, once, when the injection stopped matching.
    let handle = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        if let Some(window) = handle.get_webview_window("main") {
            if let Ok(title) = window.title() {
                if title.contains("[no header matched]") {
                    eprintln!(
                        "kehikko-desktop: the title-bar injection found no host header, so the window controls are sitting on top of the page. See src/titlebar.rs."
                    );
                }
            }
        }
    });
}

enum Phase {
    Starting,
    Adopted,
    Failed,
}

/// Put a sentence on the local page.
///
/// This is an `eval` calling a function the page defines, rather than an event
/// the page subscribes to, for one reason: an event listener needs the Tauri
/// JavaScript API on the page, which needs `withGlobalTauri`, which puts an IPC
/// bridge on a window whose whole job is then to navigate to a page full of
/// other people's programs in iframes. The shell needs to say three sentences.
/// It does not need a bridge to say them.
///
/// So: no IPC, no capabilities file, no commands. The message is passed as a
/// JSON string and the page sets it with `textContent`, so a directory name
/// with a `<` in it is a directory name and not markup.
fn say(handle: &tauri::AppHandle, message: &str, phase: Phase) {
    let name = match phase {
        Phase::Starting => "starting",
        Phase::Adopted => "adopted",
        Phase::Failed => "failed",
    };
    if let Some(window) = handle.get_webview_window("main") {
        let js = format!("window.kehikkoStatus && window.kehikkoStatus({}, {})", quote(name), quote(message));
        let _ = window.eval(&js);
    }
}

/// A JSON string literal. Enough of an encoder for one string; the alternative
/// is a serialisation dependency carried for this line.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Stop what we started: TERM the group, give it five seconds, then KILL.
///
/// The grace period is not politeness. The host's `run.sh` traps TERM to stop
/// its API, and every module the host itself started is stopped by the host on
/// its own way out — a KILL first would skip both and leave exactly the ports
/// this program exists to not leave behind.
fn reap() {
    let pgid = GROUP.swap(0, Ordering::SeqCst);
    if pgid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        host::stop_group(pgid);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            // ESRCH from signal 0 means the group is gone.
            let alive = unsafe { libc::killpg(pgid, 0) } == 0;
            if !alive {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        host::kill_group(pgid);
    }
}

/// Ctrl-C in the terminal that ran `tauri dev` does not go to the host: we put
/// it in its own process group precisely so it would not. So catch the signal
/// and pass it on ourselves, or a development session leaves behind the very
/// orphans a release build cleans up.
#[cfg(unix)]
fn arm_terminal_signals() {
    unsafe {
        libc::signal(libc::SIGINT, handle_terminal_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handle_terminal_signal as *const () as libc::sighandler_t);
    }
}

#[cfg(unix)]
extern "C" fn handle_terminal_signal(sig: libc::c_int) {
    // Only async-signal-safe calls here: an atomic load, killpg, _exit. No
    // allocation, no locks, no printing.
    let pgid = GROUP.swap(0, Ordering::SeqCst);
    if pgid != 0 {
        unsafe {
            libc::killpg(pgid, libc::SIGTERM);
        }
    }
    unsafe { libc::_exit(128 + sig) }
}
