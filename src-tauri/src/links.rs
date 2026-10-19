//! A link that asks for a new window opens in the person's browser.
//!
//! Modules link out all the time — a pull request, an issue, a merge request —
//! with `<a target="_blank">` or `window.open`, from pages framed inside the
//! host. In a browser tab that opens a tab. In this window it opened nothing:
//! WKWebView only makes a new window when the app hands it one, and this app
//! handed it nothing, so the click was swallowed without a word (Journeys
//! issue #31; References had the same dead link).
//!
//! So every request for a new window is answered here, and always with "no":
//! a second window of this app would be a bare webview with none of the
//! shell's care (titlebar, theme, the update contract). Instead an address a
//! browser is for — `http`, `https`, `mailto` — is handed to the operating
//! system's own opener, which is the person's default browser or mail app.
//! Anything else (`file:`, `javascript:`, a custom scheme) is refused and
//! logged: a page framed here does not get to make this app open things on
//! the machine.
//!
//! The URL is one argument to `open`; nothing goes through a shell.

use std::process::Command;

/// Whether a new-window request for `url` is one this app hands to the browser.
pub fn opens(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Hand `url` to the operating system's opener. Never blocks the window.
pub fn open_outside(url: &tauri::Url) {
    if !opens(url) {
        eprintln!("kehikot: a page asked for a new window at a {}: address; refused", url.scheme());
        return;
    }
    #[cfg(target_os = "macos")]
    let opener = "/usr/bin/open";
    #[cfg(target_os = "linux")]
    let opener = "xdg-open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    if let Err(error) = Command::new(opener).arg(url.as_str()).spawn() {
        eprintln!("kehikot: could not open {url} in the browser: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::opens;

    fn url(s: &str) -> tauri::Url {
        s.parse().expect("a URL")
    }

    #[test]
    fn web_addresses_go_to_the_browser() {
        assert!(opens(&url("https://github.com/Jalez/kehikko/pull/93")));
        assert!(opens(&url("http://example.com/x")));
        assert!(opens(&url("mailto:someone@example.com")));
    }

    #[test]
    fn nothing_else_is_opened() {
        assert!(!opens(&url("file:///etc/passwd")));
        assert!(!opens(&url("javascript:alert(1)")));
        assert!(!opens(&url("x-apple.systempreferences:com.apple.preference")));
        assert!(!opens(&url("tauri://localhost/index.html")));
    }
}
