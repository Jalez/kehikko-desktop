//! Updating the app in place, from GitHub Releases: the engine. The host's page
//! draws the only update UI; this side downloads, verifies, installs, and says
//! what it is doing.
//!
//! The app and the host it carries are one release: a new version replaces
//! `Kehikot.app` whole, sidecar included, so the bundled host never updates
//! itself — this is the only updater in a release build. There is one update
//! system as far as a person can tell, though: the host's Updates menu, which
//! already lists the modules, shows a "Kehikot app" row beside them and a
//! header indicator, built against the contract below. This file draws nothing.
//!
//! ## The shape of it
//!
//! - **In the background, without asking.** About five seconds after launch,
//!   then every four hours, and again shortly after the Mac wakes from sleep,
//!   the check runs on a thread of its own. If there is a newer release it is
//!   downloaded at once — downloading costs the person nothing, and asking first
//!   only puts a modal on top of their work. The window and the host start
//!   exactly as they would offline; a failure is a line on stderr and a
//!   `failed` state. An updater that can stop the app starting is worse than
//!   none. Only one check or download ever runs at a time.
//! - **Restarting is the person's call.** Restarting stops the host and every
//!   module it started, and they may be in the middle of something, so nothing
//!   restarts on its own. `apply_update` installs and relaunches, reaping the
//!   host first exactly as the host-requested restart does.
//! - **Not lost if they never restart.** The downloaded, verified archive is
//!   kept in memory and installed on the way out when the app quits
//!   (`install_pending`, called from the exit events), so the next launch is the
//!   new version. On macOS `Update::install` only replaces the bundle on disk and
//!   never relaunches, which is what makes doing it at quit safe. If a later
//!   check finds a still newer release while one is waiting, the newer one is
//!   downloaded quietly — the state stays `ready` with the waiting version — and
//!   replaces it only once it is downloaded and verified.
//! - **Verified.** `Update::download` checks the minisign signature against the
//!   public key in `tauri.conf.json` before it returns any bytes, so a
//!   compromised download location cannot ship code. That holds without Apple
//!   signing; the two are independent.
//!
//! ## The contract with the host's page
//!
//! The status, one shape everywhere (`status()`):
//!
//! ```text
//! {
//!   "enabled":   bool,           // false: debug build or a checkout; never checks
//!   "current":   "0.1.1",        // the running app's version
//!   "state":     "idle" | "checking" | "downloading" | "ready" | "installing"
//!                | "failed" | "uptodate",
//!   "version":   "0.1.2" | null, // the update downloading / ready / installing
//!   "progress":  0..1 | null,    // downloading only; null while the size is unknown
//!   "error":     string | null,  // the last failure, until a check succeeds
//!   "checkedAt": ms | null       // Unix ms when the last check finished
//! }
//! ```
//!
//! `idle` is "not checked yet" (and stays so while `enabled` is false);
//! `installing` is the moment between `apply_update` and the relaunch.
//!
//! Up, from the page — three commands with no arguments, reached through
//! `window.__TAURI_INTERNALS__.invoke` as `remember_theme` is:
//!
//! - `update_status` → the status.
//! - `check_for_update` → starts a check unless one is already running or an
//!   install is under way, and returns the status as it is right after
//!   (`checking`, unless an update is already `ready`).
//! - `apply_update` → installs the `ready` update and relaunches. Does nothing
//!   in any other state.
//!
//! Granted the way `remember_theme` is — `permissions/update.toml`,
//! `capabilities/update.json`, window `main`, the host's loopback origins only
//! (plus the configured port, at runtime: `grant_update_commands_to` in lib.rs).
//!
//! Down, to the page — on every change, the shell evaluates
//!
//! ```text
//! window.kehikotAppUpdate?.(status)
//! ```
//!
//! a well-known function the host's page defines, the same no-bridge channel
//! `say()` in `lib.rs` uses for the waiting room. No event system, no
//! `withGlobalTauri`, nothing for a module to subscribe to. A page that does
//! not define the function loses nothing; it is also called again after every
//! page load (`replay`), and a page should still ask `update_status` once when
//! it mounts, because it may define the function after the last push. While
//! downloading, it is called once per whole percent, not per chunk.
//!
//! ## When nobody is listening
//!
//! A host page built before this contract never calls `update_status`, so it
//! would never show that an update is ready. If an update becomes ready and the
//! page has not once asked for the status, the shell asks itself, with a native
//! alert carrying Kehikot's icon. "Later" leaves it to be installed on quit.
//! `native` says why the dialog plugin is no longer used.
//!
//! ## Trying it without a release
//!
//! A debug build never checks for updates. `KEHIKOT_UPDATE_DEMO=1` in a debug
//! build drives the same state machine with fake progress and no network —
//! the commands answer and the page function is called exactly as in a real
//! update, so the host's UI can be built and tested against it: `checking`,
//! `downloading` with `progress: null`, then 0..1, `ready`; `apply_update` then
//! relaunches without installing anything. `=fail` fails the first download at
//! 60%, so `failed` and a retry through `check_for_update` can be seen;
//! `=dialog` shows the native alert at `ready` regardless. The README has the
//! recipe for a real end-to-end test against a locally served `latest.json`.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How often a running app looks again.
const EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// How often the scheduler wakes to see whether it is time, or whether the
/// Mac has slept.
const TICK: Duration = Duration::from_secs(60);

