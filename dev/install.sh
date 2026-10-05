#!/usr/bin/env bash
#
# Build Kehikot and install it, leaving exactly one of it on the machine.
#
# The bundle Tauri writes under target/ is a real .app, and LaunchServices
# registers it the moment it is built or run. Launchpad then offers two
# Kehikots -- the installed one and whatever that build happened to contain --
# with nothing to tell them apart. Spotlight is not the mechanism, so a
# .metadata_never_index marker does not help; the registration is the thing to
# undo, and the build copy has no reason to outlive the install anyway.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
built="$here/src-tauri/target/release/bundle/macos/Kehikot.app"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# The host this app carries is built from a kehikko checkout: $KEHIKKO_HOST_DIR,
# or ~/Projects/kehikko. A checkout whose branch predates `build:sidecar` gets
# an app without a bundled host, which falls back to running that checkout's
# run.sh -- what every install did before the host could be bundled.
host_src="${KEHIKKO_HOST_DIR:-$HOME/Projects/kehikko}"
triple="$(rustc -vV | sed -n 's/^host: //p')"
case "$triple" in
  aarch64-apple-darwin) bun_target=bun-darwin-arm64 ;;
  x86_64-apple-darwin) bun_target=bun-darwin-x64 ;;
  *) bun_target="" ;;
esac
sidecar="$here/src-tauri/binaries/kehikko-host-$triple"

# Updater artifacts are signed for releases (CI holds the key); a local install
# has no use for them, and asking for them without the key fails the build.
# Local builds stay ad-hoc signed: the Developer ID certificate signs releases in
# CI, and a local build should not need it (or prompt for the keychain).
build_args=(--bundles app --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}')

if [ -n "$bun_target" ] && [ -f "$host_src/package.json" ] &&
  grep -q '"build:sidecar"' "$host_src/package.json"; then
  echo "building the bundled host from $host_src"
  mkdir -p "$here/src-tauri/binaries"
  (cd "$host_src" && bun install && bun run build:sidecar --target "$bun_target" --out "$sidecar")
  build_args+=(--config src-tauri/tauri.bundled.conf.json)
else
  echo "warning: no build:sidecar in $host_src -- building without a bundled host;" >&2
  echo "         the app will run that checkout's run.sh instead." >&2
fi

cd "$here"
bunx tauri build "${build_args[@]}"

[ -d "$built" ] || { echo "no bundle at $built" >&2; exit 1; }

rm -rf /Applications/Kehikot.app
cp -R "$built" /Applications/

"$lsregister" -u "$built" 2>/dev/null || true
rm -rf "$built"

killall Dock 2>/dev/null || true
echo "installed /Applications/Kehikot.app"

config="$HOME/.config/kehikko-desktop/config.json"
if [[ " ${build_args[*]} " == *tauri.bundled.conf.json* ]] &&
  ! grep -q '"hostDir"' "$config" 2>/dev/null && [ -z "${KEHIKKO_HOST_DIR:-}" ]; then
  echo "note: it runs the bundled host on 127.0.0.1:4170. To keep running a checkout"
  echo "      instead, put {\"hostDir\": \"$host_src\"} in $config"
fi
