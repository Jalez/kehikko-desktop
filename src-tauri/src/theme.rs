//! Light or dark, known by the native side because the native side paints
//! first.
//!
//! ## The flash this file exists to remove
//!
//! A person who runs Kehikot in the dark and quits it sees, on the next launch,
//! two white frames before their black canvas arrives. They come from two
//! different places and each needs its own answer:
//!
//!  1. **The window itself.** An `NSWindow` with no background colour is white,
//!     and it is on screen before a single byte of HTML has been parsed. No
//!     stylesheet can reach that frame; nothing running in a page can. The only
//!     thing that knows a colour early enough is the code that builds the
//!     window, which is Rust.
//!  2. **The waiting room.** `dist/index.html` used to paint itself with the
//!     system colours (`color-scheme: light dark; background: Canvas`), which
//!     follows the *operating system's* appearance rather than the person's
//!     Kehikot preference. On a light-mode Mac belonging to somebody who runs
//!     this workbench dark, that page is a white screen every single launch —
//!     correctly implemented, and completely wrong.
//!
//! The host's own page has neither problem: `index.html` in the host repository
//! decides the theme in a blocking script before the body exists, and states
//! the two background colours inline so the class has something to select. Its
//! comments are the long version of why.
//!
//! But it decides from a **cookie on `http://127.0.0.1:4181`**, and the waiting
//! room is served at `tauri://localhost`. Different origin, no cookie, nothing
//! to read. That is why this shell has to be *told* rather than being able to
//! look.
//!
//! ## Which copy is the truth
//!
//! **The host's cookie is the truth. This file is an echo of it**, and it is
//! named that way on purpose: `remembered()` is "what the host's page last told
//! us it was showing", not "what the theme is".
//!
//! That distinction settles every awkward case. The shell never computes a
//! theme, never consults the system appearance, and never writes the cookie —
//! it only ever repeats back the last word it was given. So when the two
//! disagree (the person toggled the theme in a browser tab while this app was
//! closed; the file was hand-edited; it was never written) the host wins the
//! moment its page loads, because that page paints itself from its own cookie
//! and does not ask us. The cost of a disagreement is therefore exactly one
//! wrong frame in the waiting room — and it repairs itself, because the host's
//! page reports what it decided as soon as it is up (`announce()` in the host's
//! `src/host/theme.ts`). A disagreement survives one launch and not two.
//!
//! Two *implementations* of one decision would be a different and much worse
//! thing — they disagree exactly in the cases hardest to reproduce, which is
//! the argument `src/host/theme.ts` makes at length. There is still only one
//! decision, made in one blocking script in the host's `index.html`. This is a
//! cache of its answer, and a cache that is wrong is stale rather than
//! contradictory.
//!
//! ## Where it is kept, and why not in `config.json`
//!
//! A one-word file, `~/.config/kehikko-desktop/theme`, beside the config file
//! that `host::config_path()` already names.
//!
//! Not *inside* `config.json`, which is the tempting place and the wrong one:
//! that file is written by a person, by hand, and holds the two things a person
//! chooses (`hostDir`, `apiPort`). Rewriting it on every theme toggle means a
//! program reformatting somebody's hand-written file — losing their key order,
//! their whitespace, anything the five-line reader in `host.rs` does not model
//! — in order to record something they never typed. Configuration is what you
//! were asked for; this is what was observed, and the two do not belong in one
//! document.
//!
//! Not Tauri's store plugin either. That is a dependency, a capability entry
//! and a JSON document in an app-data directory nothing else in this shell
//! uses, in exchange for holding four bytes that `read_to_string` already
//! holds. If a second remembered fact ever appears, take the dependency then.

use std::path::PathBuf;
use tauri::window::Color;

/// The theme, as the shell knows it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Theme {
    Dark,
    Light,
}