/// How much more wall-clock than monotonic time must pass in one tick to count
/// as a sleep. The monotonic clock (`Instant`, `CLOCK_UPTIME_RAW` on macOS)
/// stops while the machine sleeps and the wall clock does not, so the gap
/// between them is the length of the nap. Measured that way rather than by
/// subscribing to `NSWorkspaceDidWakeNotification`, which would need an
/// Objective-C observer object for one boolean.
const SLEPT: Duration = Duration::from_secs(120);

/// After a wake, give Wi-Fi a moment before asking GitHub anything.
const AFTER_WAKE: Duration = Duration::from_secs(20);

/// The whole download, not each read: a stalled connection must end in
/// `failed`, not in a progress that never moves again.
const DOWNLOAD_BUDGET: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// No checks at all: a debug build, or a window on a named checkout.
    Off,
    /// A release build running the host it carries.
    Live,
    /// Debug builds only, `KEHIKOT_UPDATE_DEMO` set: fake progress, no network.
    Demo(Demo),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Demo {
    Plain,
    Fail,
    Dialog,
}

/// Which mode this launch runs in.
///
/// Not a debug build, and not a window on a checkout: whoever runs the host
/// from a checkout builds this app from source too, and an offer to replace it
/// with a release would be an offer to undo their own build.
pub fn mode(bundled_host: bool) -> Mode {
    if cfg!(debug_assertions) {
        return match std::env::var("KEHIKOT_UPDATE_DEMO").ok().as_deref().map(str::trim) {
            None | Some("") | Some("0") => Mode::Off,
            Some("fail") => Mode::Demo(Demo::Fail),
            Some("dialog") => Mode::Demo(Demo::Dialog),
            Some(_) => Mode::Demo(Demo::Plain),
        };
    }
    if bundled_host {
        Mode::Live
    } else {
        Mode::Off
    }
}

#[derive(Clone, Debug)]
enum Stage {
    Idle,
    Checking,
    Downloading { version: String, got: u64, total: Option<u64> },
    Ready { version: String },
    Installing { version: String },
    Failed,
    UpToDate,
}

/// A downloaded, verified update waiting to be installed.
enum Pending {
    Real { update: Box<Update>, bytes: Vec<u8> },
    Demo { version: String },
}

impl Pending {
    fn version(&self) -> &str {
        match self {
            Pending::Real { update, .. } => &update.version,
            Pending::Demo { version } => version,
        }
    }
}

struct Inner {
    stage: Stage,
    pending: Option<Pending>,
    error: Option<String>,
    checked_at: Option<u64>,
    busy: bool,
    attempts: u64,
    /// Whether the page has ever asked for the status — i.e. whether anything
    /// on it will show that an update is ready.
    page_listens: bool,
}

