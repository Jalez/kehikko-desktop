//! Relaunching the app — after an update, or when the host asks for a restart —
//! so that it comes back in front, with its window.
//!
//! ## What went wrong
//!
//! Both restarts used to end in Tauri's `AppHandle::restart()`. On macOS that
//! runs the bundle's executable directly (`Command::new(…/Contents/MacOS/…)`,
//! `tauri::process::restart`) and exits. A program started that way is not
//! launched by LaunchServices, so nothing activates it: tao asks for activation
//! itself (`activateIgnoringOtherApps:` when it finishes launching), but since
//! macOS 14 activation is cooperative and that request is refused for a process
//! the person did not open. The old copy — the app they had just pressed
//! Restart in — has exited by then, so another app is frontmost. The new copy
//! ends up running with its window behind everything else, and the person
//! sees only its icon in the Dock and believes it never came back.
//!
//! ## What it does now
//!
//! From a bundle on macOS, the new copy is opened the way Finder opens it:
//! `open -n -a Kehikot.app`, from the old copy's last exit event, as Tauri
//! starts its own. LaunchServices brings an app it opens to the front, even
//! when what asked is not frontmost (checked: `open -n -a Console.app` from a
//! background shell left Console frontmost). `open` passes our
//! environment on (`man open`: opened applications inherit it), so a
//! `KEHIKKO_HOST_DIR` or `KEHIKKO_PORT` from a terminal survives the restart,
//! and the arguments go on after `--args`. `-a` names the bundle, not the
//! executable, so a release whose executable is named differently still opens.
//!
//! Anywhere else — `tauri dev`, a binary outside a bundle — and whenever
//! `open` fails, the executable is started directly, as before.
//!
//! Either way the new copy is told it is a relaunch (`MARK`), and shows,
//! unminimises and focuses its window on its own (`bring_forward`): a second
//! request for the front, for the path LaunchServices did not take.
//!
//! There is no start-hidden mode to keep apart from this: the window is always
//! built visible and the app has no tray icon or launch-at-login. If one is
//! added, a launch with `MARK` set is one the person asked for, and shows.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow};

/// Set in the new copy's environment by the copy that relaunched it. Plumbing
/// between two copies of this shell, so it keeps the shell's `KEHIKKO_` name.
pub const MARK: &str = "KEHIKKO_RELAUNCHED";

/// How the new copy is started.
#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    /// Through LaunchServices, which activates what it opens. `exe` is kept
    /// for when `open` fails.
    Services { bundle: PathBuf, exe: PathBuf, args: Vec<OsString> },
    /// The executable itself, as Tauri's `restart()` does.
    Direct { exe: PathBuf, args: Vec<OsString> },
}

/// The `.app` an executable lives in, when it lives in one:
/// `<x>.app/Contents/MacOS/<name>`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle.extension().is_some_and(|e| e == "app");
    if macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && is_app {
        Some(bundle.to_path_buf())
    } else {
        None
    }
}

/// Decide how to start the new copy. `args` are the running copy's arguments
/// without the program name; `macos` is passed in so both answers can be
/// tested on any machine.
pub fn plan(exe: &Path, args: &[OsString], macos: bool) -> Launch {
    match bundle_of(exe) {
        Some(bundle) if macos => Launch::Services { bundle, exe: exe.to_path_buf(), args: args.to_vec() },
        _ => Launch::Direct { exe: exe.to_path_buf(), args: args.to_vec() },
    }
}

/// The arguments for `/usr/bin/open`: a new instance even though this one is
/// still running, the mark, then our own arguments.
pub fn open_args(bundle: &Path, args: &[OsString]) -> Vec<OsString> {
    let mut out: Vec<OsString> = vec!["-n".into(), "-a".into(), bundle.into(), "--env".into()];
    out.push(format!("{MARK}=1").into());
    if !args.is_empty() {
        out.push("--args".into());
        out.extend(args.iter().cloned());
    }
    out
}

/// Whether this launch is a relaunch this shell made, from the value of `MARK`.
pub fn is_relaunch(mark: Option<&OsStr>) -> bool {
    mark.is_some_and(|v| v == "1")
}

/// Read the mark once, at start, and take it out of the environment, so it
/// does not reach the host and the modules it starts, and a later ordinary
/// launch from this process's children is not mistaken for one. Called before
/// any thread is started.
pub fn take_mark() -> bool {
    let relaunched = is_relaunch(std::env::var_os(MARK).as_deref());
    std::env::remove_var(MARK);
    relaunched
}

/// Show the window and ask for the front: a relaunch is a launch the person
/// asked for, and must never leave them with only an icon in the Dock.
pub fn bring_forward(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    // On macOS: `makeKeyAndOrderFront:` and an activation request for the app.
    let _ = window.set_focus();
}

/// Whether the exit under way is a relaunch.
static ON_EXIT: AtomicBool = AtomicBool::new(false);

