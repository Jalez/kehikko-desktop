#!/usr/bin/env bash
#
# Send the six Apple signing secrets to this repository's GitHub Actions.
#
#   dev/set-signing-secrets.sh <apple-id-email> [path/to/cert.p12]
#
# The two passwords come out of the login keychain, where dev/signing.swift
# put them, and are piped straight into `gh secret set` on stdin — they are
# never printed, never on a command line, never in a file. The .p12 is
# base64-encoded on the way in the same way. The signing identity and team id
# are read from the certificate itself.
set -euo pipefail

email="${1:?usage: dev/set-signing-secrets.sh <apple-id-email> [cert.p12]}"
p12="${2:-$HOME/Desktop/kehikot-developer-id.p12}"
repo="Jalez/kehikko-desktop"
service="kehikot-signing"

[ -f "$p12" ] || { echo "no .p12 at $p12 — run: swift dev/signing.swift export" >&2; exit 1; }
secret() { security find-generic-password -s "$service" -a "$1" -w; }
secret APPLE_CERTIFICATE_PASSWORD >/dev/null || { echo "no .p12 password in the keychain — run: swift dev/signing.swift export" >&2; exit 1; }
secret APPLE_PASSWORD >/dev/null || { echo "no app-specific password in the keychain — run: swift dev/signing.swift save-app-password" >&2; exit 1; }

identity="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
[ -n "$identity" ] || { echo "no valid Developer ID Application identity in the keychain" >&2; exit 1; }
team="$(printf '%s' "$identity" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
[ -n "$team" ] || { echo "could not read the team id from \"$identity\"" >&2; exit 1; }

base64 -i "$p12" | gh secret set APPLE_CERTIFICATE -R "$repo"
secret APPLE_CERTIFICATE_PASSWORD | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$repo"
secret APPLE_PASSWORD | gh secret set APPLE_PASSWORD -R "$repo"
printf '%s' "$identity" | gh secret set APPLE_SIGNING_IDENTITY -R "$repo"
printf '%s' "$email" | gh secret set APPLE_ID -R "$repo"
printf '%s' "$team" | gh secret set APPLE_TEAM_ID -R "$repo"

echo "Set APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_PASSWORD,"
echo "APPLE_SIGNING_IDENTITY ($identity), APPLE_ID and APPLE_TEAM_ID ($team) on $repo."