pub struct Updates {
    mode: Mode,
    inner: Mutex<Inner>,
}

impl Updates {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Register the updater's state and, unless the mode is `Off`, start checking
/// on a thread of its own. Never blocks startup and never fails it.
pub fn start(app: &AppHandle, mode: Mode) {
    app.manage(Updates {
        mode,
        inner: Mutex::new(Inner {
            stage: Stage::Idle,
            pending: None,
            error: None,
            checked_at: None,
            busy: false,
            attempts: 0,
            page_listens: false,
        }),
    });
    if mode == Mode::Off {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // A few seconds' grace, so nothing changes while the waiting room is
        // drawing its first frame.
        std::thread::sleep(Duration::from_secs(5));
        attempt(&app);

        let mut last_wall = SystemTime::now();
        let mut last_mono = Instant::now();
        let mut last_check = SystemTime::now();
        loop {
            std::thread::sleep(TICK);
            let wall = SystemTime::now();
            let mono = Instant::now();
            let wall_step = wall.duration_since(last_wall).unwrap_or_default();
            let mono_step = mono.duration_since(last_mono);
            last_wall = wall;
            last_mono = mono;

            let woke = wall_step.saturating_sub(mono_step) > SLEPT;
            let due = wall.duration_since(last_check).unwrap_or_default() >= EVERY;
            if woke || due {
                if woke {
                    std::thread::sleep(AFTER_WAKE);
                }
                // `attempt` refuses to start a second check, so a check the
                // person asked for a moment ago simply wins.
                attempt(&app);
                last_check = SystemTime::now();
            }
        }
    });
}

fn state(app: &AppHandle) -> Option<tauri::State<'_, Updates>> {
    app.try_state::<Updates>()
}

enum Found {
    /// A newer release, downloaded and verified.
    New(Pending),
    /// Nothing newer than the running app.
    Nothing,
    /// The newest release is the one already downloaded and waiting.
    Same,
}

/// Claim the single check slot. False when a check, download or install is
/// already running — the caller then does nothing.
fn claim(s: &Updates) -> bool {
    let mut inner = s.lock();
    if s.mode == Mode::Off || inner.busy || matches!(inner.stage, Stage::Installing { .. }) {
        return false;
    }
    inner.busy = true;
    inner.attempts += 1;
    // With an update already waiting the state stays `ready`; a newer one is
    // looked for, and fetched, out of sight.
    if inner.pending.is_none() {
        inner.stage = Stage::Checking;
    }
    true
}

/// One check-and-download, if no other is running.
fn attempt(app: &AppHandle) {
    let Some(s) = state(app) else { return };
    if claim(&s) {
        run(app);
    }
}

/// The body of an attempt whose slot is already claimed.
fn run(app: &AppHandle) {
    let Some(s) = state(app) else { return };
    let mode = s.mode;
    let waiting = s.lock().pending.as_ref().map(|p| p.version().to_string());
    push(app);

    let result = match mode {
        Mode::Off => Ok(Found::Nothing),
        Mode::Live => tauri::async_runtime::block_on(live(app, waiting.as_deref())),
        Mode::Demo(demo) => fake(app, demo, waiting.as_deref()),
    };

    let mut inner = s.lock();
    inner.busy = false;
    inner.checked_at = Some(now_ms());
    match result {
        Ok(Found::New(pending)) => {
            let version = pending.version().to_string();
            match &waiting {
                Some(old) => eprintln!(
                    "kehikko-desktop: Kehikot {version} is downloaded and verified; it replaces {old}, which was waiting"
                ),
                None => eprintln!(
                    "kehikko-desktop: Kehikot {version} is downloaded and verified; it installs on restart or quit"
                ),
            }
            inner.pending = Some(pending);
            inner.stage = Stage::Ready { version: version.clone() };
            inner.error = None;
            let unheard = !inner.page_listens;
            drop(inner);
            push(app);
            if waiting.is_none() && (mode == Mode::Demo(Demo::Dialog) || unheard) {
                eprintln!("kehikko-desktop: nothing on the page asks about updates, so asking with an alert");
                ask_natively(app, &version);
            }
        }
        Ok(Found::Same) => {
            inner.error = None;
            drop(inner);
            push(app);
        }
        Ok(Found::Nothing) => {
            inner.error = None;
            if inner.pending.is_none() {
                inner.stage = Stage::UpToDate;
            }
            drop(inner);
            push(app);
        }
        Err(message) => {
            eprintln!("kehikko-desktop: update failed: {message}");
            inner.error = Some(message);
            // A failure to fetch something newer does not take away the update
            // that is already waiting.
            if inner.pending.is_none() {
                inner.stage = Stage::Failed;
            }
            drop(inner);
            push(app);
        }
    }
}