/// Quit, and start the new copy on the way out. The host must already be
/// reaped and any update installed: this does neither.
///
/// Called from a background thread (the updater's, the restart watcher's), so
/// the quit is asked of the event loop, which runs the exit events and then
/// `start_if_asked`; this thread waits for the process to end. The new copy
/// starts after this one's exit events, as with Tauri's `restart()`, not beside
/// a copy still running.
pub fn relaunch(app: &AppHandle) -> ! {
    ON_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
    loop {
        std::thread::park();
    }
}

/// From `RunEvent::Exit`: start the new copy if this exit is a relaunch.
pub fn start_if_asked(app: &AppHandle) {
    if !ON_EXIT.swap(false, Ordering::SeqCst) {
        return;
    }
    let env = app.env();
    let args: Vec<OsString> = env.args_os.iter().skip(1).cloned().collect();
    let started = match tauri::process::current_binary(&env) {
        Ok(exe) => start(&plan(&exe, &args, cfg!(target_os = "macos"))),
        Err(e) => {
            eprintln!("kehikko-desktop: could not find this app's executable to relaunch it: {e}");
            false
        }
    };
    if !started {
        // Tauri's own way, which at least starts something. On the main
        // thread, where the exit events run, it does not return.
        app.restart();
    }
}

fn start(launch: &Launch) -> bool {
    match launch {
        Launch::Services { bundle, exe, args } => {
            // `status`, not `spawn`: `open` returns once the app has launched,
            // and a failure here still leaves time to start it directly.
            match Command::new("/usr/bin/open").args(open_args(bundle, args)).status() {
                Ok(status) if status.success() => true,
                Ok(status) => {
                    eprintln!("kehikko-desktop: `open` could not relaunch {} ({status}); starting it directly", bundle.display());
                    direct(exe, args)
                }
                Err(e) => {
                    eprintln!("kehikko-desktop: could not run `open` to relaunch {}: {e}; starting it directly", bundle.display());
                    direct(exe, args)
                }
            }
        }
        Launch::Direct { exe, args } => direct(exe, args),
    }
}

/// Start the executable itself. When it is gone — an update that renamed it —
/// this fails, and `relaunch` falls back to Tauri's `restart()`, which reads
/// the new name from the bundle's `Info.plist`.
fn direct(exe: &Path, args: &[OsString]) -> bool {
    match Command::new(exe).args(args).env(MARK, "1").spawn() {
        Ok(_) => true,
        Err(e) => {
            eprintln!("kehikko-desktop: could not relaunch {}: {e}", exe.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/Applications/Kehikot.app/Contents/MacOS/kehikko-desktop";

    #[test]
    fn an_executable_in_a_bundle_is_found_in_it() {
        assert_eq!(bundle_of(Path::new(EXE)), Some(PathBuf::from("/Applications/Kehikot.app")));
    }

    #[test]
    fn an_executable_outside_a_bundle_has_none() {
        assert_eq!(bundle_of(Path::new("/Users/me/kehikko-desktop/src-tauri/target/debug/kehikko-desktop")), None);
        assert_eq!(bundle_of(Path::new("/Applications/Kehikot/Contents/MacOS/kehikko-desktop")), None);
        assert_eq!(bundle_of(Path::new("/Applications/Kehikot.app/Contents/Resources/kehikko-desktop")), None);
        assert_eq!(bundle_of(Path::new("kehikko-desktop")), None);
    }

    #[test]
    fn a_bundle_on_macos_is_relaunched_through_launch_services() {
        let args = vec![OsString::from("--flag")];
        assert_eq!(
            plan(Path::new(EXE), &args, true),
            Launch::Services { bundle: "/Applications/Kehikot.app".into(), exe: EXE.into(), args: args.clone() }
        );
    }

    #[test]
    fn a_dev_build_or_another_platform_is_started_directly() {
        let dev = Path::new("/w/src-tauri/target/debug/kehikko-desktop");
        assert_eq!(plan(dev, &[], true), Launch::Direct { exe: dev.into(), args: vec![] });
        assert_eq!(plan(Path::new(EXE), &[], false), Launch::Direct { exe: EXE.into(), args: vec![] });
    }

    #[test]
    fn open_opens_a_new_instance_in_front_with_the_mark_and_the_arguments() {
        let got = open_args(Path::new("/Applications/Kehikot.app"), &["a b".into(), "--c".into()]);
        let want: Vec<OsString> = ["-n", "-a", "/Applications/Kehikot.app", "--env", "KEHIKKO_RELAUNCHED=1", "--args", "a b", "--c"]
            .iter()
            .map(OsString::from)
            .collect();
        assert_eq!(got, want);
        // Never `-g` (stay in the background) or `-j` (launch hidden).
        assert!(!got.iter().any(|a| a == "-g" || a == "-j"));
    }

    #[test]
    fn open_without_arguments_passes_no_args_flag() {
        let got = open_args(Path::new("/Applications/Kehikot.app"), &[]);
        assert!(!got.iter().any(|a| a == "--args"));
    }

    #[test]
    fn only_the_mark_we_set_counts_as_a_relaunch() {
        assert!(is_relaunch(Some(OsStr::new("1"))));
        assert!(!is_relaunch(None));
        assert!(!is_relaunch(Some(OsStr::new(""))));
        assert!(!is_relaunch(Some(OsStr::new("0"))));
    }
}
