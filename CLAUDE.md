# Kehikot desktop app — notes for agents

## Cutting a release

1. Bump the version in all three: `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` (and `Cargo.lock`, via `cargo check`), `package.json`.
2. Write `notes/<version>.md` in the same PR. The release workflow refuses to
   build without it (`.github/workflows/release.yml`, "Read the release notes").
3. Merge, then tag the merge commit `v<version>` and push the tag.

## Release notes

`notes/<version>.md` is the "What's new" a person reads on the release page and
in the app's release-notes modal. The workflow adds the download text and the
host commit; the file holds only the bullets.

- Find what changed: this repo's merged PRs since the previous tag, plus the
  host's (Jalez/kehikko) first-parent merges between the previous release's host
  commit (`app-v<previous>` tag there) and `host.ref` now.
- Write 1–5 bullets, each `- **Short bold lead.** One or two plain sentences.`
- From the person's side: what they see, can now do, or no longer suffer. Name
  the place in the app ("the Updates menu", "a module's header").
- No commit hashes, PR numbers, file or function names, protocol versions,
  "refactor", or hype ("powerful", "seamless", "exciting").
- Never invent. If a release only changes how releases are built or delivered,
  say so in one bullet: `- **Behind the scenes.** …; nothing changes in the app.`
- Generic text is refused by the workflow ("bug fixes and improvements", TODO,
  placeholder), and so is a file without bullets.

`notes/0.1.25.md` and the published 0.1.24/0.1.25 notes are the model.