/// While nothing is waiting, the download is the state. While something is,
/// the newer one is fetched quietly and the state stays `ready`.
fn progress(app: &AppHandle, visible: bool, version: &str, got: u64, total: Option<u64>) {
    if !visible {
        return;
    }
    if let Some(s) = state(app) {
        s.lock().stage = Stage::Downloading { version: version.to_string(), got, total };
    }
}

/// The real thing: ask the endpoint, download with progress, verify.
async fn live(app: &AppHandle, waiting: Option<&str>) -> Result<Found, String> {
    let updater = app
        .updater_builder()
        .timeout(DOWNLOAD_BUDGET)
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Found::Nothing);
    };
    if waiting == Some(update.version.as_str()) {
        return Ok(Found::Same);
    }

    let version = update.version.clone();
    let visible = waiting.is_none();
    eprintln!("kehikko-desktop: downloading Kehikot {version} (you have {})", update.current_version);
    progress(app, visible, &version, 0, None);
    push(app);

    let mut got: u64 = 0;
    let mut shown: Option<Option<u64>> = None;
    let bytes = update
        .download(
            |chunk, total| {
                got += chunk as u64;
                progress(app, visible, &version, got, total);
                // One push per whole percent, not per chunk: a 30 MB archive
                // arrives in a couple of thousand chunks.
                let now = percent(got, total);
                if visible && shown != Some(now) {
                    shown = Some(now);
                    push(app);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(Found::New(Pending::Real { update: Box::new(update), bytes }))
}

/// `KEHIKOT_UPDATE_DEMO`: the same states with made-up numbers.
fn fake(app: &AppHandle, demo: Demo, waiting: Option<&str>) -> Result<Found, String> {
    let current = &app.package_info().version;
    let version = format!("{}.{}.{}", current.major, current.minor, current.patch + 1);
    if waiting == Some(version.as_str()) {
        return Ok(Found::Same);
    }
    let first = state(app).map(|s| s.lock().attempts == 1).unwrap_or(true);

    std::thread::sleep(Duration::from_millis(1200));
    // A beat with no size known, to show `progress: null`.
    progress(app, true, &version, 0, None);
    push(app);
    std::thread::sleep(Duration::from_millis(1800));

    let total: u64 = 31_457_280;
    let steps = 50;
    for step in 1..=steps {
        std::thread::sleep(Duration::from_millis(160));
        if demo == Demo::Fail && first && step == steps * 6 / 10 {
            return Err("demo: the download was cut off at 60% (KEHIKOT_UPDATE_DEMO=fail fails the first attempt only)".into());
        }
        progress(app, true, &version, total * step / steps, Some(total));
        push(app);
    }
    Ok(Found::New(Pending::Demo { version }))
}

/// Whole percent, for deciding when to push.
fn percent(got: u64, total: Option<u64>) -> Option<u64> {
    match total {
        Some(total) if total > 0 => Some((got.saturating_mul(100) / total).min(100)),
        _ => None,
    }
}

/// The status object the module comment describes.
fn status(app: &AppHandle) -> serde_json::Value {
    let current = app.package_info().version.to_string();
    let Some(s) = state(app) else {
        return json!({ "enabled": false, "current": current, "state": "idle", "version": null,
                        "progress": null, "error": null, "checkedAt": null });
    };
    let enabled = s.mode != Mode::Off;
    let inner = s.lock();
    let (name, version, progress) = match &inner.stage {
        Stage::Idle => ("idle", None, None),
        Stage::Checking => ("checking", None, None),
        Stage::Downloading { version, got, total } => {
            let fraction = match total {
                Some(total) if *total > 0 => Some(((*got as f64) / (*total as f64)).clamp(0.0, 1.0)),
                _ => None,
            };
            ("downloading", Some(version.clone()), fraction)
        }
        Stage::Ready { version } => ("ready", Some(version.clone()), None),
        Stage::Installing { version } => ("installing", Some(version.clone()), None),
        Stage::Failed => ("failed", None, None),
        Stage::UpToDate => ("uptodate", None, None),
    };
    json!({
        "enabled": enabled,
        "current": current,
        "state": name,
        "version": version,
        "progress": progress,
        "error": inner.error,
        "checkedAt": inner.checked_at,
    })
}

/// The page function, called defensively: a page that does not define it, or
/// whose handler throws, must not see an error from the shell.
fn call(status: &serde_json::Value) -> String {
    format!(
        "try {{ typeof window.kehikotAppUpdate === 'function' && window.kehikotAppUpdate({status}) }} catch (e) {{ console.error('kehikotAppUpdate threw', e) }}"
    )
}

/// Tell the page the current status.
fn push(app: &AppHandle) {
    let js = call(&status(app));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&js);
    }
}

