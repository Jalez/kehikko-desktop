//! The instrument that produced the WebKit table in the README.
//!
//! This is not part of the shell. It is a second, throwaway window that visits
//! the host page and each module's own page in WKWebView, runs a script in
//! each, and posts what it found to a listener on 127.0.0.1:4999. It exists
//! because the alternative — "it looked fine" — is how a workspace ends up with
//! a table of claims nobody measured.
//!
//! It starts nothing and stops nothing. Point it at a host that is already up.
//!
//!     cargo run --example webkit-probe -- http://127.0.0.1:4181 http://127.0.0.1:7870 …
//!
//! Each URL is visited in the same window in turn: navigating makes the page
//! same-origin with the script, which is the only way to look inside a module.
//! From the host page a module is a cross-origin iframe and nothing about its
//! layout can be read — which is exactly why this walks the list instead of
//! reading the canvas.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PROBE: &str = r#"
(async () => {
  const send = (o) => { try { const x = new XMLHttpRequest(); x.open('POST', 'http://127.0.0.1:4999/', true); x.send(JSON.stringify(o)); } catch (e) {} };
  send({ stage: 'reached', href: location.href });
  try {
  const out = { href: location.href, ua: navigator.userAgent };

  send({stage:'mark',n:1});
  // --- @container -----------------------------------------------------------
  out.supportsContainerType = CSS.supports('container-type', 'inline-size');
  out.supportsContainerQueryUnits = CSS.supports('width', '10cqi');

  // Does a container query actually take effect, or merely parse?
  const host = document.createElement('div');
  host.style.cssText = 'container-type:inline-size;width:600px;position:fixed;left:-9999px;top:0';
  const kid = document.createElement('div');
  kid.id = 'cq-probe-kid';
  host.appendChild(kid);
  const style = document.createElement('style');
  style.textContent = '#cq-probe-kid{height:10px}@container (min-width: 500px){#cq-probe-kid{height:77px}}';
  document.head.appendChild(style);
  document.body.appendChild(host);
  await new Promise(r => setTimeout(r, 150));
  out.containerQueryApplies = getComputedStyle(kid).height === '77px';
  host.style.width = '300px';
  await new Promise(r => setTimeout(r, 150));
  out.containerQueryReacts = getComputedStyle(kid).height === '10px';
  host.remove(); style.remove();

  send({stage:'mark',n:2});
  // Named containers, which is the form the modules actually use
  // (`container: container / inline-size`, queried as `@container container`).
  const named = document.createElement('div');
  named.style.cssText = 'container:probecontainer / inline-size;width:600px;position:fixed;left:-9999px';
  const nkid = document.createElement('div');
  nkid.id = 'cq-named-kid';
  named.appendChild(nkid);
  const nstyle = document.createElement('style');
  nstyle.textContent = '#cq-named-kid{height:10px}@container probecontainer (min-width: 34rem){#cq-named-kid{height:88px}}';
  document.head.appendChild(nstyle);
  document.body.appendChild(named);
  await new Promise(r => setTimeout(r, 150));
  out.namedContainerQueryApplies = getComputedStyle(nkid).height === '88px';
  named.remove(); nstyle.remove();

  send({stage:'mark',n:3});
  // --- what THIS page's own stylesheets contain -----------------------------
  // Counting the real rules, not a synthetic one: a module whose Tailwind build
  // emitted no @container rule at all would pass every test above and still lay
  // out wrong.
  let containerRules = 0, containerAtRules = 0, unreadableSheets = 0;
  const walk = (rules) => {
    for (const r of rules) {
      const t = (r.cssText || '').slice(0, 12).toLowerCase();
      if (t.startsWith('@container')) containerAtRules++;
      if (r.style && r.style.containerType) containerRules++;
      if (r.cssRules) { try { walk(r.cssRules) } catch (e) {} }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules) } catch (e) { unreadableSheets++ }
  }
  out.containerAtRulesInPage = containerAtRules;
  out.containerTypeDeclarationsInPage = containerRules;
  out.unreadableSheets = unreadableSheets;

  // Anything on the live page that declares itself a container
  out.liveContainerElements = [...document.querySelectorAll('*')]
    .filter(el => getComputedStyle(el).containerType !== 'normal').length;

  send({stage:'mark',n:4});
  // --- the other things the workbench leans on ------------------------------
  out.hasResizeObserver = typeof ResizeObserver === 'function';
  if (out.hasResizeObserver) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-9999px;width:100px;height:100px';
    document.body.appendChild(box);
    out.resizeObserverFired = await new Promise(res => {
      let done = false;
      const ro = new ResizeObserver(() => { if (!done) { done = true; ro.disconnect(); res(true) } });
      ro.observe(box);
      setTimeout(() => { if (!done) { done = true; ro.disconnect(); res(false) } }, 1000);
    });
    box.remove();
  }
  out.hasWebSocket = typeof WebSocket === 'function';
  out.hasOffscreenCanvas = typeof OffscreenCanvas === 'function';
  // Attached, and on screen: a detached canvas reports no WebGL in WKWebView
  // and that would have been recorded as "WebGL is broken".
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  c.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;opacity:0.01';
  document.body.appendChild(c);
  out.canvas2d = !!c.getContext('2d');
  const c2 = document.createElement('canvas');
  c2.width = 64; c2.height = 64;
  c2.style.cssText = c.style.cssText;
  document.body.appendChild(c2);
  out.webgl2 = !!c2.getContext('webgl2');
  const c3 = document.createElement('canvas');
  c3.width = 64; c3.height = 64;
  c3.style.cssText = c.style.cssText;
  document.body.appendChild(c3);
  out.webgl1 = !!c3.getContext('webgl');
  c.remove(); c2.remove(); c3.remove();

  out.visibility = document.visibilityState;
  out.rafFires = await new Promise(res => {
    let done = false;
    requestAnimationFrame(() => { if (!done) { done = true; res(true) } });
    setTimeout(() => { if (!done) { done = true; res(false) } }, 1500);
  });

  // A4 under a transform: the shape Paper uses for a page.
  const a4 = document.createElement('div');
  a4.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;height:1123px;transform:scale(0.5);transform-origin:top left';
  document.body.appendChild(a4);
  const ar = a4.getBoundingClientRect();
  out.a4Scaled = [Math.round(ar.width), Math.round(ar.height)];
  out.a4Untransformed = [a4.offsetWidth, a4.offsetHeight];
  a4.remove();
  out.supportsHas = CSS.supports('selector(:has(a))');
  out.devicePixelRatio = devicePixelRatio;

  // The focus-mode reveal: an 8px strip that must be hoverable while its
  // ancestor is pointer-events:none and it opts back in.
  const outer = document.createElement('div');
  outer.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;pointer-events:none;z-index:99999';
  const strip = document.createElement('div');
  strip.style.cssText = 'width:8px;height:200px;pointer-events:auto;background:transparent';
  outer.appendChild(strip);
  document.body.appendChild(outer);
  out.pointerEventsOptIn = document.elementFromPoint(4, 100) === strip;
  outer.remove();

  send({stage:'mark',n:5});
  // --- iframes, and whether each one is actually showing anything ----------
  const frames = [...document.querySelectorAll('iframe')];
  out.iframes = frames.map(f => {
    const r = f.getBoundingClientRect();
    let reachable = false;
    try { reachable = !!f.contentWindow } catch (e) {}
    return { src: f.getAttribute('src'), w: Math.round(r.width), h: Math.round(r.height), sandbox: f.getAttribute('sandbox'), contentWindow: reachable };
  });

  // Anything the page logged as an error before we got here
  out.title = document.title;
  out.bodyChars = document.body.innerText.trim().length;
  out.bodyHead = document.body.innerText.trim().slice(0, 400);

  send(out);
  } catch (e) { send({ stage: 'threw', href: location.href, error: String(e && e.stack || e) }); }
})();
"#;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();

    // `--script FILE` runs that file in each page instead of the built-in
    // probe, which is how the title-bar measurements and the canvas walk were
    // taken without adding an eval hatch to the shell itself.
    let mut script = PROBE.to_string();
    if let Some(i) = args.iter().position(|a| a == "--script") {
        let path = args.remove(i + 1);
        args.remove(i);
        script = std::fs::read_to_string(&path).expect("script file");
    }
    // `--fullscreen` puts the window into fullscreen before the script runs,
    // which is the only way to check that the title-bar inset goes away when
    // the traffic lights do.
    let fullscreen = args.iter().any(|a| a == "--fullscreen");
    args.retain(|a| a != "--fullscreen");
    let urls: Vec<String> = args;
    if urls.is_empty() {
        eprintln!("usage: webkit-probe <url> [url…]");
        std::process::exit(2);
    }

    std::thread::spawn(collect);

    tauri::Builder::default()
        .setup(move |app| {
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kehikot")
                .inner_size(1440.0, 900.0)
                .initialization_script(kehikko_desktop_lib::titlebar_script())
                .on_page_load(|webview, _| {
                    let on = webview.is_fullscreen().unwrap_or(false);
                    let _ = webview.eval(&kehikko_desktop_lib::fullscreen_script(on));
                });
            #[cfg(target_os = "macos")]
            {
                b = b
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            let window = b.build()?;
            kehikko_desktop_lib::watch_fullscreen(&window);
            if fullscreen {
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let _ = w.set_fullscreen(true);
                });
            }
            let handle = app.handle().clone();
            let urls = urls.clone();
            let script = script.clone();
            std::thread::spawn(move || {
                for url in urls {
                    eprintln!("probe: navigating to {url}");
                    if let Some(w) = handle.get_webview_window("main") {
                        match w.navigate(url.parse().unwrap()) {
                            Ok(()) => eprintln!("probe: navigate ok"),
                            Err(e) => eprintln!("probe: navigate failed: {e}"),
                        }
                    } else {
                        eprintln!("probe: no window!");
                    }
                    // Long enough for a module to boot, handshake and lay out.
                    std::thread::sleep(Duration::from_secs(6));
                    if let Some(w) = handle.get_webview_window("main") {
                        match w.eval(&script) {
                            Ok(()) => eprintln!("probe: eval dispatched"),
                            Err(e) => eprintln!("probe: eval failed: {e}"),
                        }
                    }
                    let hold: u64 = std::env::var("PROBE_HOLD")
                        .ok()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(4);
                    std::thread::sleep(Duration::from_secs(hold));
                }
                std::process::exit(0);
            });
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("probe");
}

/// The smallest thing that can be POSTed to. Prints the body and answers with
/// permissive CORS, because every page it hears from is a different origin.
fn collect() {
    let listener = match TcpListener::bind("127.0.0.1:4999") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("probe: nothing can listen on 4999: {e}");
            return;
        }
    };
    for stream in listener.incoming().flatten() {
        let mut stream = stream;
        let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
        // Read until the body is as long as the headers said. A single `read`
        // is the bug that cost an hour here: the headers arrive in one segment
        // and the JSON in the next, so the first read looked like an empty POST.
        let mut text = String::new();
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    text.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let want = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().ok()))
                            .flatten()
                            .unwrap_or(0);
                        if body.len() >= want {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if let Some((_, body)) = text.split_once("\r\n\r\n") {
            if !body.trim().is_empty() {
                println!("PROBE {body}");
            }
        }
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\n\r\nok",
        );
    }
}
