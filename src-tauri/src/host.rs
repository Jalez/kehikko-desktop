//! Where the host is, whether it is already up, how to start it, and — the part
//! this whole program exists for — how to make it stop.
//!
//! ## The measurement this file exists because of
//!
//! Eight module servers were found holding ports on this machine with nothing
//! left that had started them. Not a crash: an ordinary afternoon of closing a
//! browser tab. The tab was the only thing that looked like "the app", and
//! closing it stops nothing, because the servers were never the tab's to own.
//!
//! A window that owns a process is the whole difference between a workbench you
//! close and a workbench you close *and* a `lsof -i` afterwards.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// The API port. The page is always this plus one — `run.sh` computes it that
/// way (`--port "$((PORT + 1))"`) and nothing here is entitled to a different
/// opinion about it.
pub const DEFAULT_API_PORT: u16 = 4180;

/// The name of the environment variable every module reads to decide who may
/// frame it. See `origin_value()` for what we put in it and why it is a list.
pub const ORIGIN_VAR: &str = "ROADMAP_ORIGIN";

/// What we know about where to start the host, and how we came to know it.
pub struct Settings {
    pub dir: PathBuf,
    pub api_port: u16,
    /// Which of the three sources answered — said in the error page, because
    /// "the path is wrong" is useless without "and it came from here".
    pub source: String,
}

/// Read where the host lives. In order:
///
///  1. `$KEHIKKO_HOST_DIR` — for a second checkout, or a one-off.
///  2. `~/.config/kehikko-desktop/config.json`, `{"hostDir": "…", "apiPort": 4180}`.
///  3. `~/Projects/kehikko`, the default, which is right for exactly one person
///     and is a *guess* rather than an answer — so when the guess is wrong the
///     error page says it was a guess.
///
/// Deliberately not compiled in: a shell whose host directory is a constant is
/// a shell that has to be rebuilt to be moved, and this one is meant to be
/// handed to somebody whose checkout is somewhere else.
pub fn settings() -> Settings {
    if let Ok(dir) = std::env::var("KEHIKKO_HOST_DIR") {
        if !dir.trim().is_empty() {
            return Settings {
                dir: PathBuf::from(dir),
                api_port: port_from_env().unwrap_or(DEFAULT_API_PORT),
                source: "$KEHIKKO_HOST_DIR".into(),
            };
        }
    }

    let config = config_path();
    if let Ok(text) = std::fs::read_to_string(&config) {
        if let Some(dir) = json_string(&text, "hostDir") {
            return Settings {
                dir: PathBuf::from(expand_tilde(&dir)),
                api_port: json_number(&text, "apiPort")
                    .or_else(port_from_env)
                    .unwrap_or(DEFAULT_API_PORT),
                source: config.display().to_string(),
            };
        }
    }

    Settings {
        dir: home().join("Projects").join("kehikko"),
        api_port: port_from_env().unwrap_or(DEFAULT_API_PORT),
        source: "the default guess (~/Projects/kehikko)".into(),
    }
}

pub fn config_path() -> PathBuf {
    home()
        .join(".config")
        .join("kehikko-desktop")
        .join("config.json")
}

fn port_from_env() -> Option<u16> {
    std::env::var("KEHIKKO_API_PORT").ok()?.trim().parse().ok()
}

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest).display().to_string();
    }
    p.to_string()
}

/// A five-line reader for a two-key file. A JSON crate would be a dependency
/// carried for one object with two fields; if this file ever grows a third
/// shape, take the dependency then.
fn json_string(text: &str, key: &str) -> Option<String> {
    let at = text.find(&format!("\"{key}\""))?;
    let rest = &text[at + key.len() + 2..];
    let colon = rest.find(':')?;
    let open = rest[colon..].find('"')? + colon + 1;
    let close = rest[open..].find('"')? + open;
    Some(rest[open..close].to_string())
}