/// Tell a page that has just loaded the current status. The state lives on
/// this side, so a reload, or the move from the waiting room to the host's
/// page, loses nothing.
pub fn replay(window: &WebviewWindow) {
    if window.app_handle().try_state::<Updates>().is_some() {
        let _ = window.eval(&call(&status(window.app_handle())));
    }
}

/// Install the downloaded update and relaunch into it.
///
/// Called through `apply_update` and by the native alert. Does nothing unless
/// an update is downloaded and ready, so a page that calls it at the wrong
/// moment achieves nothing.
pub fn apply(app: &AppHandle) {
    let Some(s) = state(app) else { return };
    let pending = {
        let mut inner = s.lock();
        let Stage::Ready { version } = inner.stage.clone() else { return };
        let Some(pending) = inner.pending.take() else { return };
        inner.stage = Stage::Installing { version };
        pending
    };
    push(app);

    let app = app.clone();
    std::thread::spawn(move || {
        match pending {
            Pending::Real { update, bytes } => {
                eprintln!("kehikko-desktop: installing Kehikot {}", update.version);
                if let Err(e) = update.install(&bytes) {
                    let message = format!("installing {} failed: {e}", update.version);
                    eprintln!("kehikko-desktop: update failed: {message}");
                    if let Some(s) = state(&app) {
                        let mut inner = s.lock();
                        inner.stage = Stage::Failed;
                        inner.error = Some(message);
                        inner.checked_at = Some(now_ms());
                    }
                    push(&app);
                    return;
                }
            }
            Pending::Demo { version } => {
                eprintln!("kehikko-desktop: demo: would install Kehikot {version} now; restarting without installing");
                std::thread::sleep(Duration::from_millis(600));
            }
        }
        // Stop what we started before we go: `restart()` does not pass through
        // the exit events that normally reap the host, and the new version
        // would find the old host still on its port and adopt it.
        crate::reap();
        app.restart();
    });
}

