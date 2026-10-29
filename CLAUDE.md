# Kehikot desktop app — notes for agents

## Releases are automatic

Nobody bumps the version, writes the notes file or tags by hand.

- Every PR here and in Jalez/kehikko fills in `## Release note`
  (`.github/pull_request_template.md`): one line in the form below, or `none`.
  The `release note` check (`.github/actions/release-note`, run by `checks.yml`
  here and `release-note.yml` in the host) fails a PR without it, with
  placeholder text, or naming a module or vendor (the host's
  `dev/module-agnostic.ts`). A desktop-only change releases the same way.
- `.github/workflows/auto-release.yml`, hourly from `main` (and by hand): compares
  the host's `main` with the commit the latest release was built from (its body,
  "Built from Jalez/kehikko@…"), and this repo's `main` with the latest `v*` tag;
  collects the release-note lines of the PRs merged in between (`none` and PRs
  without the section are skipped); runs the notes gate and the host's
  module-agnostic check at that host commit; and when lines are left, tags the
  next patch version on `main` (annotated; message = the bullets plus
  `Kehikot-Host: Jalez/kehikko@<sha>`) and calls `release.yml` in the same run.
  The logic is `dev/release/` (`plan-app.ts`, `lib.ts`, tested by `lib.test.ts`).
- The version is the TAG's. `release.yml` stamps it into `tauri.conf.json`,
  `Cargo.toml`/`Cargo.lock` and `package.json` at build time; those files stay at
  the last hand-bumped version and are not edited per release. `dev/install.sh`
  stamps the newest tag's version into a local build.
- Safety: only the schedule, or a manual run with `mode=release`, on `main` of
  this repo tags; a manual run defaults to `dry-run` (plans, prints the notes,
  stops before tagging), and a PR touching the release files runs a dry run.
  Nothing builds from a fork or a PR (`release.yml` also refuses a tag not on
  `main`). One release at a time (concurrency `kehikot-app-release`; a plan
  waits while a hand-started `release.yml` run is building). A failure opens or
  comments on ONE issue, "Automatic app release failed"; while it is open the
  hourly run does nothing. Fix, then close it.
- A failed build leaves the tag and a draft. Re-run `release.yml` by hand on the
  tag (notes and host commit come from the tag message), or delete both; the
  next plan refuses to start past a stuck draft.
- Tagging needs GitHub Actions (Integration 15368) as a bypass actor on the
  "release tags are the owner's" ruleset; `main` keeps no bypass but the owner's.
- A hand release still works: commit `notes/<v>.md` and push an annotated
  `v<v>` tag as the owner. Do not do this while `auto-release` is running.

## Release notes

"What's new" a person reads on the release page and in the app's release-notes
modal is the PRs' release-note lines, one bullet each (the workflow adds only a
small host-commit line). The rules below are for writing a PR's line (and a
module's `notes/<version>.md`). No download or install text: people know how to
install an app.

- Write each line `**Short bold lead.** One or two plain sentences.`
- From the person's side: what they see, can now do, or no longer suffer. Name
  the place in the app ("the Updates menu", "a module's header").
- No commit hashes, PR numbers, file or function names, protocol versions,
  "refactor", or hype ("powerful", "seamless", "exciting").
- Never invent. A change only to how releases are built or delivered, tests,
  docs or a refactor is `none`: it releases nothing by itself.
- Generic text is refused by the workflow ("bug fixes and improvements", TODO,
  placeholder), and so is a file without bullets.

`notes/0.1.25.md` and the published 0.1.24/0.1.25 notes are the model.

## Module releases

Every Kehikot module is released the same way, and Kehikot installs and updates
modules from those releases, not from a module's `main`.
`.github/workflows/module-release.yml` is the one workflow they call (`on:
workflow_call`); a module's own `.github/workflows/release.yml` only calls it at
`@main`, on a push to `main` and on a `v*` tag.

- Tagged on merge: on a push to `main`, its `tag` job
  (`.github/actions/tag-on-merge`, logic `dev/release/plan-tag.ts`) tags
  `v<version>` (annotated, on the pushed commit) when `package.json`'s version is
  newer than every `v*` tag and `notes/<version>.md` exists, and the `release`
  job publishes it in the same run. Same version: nothing. Newer without notes,
  or older: the run fails and says so. A module PR bumps `package.json` and adds
  the notes; merging it is releasing it.
- The `release` job refuses a tag that does not match the module's
  `package.json`, is lightweight or is not on `main`, runs the same notes gate as
  above on the module's `notes/<version>.md`, installs, typechecks and tests,
  then publishes the release `<Module name> X.Y.Z` with the body
  `### What's new`, the bullets, one line on which Kehikot it works with, and
  `<sub>Built from <sha7></sub>`. That line ("Works with Kehikot 0.1.39 and
  later.") is the module's protocol pin against the `app-v*` tags of
  Jalez/kehikko and each tag's `package.json`; when it cannot be worked out it
  says "Needs module protocol 2.6 or later.", and it never fails the release.
  The host parses that body: change it only together with the host. Module
  notes follow the "Release notes" rules above, from the module's side.
- Kehikot-protocol uses the same action from its `ci.yml`, after its checks,
  with a `## X.Y.Z` CHANGELOG entry instead of a notes file; its tag is its
  release.
- Each repo's tag ruleset needs GitHub Actions (Integration 15368) as a bypass
  actor for the token-made tag. A caller on tags only keeps working (its runs
  skip `tag`). `module-release.yml` and the action are read at `@main`: change
  them compatibly.
