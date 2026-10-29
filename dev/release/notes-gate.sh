#!/usr/bin/env bash
# The release-notes gate: a notes file says what changed, in words a person
# cares about, or no release is cut. Prints the notes body (HTML comments and a
# leading "What's new" heading dropped) on stdout; exits 1 with a GitHub error
# annotation (on stdout, the only output then) when the file is missing, has no bullets, or still holds
# placeholder or generic text. Rules: CLAUDE.md, "Release notes".
#
#   dev/release/notes-gate.sh notes/0.1.89.md [0.1.89]
set -euo pipefail
file="$1"
version="${2:-$(basename "$file" .md)}"
if [ ! -f "$file" ]; then
  echo "::error file=$file::No release notes. Write $file: 1-5 bullets on what a person notices in $version (see CLAUDE.md, 'Release notes')."
  exit 1
fi
body="$(perl -0pe 's/<!--.*?-->//gs; s/\A\s*#+\s*What.s new\s*\n//i' "$file")"
if ! printf '%s\n' "$body" | grep -Eq '^[[:space:]]*[-*] .*[[:alpha:]]{3}'; then
  echo "::error file=$file::$file has no bullet points. Write 1-5 bullets on what a person notices in $version."
  exit 1
fi
if printf '%s\n' "$body" | grep -Eiq '\b(TODO|TBD|FIXME|lorem ipsum|placeholder|write (this|here))\b|bug fixes and (performance )?improvements'; then
  echo "::error file=$file::$file still has placeholder or generic text. Say what actually changed for a person."
  exit 1
fi
printf '%s\n' "$body"