/// Install a downloaded update that nobody restarted for. Called on the way
/// out — from the exit events, after the host is reaped, and before the
/// host-requested restart — so a download is never thrown away.
///
/// On macOS this replaces the bundle on disk and returns; it never relaunches.
/// When the bundle's folder is not writable the plugin asks for an
/// administrator password through AppleScript on the main thread, which is
/// where the exit events run; Tauri runs a main-thread task inline when it is
/// already on the main thread, so that path does not deadlock.
pub fn install_pending(app: &AppHandle) {
    let Some(s) = state(app) else { return };
    let pending = {
        let mut inner = s.lock();
        // Mid-install through `apply_update` already: leave it to that thread.
        if matches!(inner.stage, Stage::Installing { .. }) {
            return;
        }
        inner.pending.take()
    };
    match pending {
        Some(Pending::Real { update, bytes }) => {
            eprintln!("kehikko-desktop: installing Kehikot {} on the way out", update.version);
            match update.install(&bytes) {
                Ok(()) => eprintln!("kehikko-desktop: installed; the next launch runs {}", update.version),
                Err(e) => eprintln!(
                    "kehikko-desktop: installing {} on the way out failed: {e}; the next launch checks again",
                    update.version
                ),
            }
        }
        Some(Pending::Demo { version }) => {
            eprintln!("kehikko-desktop: demo: would install Kehikot {version} on the way out");
        }
        None => {}
    }
}

fn listening(app: &AppHandle) {
    if let Some(s) = state(app) {
        s.lock().page_listens = true;
    }
}

/// What the updater is doing.
#[tauri::command]
pub fn update_status(app: AppHandle) -> serde_json::Value {
    listening(&app);
    status(&app)
}

/// Check now. Starts a check unless one is running, and answers with the status
/// as it is right after.
#[tauri::command]
pub fn check_for_update(app: AppHandle) -> serde_json::Value {
    listening(&app);
    // Claimed here rather than on the thread, so the answer already reads
    // `checking` and a second press finds the slot taken.
    let claimed = state(&app).map(|s| claim(&s)).unwrap_or(false);
    if claimed {
        let handle = app.clone();
        std::thread::spawn(move || run(&handle));
    }
    status(&app)
}

/// Install the `ready` update and relaunch.
#[tauri::command]
pub fn apply_update(app: AppHandle) {
    listening(&app);
    eprintln!("kehikko-desktop: the page asked to restart into the update");
    apply(&app);
}

/// Ask with a native alert, for when nothing on the page will.
fn ask_natively(app: &AppHandle, version: &str) {
    let title = format!("Kehikot {version} is ready to install");
    let text = "It was downloaded in the background. Restarting installs it, and stops the host and \
                the modules it started.\n\nIf you choose Later, it is installed when you quit Kehikot."
        .to_string();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let restart = native::ask(&title, &text, "Restart Now", "Later");
        #[cfg(not(target_os = "macos"))]
        let restart = {
            let _ = (&title, &text);
            false
        };
        eprintln!("kehikko-desktop: the alert was answered: {}", if restart { "restart now" } else { "later" });
        if restart {
            apply(&handle);
        }
    });
}

#[cfg(target_os = "macos")]
mod native {
    //! One `NSAlert`, built by hand.
    //!
    //! ## Why not `tauri-plugin-dialog`
    //!
    //! The old "Update available" question went through the dialog plugin and
    //! came up without Kehikot's icon. The plugin hands the message to `rfd`
    //! and offers no way to set an icon. `rfd` has two macOS paths: with a
    //! parent window it begins an `NSAlert` sheet, and without one it calls
    //! `CFUserNotificationDisplayAlert` with no icon URL — an alert drawn by a
    //! system agent on the app's behalf, which cannot carry the app's icon at
    //! all. Which path a call takes depends on a raw window handle fetched
    //! across threads at the moment of asking, and nothing outside says which
    //! one it was. (The icon itself was never missing: the bundle has
    //! `icon.icns` and `CFBundleIconFile` names it.)
    //!
    //! So this builds the `NSAlert` directly, on the main thread, sets the
    //! bundle's icon on it explicitly, and brings the app forward first so the
    //! alert is not hidden behind whatever the person is looking at. The
    //! plugin, which nothing else used, is gone.

    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use std::ffi::CString;

    /// `NSAlertFirstButtonReturn`.
    const FIRST_BUTTON: isize = 1000;

    fn string(s: &str) -> *mut AnyObject {
        let c = CString::new(s.replace('\0', "")).unwrap_or_default();
        unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
    }

