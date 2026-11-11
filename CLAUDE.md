# Kehikot desktop app — notes for agents

## Releases are automatic

Nobody bumps the version, writes the notes file or tags by hand.

- Every PR here and in Jalez/kehikko fills in `## Release note`
  (`.github/pull_request_template.md`): first a line `Kind: breaking`,
  `Kind: feature`, `Kind: fix` or `Kind: none`, then one line in the form below
  (none for `Kind: none`). The `release note` check
  (`.github/actions/release-note`, run by `checks.yml` here and
  `release-note.yml` in the host) fails a PR without the kind, with an unknown
  one, without the line, with placeholder text, or naming a module or vendor
  (the host's `dev/module-agnostic.ts`). A desktop-only change releases the
  same way.
- `.github/workflows/auto-release.yml`, hourly from `main` (and by hand): compares
  the host's `main` with the commit the latest release was built from (its body,
  "Built from Jalez/kehikko@…"), and this repo's `main` with the latest `v*` tag;
  collects the release-note lines of the PRs merged in between (`none` and PRs
  without the section are skipped); runs the notes gate and the host's
  module-agnostic check at that host commit; and when lines are left, tags the
  next version on `main` (annotated; message = the bullets plus
  `Kehikot-Host: Jalez/kehikko@<sha>`) and calls `release.yml` in the same run.
  The logic is `dev/release/` (`plan-app.ts`, `lib.ts`, tested by `lib.test.ts`).
- The next version follows semver from the LARGEST kind among the collected
  PRs (`bump`, `nextVersion` in `lib.ts`): while the major is 0, a `breaking`
  PR makes the next minor (0.1.140 → 0.2.0) and anything else the next patch
  (→ 0.1.141); from 1.0, breaking → major, feature → minor, fix → patch. A note
  merged before kinds (no `Kind:` line) counts as `fix`. The notes are grouped
  `#### Breaking`, `#### New`, `#### Fixed` (inside the release's
  `### What's new`), empty groups left out.
- Order for a module that needs a newer protocol: when a module's release pins a
  protocol newer than the host's pin, the host pin is bumped and the app released
  FIRST (this workflow), then the module is released. A released app cannot
  install a module that needs more than it speaks. The check is the host's
  `dev/protocol-ahead.ts`, run daily by `protocol-ahead.yml` there, which opens
  one issue when a module's newest release is ahead of the host pin. It warns
  and does not block this workflow: an unrelated app fix should not wait.
- The same order is ENFORCED for modules: `module-release.yml` runs
  `.github/actions/protocol-order` (`dev/release/protocol-order.ts`, tested by
  `protocol-order.test.ts`) before tagging or publishing, and refuses the release
  while the module's pinned `kehikot-module-protocol` (a `#vX.Y.Z` tag, or a commit
  resolved through the API; else the installed package) is newer than the protocol
  of the newest PUBLISHED app release (its body's "Built from Jalez/kehikko@<sha>",
  that commit's `package.json` pin). The message says to release the app first
  (host pinned, app released) and re-run the workflow, which then passes.
  `module-ci.yml` runs the same check as a warning only (the app may be released
  before the module PR merges). A pin or release it cannot read, or a GitHub rate
  limit that outlasts its retries, is a warning and a pass, with the reason.
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
- Write for people, not for the protocol. When a release needs a newer Kehikot,
  name the app version ("Needs Kehikot 0.1.110 or later"), never the module
  protocol number: people deal with the app and the modules, not the protocol.
  The app shows the protocol, for whoever wants it, in Settings > About.
- Never invent. A change only to how releases are built or delivered, tests,
  docs or a refactor is `none`: it releases nothing by itself.
- Generic text is refused by the workflow ("bug fixes and improvements", TODO,
  placeholder), and so is a file without bullets.

`notes/0.1.25.md` and the published 0.1.24/0.1.25 notes are the model.

### For agents

A release that changes what an agent session sees or may do — a new or changed
tool, a rule it is held to, a guard — says so for the sessions already running,
which are told once, at their next prompt after the update (module protocol
2.61.0). The people's bullets stay as above; this is beside them.

- A module: a `## For agents` section at the end of `notes/<version>.md`, one or
  two bullets in the agent's terms, naming the tool or rule:
  `- \`queue_wait\` waits for a run and answers when it ends; use it instead of polling \`queue_status\`.`
  Tool and function names are right here (agents call them); no hype, no
  people's benefits, nothing an agent cannot act on. A release with nothing new
  for agents has no section. People never see it in the app (the host shows a
  module's notes without it); it stays on the GitHub release.
- The host: a `## <next number>` section at the top of the host's
  `FOR_AGENTS.md`, in the same PR, under the same rules plus the host's own (no
  module or vendor named). Not in the PR's `## Release note`.

## Versions follow semver

Kehikot, every module and the protocol follow Semantic Versioning, and CI
enforces it. A change declares its kind — `breaking` (something removed, or no
longer working the same way), `feature` (something new), `fix`, or `none` (no
release) — and the version is the one that kind asks for after the latest tag:

| Latest | breaking | feature | fix |
| --- | --- | --- | --- |
| 0.x (0.1.9) | minor (0.2.0) | patch (0.1.10) | patch (0.1.10) |
| ≥ 1.0 (1.4.2) | major (2.0.0) | minor (1.5.0) | patch (1.4.3) |

- The app: the PR's `## Release note` starts `Kind: …`; the planner takes the
  largest (above).
- A module: `notes/<version>.md` starts with `Kind: breaking | feature | fix`
  (before the bullets; the release page leaves the line out). `module-ci.yml`
  fails a PR whose `package.json` version moved past the latest tag without
  those notes, without a kind, or to any version but exactly the one its kind
  asks for (`.github/actions/version-kind`, logic `dev/release/check-bump.ts`).
  Pick the version with the table, from the latest tag at the time you open
  the PR; renumber if another release lands first.
- The protocol: the same check in its `ci.yml`, on the `Kind:` line at the top
  of its `## X.Y.Z` CHANGELOG entry.

## Module checks

`.github/workflows/module-ci.yml` is the one workflow every module calls (`on:
workflow_call`) from its own `.github/workflows/ci.yml`, on `pull_request` and
on a push to `main`, at `@main`. On a pull request it first checks the version
against its kind ("Versions follow semver"). It installs with `--frozen-lockfile`, then runs
`bun run typecheck` (else `bunx tsc --noEmit` when there is a tsconfig),
`bun test` and `bun run build`, skipping what a module lacks. Inputs, all
optional: `runners` (a JSON list, `["ubuntu-latest"]` by default; add
`"macos-latest"` for a module whose tests need a Mac), `env` (NAME=value lines
for the steps, e.g. `CI=1`) and `bun-version`. A private repository of another
owner cannot call it and keeps an inline copy. A CI-only change bumps no
version and has no notes, so it releases nothing.

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
  or older: the run fails and says so. A module PR bumps `package.json` (by
  its kind, "Versions follow semver") and adds the notes; merging it is
  releasing it.
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
