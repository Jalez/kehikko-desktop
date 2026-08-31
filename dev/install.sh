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

cd "$here"
bunx tauri build --bundles app

[ -d "$built" ] || { echo "no bundle at $built" >&2; exit 1; }

rm -rf /Applications/Kehikot.app
cp -R "$built" /Applications/

"$lsregister" -u "$built" 2>/dev/null || true
rm -rf "$built"

killall Dock 2>/dev/null || true
echo "installed /Applications/Kehikot.app"
