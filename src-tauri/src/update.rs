//! Updating the app in place, from GitHub Releases.
//!
//! The app and the host it carries are one release: a new version replaces
//! `Kehikot.app` whole, sidecar included, so the bundled host never updates
//! itself — this is the only updater in a release build.
//!
//! The shape of it, deliberately small:
//!
//! - **In the background, after launch.** The window and the host start exactly
//!   as they would offline; the check runs on its own thread and a failure —
//!   no network, GitHub down, a bad signature — is a line on stderr and
//!   nothing else. An updater that can stop the app starting is worse than none.
//! - **Asked, not imposed.** A native dialog says which version is available and
//!   offers "Install and restart" or "Later". Restarting stops the host and
//!   every module it started; that is the person's call, not ours, because they
//!   may be in the middle of something. "Later" means the next launch asks again.
//! - **Verified.** `tauri-plugin-updater` refuses an archive whose minisign
//!   signature does not match the public key in `tauri.conf.json`, so a
//!   compromised download location cannot ship code. That holds without Apple
//!   signing; the two are independent.
//!
//! The endpoint and key live in `tauri.conf.json` (`plugins.updater`). No IPC:
//! the page knows nothing of this and no capability grants it anything.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Check for an update on a thread of its own. Never blocks startup and never
/// fails it.
pub fn check_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        // A few seconds' grace, so the question does not arrive on top of the
        // waiting room's first frame.
        std::thread::sleep(std::time::Duration::from_secs(5));
        if let Err(e) = tauri::async_runtime::block_on(check(&app)) {
            eprintln!("kehikko-desktop: update check failed: {e}");
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };

    let mut message = format!(
        "Kehikot {} is available — you have {}.\n\nInstalling it restarts the app, which stops the host and the modules it started.",
        update.version, update.current_version
    );
    if let Some(notes) = update.body.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let notes: String = notes.chars().take(600).collect();
        message.push_str("\n\n");
        message.push_str(&notes);
    }

    let mut dialog = app
        .dialog()
        .message(message)
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".into(),
            "Later".into(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    // On this thread, not the main one: `blocking_show` waits for an answer
    // the main thread's event loop has to deliver.
    if !dialog.blocking_show() {
        return Ok(());
    }

    eprintln!("kehikko-desktop: downloading Kehikot {}", update.version);
    update.download_and_install(|_, _| {}, || {}).await?;

    // Stop what we started before we go: `restart()` does not pass through the
    // exit events that normally reap the host, and the new version would find
    // the old host still on its port and adopt it.
    crate::reap();
    app.restart();
}