fn json_number(text: &str, key: &str) -> Option<u16> {
    let at = text.find(&format!("\"{key}\""))?;
    let rest = &text[at + key.len() + 2..];
    let colon = rest.find(':')? + 1;
    let digits: String = rest[colon..]
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Why a directory cannot be started, in the words the person needs. Every
/// variant names the fix, because "cannot start host" alone sends someone to
/// read this source.
pub enum Refusal {
    NoDirectory(PathBuf),
    NoScript(PathBuf),
    NotExecutable(PathBuf),
}

impl Refusal {
    pub fn sentence(&self) -> String {
        match self {
            Refusal::NoDirectory(p) => format!("There is no directory at {}.", p.display()),
            Refusal::NoScript(p) => format!(
                "{} exists, but has no run.sh in it — so it is probably not the Kehikot host.",
                p.display()
            ),
            Refusal::NotExecutable(p) => format!(
                "{} is not executable. `chmod +x` it and reopen this window.",
                p.display()
            ),
        }
    }
}

/// A directory is startable when it holds an executable `run.sh`. Nothing here
/// takes a command line: a configuration file that names a shell command is a
/// place to write shell, which is a much larger thing to put on a machine than
/// a path to a script somebody can go and read. The host's own `launch.ts`
/// argues this for modules; the same argument applies one level up.
pub fn startable(dir: &Path) -> Result<PathBuf, Refusal> {
    if !dir.is_dir() {
        return Err(Refusal::NoDirectory(dir.to_path_buf()));
    }
    let script = dir.join("run.sh");
    if !script.is_file() {
        return Err(Refusal::NoScript(dir.to_path_buf()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = script
            .metadata()
            .map(|m| m.permissions().mode())
            .unwrap_or(0);
        if mode & 0o111 == 0 {
            return Err(Refusal::NotExecutable(script));
        }
    }
    Ok(script)
}

/// Is something already answering on that port?
///
/// This is the difference between a shell that can be opened while you are
/// already working and one that fights you for 4181. A host that is already up
/// is *adopted*: not started, and — this is the important half — not stopped on
/// quit either. We only ever kill what we started.
pub fn listening(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(_) => true,
        Err(e) => !matches!(e.kind(), ErrorKind::ConnectionRefused | ErrorKind::TimedOut),
    }
}

/// What we put in `ROADMAP_ORIGIN`, and why it is four values rather than one.
///
/// Every module composes its own frame policy from this:
///
/// ```text
/// frame-ancestors 'self' ${process.env.ROADMAP_ORIGIN ?? 'http://127.0.0.1:4181 http://localhost:4181'}
/// ```
///
/// Note the `??`: setting this variable REPLACES the default rather than adding
/// to it. So a shell that set only its own origin would silently break the
/// browser tab — every container blank, in a window nobody was looking at,
/// for whoever opened <http://127.0.0.1:4181> next. The browser origins are
/// therefore carried along.
///
/// The `tauri://` and `http://tauri.localhost` entries cover the case where a
/// window loads a page Tauri itself serves. A window pointed at the host's own
/// http origin does not need them — its origin *is* `http://127.0.0.1:4181` —
/// but a future window that frames anything from the app's own protocol does,
/// and a variable that is right in both cases is cheaper than one that is right
/// today.
pub fn origin_value(page_port: u16) -> String {
    format!(
        "tauri://localhost http://tauri.localhost http://127.0.0.1:{p} http://localhost:{p}",
        p = page_port
    )
}

/// Start `run.sh`, in its own process group.
///
/// ## Why the process group, and not the child pid
///
/// `run.sh` ends in `exec bunx vite`. `exec` replaces the shell's image, so the
/// trap the script installed to kill its API child is gone the moment Vite
/// starts, and the API — `bun run server/server.ts` — is a child of a process
/// that no longer knows it exists. Kill the pid we hold and Vite dies while bun
/// keeps 4180 and every module the host started keeps its port. That is the
/// orphan, reproduced exactly.
///
/// So we put the whole tree in a fresh process group and signal the group. It
/// costs one line and it is the only version of this that leaves nothing
/// behind.
pub fn start(dir: &Path, script: &Path, api_port: u16) -> std::io::Result<Child> {
    let mut cmd = Command::new(script);
    cmd.current_dir(dir)
        .env("PORT", api_port.to_string())
        .env("PATH", launch_path())
        .env(ORIGIN_VAR, origin_value(api_port + 1))
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    cmd.spawn()
}

/// A `PATH` that can actually find `bun`.
///
/// ## The failure this exists for
///
/// An app launched from Finder does not inherit your shell. It gets
/// `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — none of `.zprofile`,
/// none of `.zshrc`, none of whatever put `~/.bun/bin` on your path. `run.sh`
/// ends in `exec bunx vite`, so the whole thing dies on:
///
/// ```text
/// ./run.sh: line 130: exec: bunx: not found
/// ```
///
/// Reproduced exactly by running `run.sh` with that minimal `PATH`. It is the
/// difference between a shell that works when you launch it from a terminal —
/// where every developer tests it — and one that never starts when a person
/// clicks the icon, which is the only way it will actually be used.
///
/// So the usual homes for a per-user toolchain are prepended to whatever we
/// were given. Prepended rather than replacing, because a person with a
/// deliberately arranged environment should keep it; and additive rather than
/// clever, because sourcing somebody's shell profile to find out means running
/// their shell profile, which is a much larger promise than finding a binary.
fn launch_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    let mut parts: Vec<String> = Vec::new();
    if !home.is_empty() {
        parts.push(format!("{home}/.bun/bin"));
        parts.push(format!("{home}/.local/bin"));
        parts.push(format!("{home}/.cargo/bin"));
        parts.push(format!("{home}/.nvm/current/bin"));
    }
    parts.push("/opt/homebrew/bin".into());
    parts.push("/usr/local/bin".into());

    // Keep only what is actually there, so the variable stays readable in a log.
    let mut path: Vec<String> = parts
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect();

    for existing in inherited.split(':').filter(|p| !p.is_empty()) {
        if !path.iter().any(|p| p == existing) {
            path.push(existing.to_string());
        }
    }
    path.join(":")
}

/// Is there a `bun` on the path we are about to hand `run.sh`?
///
/// Checked before spawning, because the alternative is a two-minute wait for a
/// port that was never going to open. A missing toolchain is a sentence, not a
/// timeout.
pub fn finds_bun() -> Option<PathBuf> {
    for dir in launch_path().split(':') {
        let candidate = Path::new(dir).join("bun");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Signal the group we started: TERM, a grace period, then KILL.
///
/// Safe to call twice, and safe to call from a signal handler — `killpg` is
/// async-signal-safe, which is why the terminal-interrupt path calls this one
/// rather than anything that allocates.
#[cfg(unix)]
pub fn stop_group(pgid: i32) {
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }
}

#[cfg(unix)]
pub fn kill_group(pgid: i32) {
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}
