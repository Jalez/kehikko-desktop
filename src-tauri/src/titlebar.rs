//! Making the host's own strip *be* the window's title bar.
//!
//! ## What this is for
//!
//! With an ordinary title bar the window has two strips at the top: an empty
//! grey one with three lights in it, and, under it, the host's 32-pixel header
//! holding the project, the kehikko and the controls. Two strips where one
//! would do, and the top one carries no information at all.
//!
//! So the window is built with `TitleBarStyle::Overlay` and a hidden title: the
//! page extends to the top of the window and the three lights float over it.
//! That is one config line. Everything below is the consequence — because the
//! lights now sit exactly on top of the host's project control.
//!
//! ## Why this is an injection, and what is wrong with that
//!
//! The right place for this is the host: a class on its header when it notices
//! it is inside a desktop shell, and a rule in its own stylesheet. That is a
//! change to a repository this program is not allowed to make, so instead the
//! shell injects a stylesheet and a script into the page before it loads.
//!
//! Be clear about the cost. **This is a program reaching into somebody else's
//! page and matching on its markup.** It finds the header by structure — the
//! first `<header>` that is not inside `<main>`, because container headers are
//! `<header>` too — and if that structure changes, the match silently stops
//! matching and the lights land back on top of the project control. The
//! injection is written to make that failure *loud* rather than silent (it
//! appends to the window title, which the shell then reads and prints), but
//! loud is not the same as fixed. See the README for the host-side change this
//! should be replaced by.
//!
//! ## The two numbers
//!
//! `env(titlebar-area-*)` — the principled source — belongs to Window Controls
//! Overlay, and WKWebView does not implement it. That was measured rather than
//! assumed, and the measurement has a trap in it: `CSS.supports('left',
//! 'env(titlebar-area-x)')` answers **true**, because `env()` with a fallback is
//! valid syntax whether or not the variable exists. Resolving it is what tells
//! you: with a `-1px` fallback the computed value comes back `-1px`, the width
//! and height come back `0px`, and `navigator.windowControlsOverlay` is
//! undefined. So there is nothing to read and the inset is a constant.
//!
//! Here is where the constant comes from: the three lights are 12pt circles at
//! 20pt spacing beginning 20pt from the left edge, so the last one ends at 72;
//! `INSET` is that plus a gap. The band they sit in is 28pt tall and the host's
//! header is 32, so nothing needed to grow. Confirmed on the live page: with
//! the inset applied, the first control's left edge is at x=82 and the point
//! where the lights are hits the header itself rather than any control.

/// How far the host's header must be pushed right so it clears the lights.
pub const INSET: u32 = 82;

pub fn script() -> String {
    SCRIPT.replace("__INSET__", &INSET.to_string())
}

const SCRIPT: &str = r#"
(() => {
  // Top-level page only.
  //
  // Measured: Tauri's initialization scripts do NOT reach subframes on
  // WKWebView — a same-origin iframe of the host, opened inside the host page,
  // has neither this stylesheet nor `__TAURI_INTERNALS__` in it. So a module
  // never sees this script and cannot call a window command either.
  //
  // The guard stays anyway, because that is a wry implementation detail and not
  // a promise, and the failure if it changed is not subtle: every module has a
  // header of its own, so the shell would push 82 pixels into somebody else's
  // toolbar and mark it as a window-drag region — a press on a module's button
  // would move the window. Running this script on a module page at top level
  // does exactly that, which is how the shape of the failure is known.
  if (window.top !== window.self) return;

  const INSET = __INSET__;
  const MARK = 'kehikkoTitlebar';

  // The stylesheet goes in first and unconditionally, so that the moment the
  // header appears it is already inset — rather than drawn under the lights for
  // a frame and then jumping.
  const style = document.createElement('style');
  style.dataset.kehikkoDesktop = 'titlebar';
  style.textContent = `
    :root { --kehikko-titlebar-inset: ${INSET}px; }
    :root[data-kehikko-fullscreen="yes"] { --kehikko-titlebar-inset: 0px; }
    header[data-kehikko-titlebar] {
      padding-left: var(--kehikko-titlebar-inset) !important;
      transition: padding-left 120ms ease-out;
    }
    /* The lights are drawn by the system over the page, so nothing in the page
       may sit above them in the stacking order and eat their clicks. */
    header[data-kehikko-titlebar] { position: relative; z-index: 0; }
  `;
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.head) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle, { once: true });

  // The host's own strip: the first <header> that is not a container's. Both
  // are <header> elements; only the container ones live inside <main>.
  const barOf = () => [...document.querySelectorAll('header')].find(h => !h.closest('main'));

  let applied = false;
  const apply = () => {
    const bar = barOf();
    if (!bar) return false;
    bar.setAttribute('data-kehikko-titlebar', '');

    // Dragging. Tauri moves the window when the mousedown lands on an element
    // carrying `data-tauri-drag-region` — the element itself, not an ancestor.
    // So the header gets it, and so does every child that is empty space: the
    // flex spacer, and any element with no text and no controls under it.
    // Buttons deliberately do not, or every press would move the window.
    bar.setAttribute('data-tauri-drag-region', '');
    for (const el of bar.children) {
      const interactive = el.matches('button, a, input, select, textarea, [role="button"], [tabindex]')
        || el.querySelector('button, a, input, select, textarea, [role="button"], [tabindex]');
      const empty = el.textContent.trim() === '' && !el.querySelector('svg, img');
      if (!interactive && empty) el.setAttribute('data-tauri-drag-region', '');
      else el.removeAttribute('data-tauri-drag-region');
    }
    return true;
  };

  const settle = () => {
    if (apply()) {
      if (!applied) {
        applied = true;
        document.documentElement.dataset[MARK] = 'applied';
      }
    }
  };

  // The header is React-rendered and re-renders whenever the project, the
  // kehikko or the module list changes — and a re-render drops the attributes,
  // because they are not in the host's JSX. So this watches rather than runs
  // once. A `MutationObserver` on the subtree is the cheap version of "whenever
  // that strip is rebuilt, mark it again".
  const observer = new MutationObserver(() => settle());
  const start = () => {
    settle();
    observer.observe(document.body, { childList: true, subtree: true });
    // If it never appears, say so where somebody will see it. A silent failure
    // here is three lights sitting on top of the project control, which looks
    // like a bug in the host rather than in this shell.
    setTimeout(() => {
      if (!applied) {
        document.documentElement.dataset[MARK] = 'missing';
        document.title = document.title + ' [no header matched]';
        console.error('kehikko-desktop: no host header matched, so the traffic lights are over the page. The injection in titlebar.rs matches the first <header> outside <main>; the host page has changed shape.');
      }
    }, 5000);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
"#;

/// Tell the page whether the window is fullscreen.
///
/// In fullscreen macOS takes the lights away, and an inset that was right in a
/// window becomes a permanent 82-pixel gap where they used to be. This is
/// driven from Rust rather than from a media query because WKWebView has no
/// media query for it: `display-mode: fullscreen` is a PWA feature and reports
/// `browser` here, measured, not assumed.
pub fn fullscreen_script(on: bool) -> String {
    format!(
        "document.documentElement.dataset.kehikkoFullscreen = {:?}",
        if on { "yes" } else { "no" }
    )
}