impl Theme {
    /// The word the host uses, which is also the whole content of the file.
    pub fn word(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
        }
    }

    /// The window's first frame.
    ///
    /// The same two colours the host's `index.html` states inline —
    /// `oklch(0 0 0)` and `oklch(1 0 0)`, which are exactly black and exactly
    /// white, so there is no colour conversion here to get subtly wrong. That
    /// page's comment already says its two values are the only duplication of
    /// the palette; this is the second copy of the duplication, and it is here
    /// because a window is painted by AppKit and AppKit does not read
    /// stylesheets. If `--background` in the host's `index.css` ever moves off
    /// the ends of the scale, it changes in three places.
    pub fn color(self) -> Color {
        match self {
            Theme::Dark => Color(0, 0, 0, 255),
            Theme::Light => Color(255, 255, 255, 255),
        }
    }
}

/// Read a word, and be unsurprised by anything else.
///
/// Anything that is not one of the two words is not a theme, so it is not
/// obeyed. There is no third state worth representing and no error worth
/// reporting: the only consumer wants a colour, and the answer to "that file
/// says something I do not understand" is the same as the answer to "nobody has
/// said anything yet".
fn parse(word: &str) -> Option<Theme> {
    match word.trim() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}

/// Where the echo lives: beside the config file, never in it.
fn path() -> PathBuf {
    crate::host::config_path().with_file_name("theme")
}

/// What the host's page last said it was showing — dark until it says otherwise.
///
/// **Dark on a first run, and deliberately not the system appearance.** The
/// host defaults to dark when it finds no cookie and defends that at length in
/// its `index.html`: this workbench is designed around a black canvas, and
/// following the OS would make somebody's first impression depend on a setting
/// they made about a different program.
///
/// If this shell followed the OS instead, a first launch on a light-mode Mac
/// would paint white and then turn black the instant the host's page loaded.
/// The flash would not be fixed; it would have moved. Two defaults that are not
/// the same default are a flash by construction, so this one is dark.
pub fn remembered() -> Theme {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|word| parse(&word))
        .unwrap_or(Theme::Dark)
}

/// Write the word down, and shrug if it cannot be written.
///
/// Best effort throughout, because the worst consequence of failing is one
/// wrong frame on some future launch, and there is nobody to tell: this runs
/// off an IPC call whose result the page does not look at, in a program with no
/// settings screen to show an error in.
///
/// Written in place rather than through a temporary file and a rename. A torn
/// write leaves something that is neither `dark` nor `light`, `parse` refuses
/// it, and `remembered()` falls back to dark — so the failure mode of the
/// careless version is the failure mode of having no file at all, which is the
/// state this program starts life in anyway.
pub fn remember(theme: Theme) {
    let path = path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, theme.word());
}

/// The word the page sent us, if it was one of the two.
pub fn from_page(word: &str) -> Option<Theme> {
    parse(word)
}

/// Hand the theme to the page before the page is parsed.
///
/// Injected as an initialization script, which runs after the global object
/// exists and before the document is — the same hook `titlebar::script()` uses,
/// for the same reason: it is the only moment early enough to matter.
///
/// It sets a global rather than touching the DOM, because at document start
/// there reliably is a `window` and there is not reliably a
/// `document.documentElement`. The waiting room reads the global from a
/// blocking script in its own `<head>`, exactly as the host's page reads its
/// cookie there, and for exactly the same reason.
///
/// **The name says whose fact this is.** `__kehikkoDesktopTheme` is "the colour
/// this shell painted the window with" — a report of what the native side did,
/// not an instruction, and specifically not something the host's page should
/// ever read in place of its own cookie. The host's page will see this global
/// too, because initialization scripts run on every top-level navigation, and
/// it must go on ignoring it. One decision, and it is the host's.
///
/// Main frame only, like the title-bar injection, so no module ever sees it.
pub fn script(theme: Theme) -> String {
    format!(
        "if (window.top === window.self) window.__kehikkoDesktopTheme = {:?};",
        theme.word()
    )
}