    /// Show an app-modal alert and say whether the first button was chosen.
    /// Must run on the main thread; the only caller runs it there.
    pub fn ask(title: &str, text: &str, yes: &str, no: &str) -> bool {
        objc2::rc::autoreleasepool(|_| unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            // Forward first, or the alert opens behind whatever the person is
            // looking at and the app only bounces in the Dock.
            let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];

            let alert: *mut AnyObject = msg_send![class!(NSAlert), new];
            let _: () = msg_send![alert, setMessageText: string(title)];
            let _: () = msg_send![alert, setInformativeText: string(text)];
            // The bundle's icon, said out loud rather than left to a default:
            // an alert about replacing Kehikot must look like it is from Kehikot.
            let icon: *mut AnyObject = msg_send![app, applicationIconImage];
            if !icon.is_null() {
                let _: () = msg_send![alert, setIcon: icon];
            }
            let _: *mut AnyObject = msg_send![alert, addButtonWithTitle: string(yes)];
            let _: *mut AnyObject = msg_send![alert, addButtonWithTitle: string(no)];
            let answer: isize = msg_send![alert, runModal];
            let _: () = msg_send![alert, release];
            answer == FIRST_BUTTON
        })
    }
}

/// A test harness, not a feature: in a debug build with `KEHIKOT_UPDATE_DEMO`
/// set, a small panel in the bottom-right corner of the host's page plays the
/// host's part of the contract — it defines `window.kehikotAppUpdate`, asks
/// `update_status` when it loads, and has "check" and "restart" buttons that
/// call `check_for_update` and `apply_update`. It exists so the engine can be
/// exercised end to end in the real webview, through the real capability,
/// before the host's own UI is built. Never injected in a release build.
pub fn demo_harness(mode: Mode) -> Option<&'static str> {
    match mode {
        Mode::Demo(Demo::Plain) | Mode::Demo(Demo::Fail) if cfg!(debug_assertions) => Some(DEMO_HARNESS),
        _ => None,
    }
}

const DEMO_HARNESS: &str = r#"
(() => {
  if (window.top !== window.self || location.protocol !== 'http:') return;
  const invoke = (cmd) => window.__TAURI_INTERNALS__.invoke(cmd);
  let box, line, log = [];
  const show = (s, via) => {
    if (!box) return;
    const p = s.progress == null ? '' : ' ' + Math.round(s.progress * 100) + '%';
    line.textContent = `${s.state}${s.version ? ' ' + s.version : ''}${p}` + (s.error ? ` — ${s.error}` : '');
    log.push(via + ':' + s.state + (s.progress == null ? '' : '@' + s.progress.toFixed(2)));
    box.dataset.log = log.slice(-60).join(' ');
  };
  window.kehikotAppUpdate = (s) => show(s, 'push');
  const mount = () => {
    box = document.createElement('div');
    box.id = 'kehikot-update-demo-harness';
    box.style.cssText = 'position:fixed;left:50%;top:44px;transform:translateX(-50%);z-index:99999;padding:8px 10px;border-radius:8px;' +
      'font:12px/1.4 ui-monospace,monospace;background:#ffd84d;color:#000;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    const title = document.createElement('div');
    title.textContent = 'KEHIKOT_UPDATE_DEMO harness (debug only)';
    title.style.fontWeight = '700';
    line = document.createElement('div');
    const check = document.createElement('button'); check.textContent = 'check_for_update';
    const apply = document.createElement('button'); apply.textContent = 'apply_update';
    check.onclick = () => invoke('check_for_update').then((s) => show(s, 'check'), (e) => { line.textContent = 'refused: ' + e; });
    apply.onclick = () => invoke('apply_update').catch((e) => { line.textContent = 'refused: ' + e; });
    box.append(title, line, check, ' ', apply);
    document.body.appendChild(box);
    new MutationObserver(() => { if (!box.isConnected) document.body.appendChild(box); })
      .observe(document.body, { childList: true });
    invoke('update_status').then((s) => show(s, 'status'), (e) => { line.textContent = 'update_status refused: ' + e; });
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
"#;
