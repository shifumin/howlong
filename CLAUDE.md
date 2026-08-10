# CLAUDE.md

A personal time-tracking PWA for everyday activities (record durations, see
average/median, set a planned time). Single `index.html` (inline CSS) + a
TypeScript script, deployed to GitHub Pages via GitHub Actions.

## ⚠️ Edit `app.ts`, never `app.js`

`app.js` is **generated from `app.ts` by `tsc`** and is **git-ignored**. Editing
`app.js` directly is pointless — the change is not committed and CI overwrites it
on the next deploy. All source changes go in **`app.ts`**.

## Build

Node commands run via `mise exec --` (see global CLAUDE.md).

```bash
mise exec -- npm install      # first time: install TypeScript
mise exec -- npm run build    # compile app.ts -> app.js once
mise exec -- npm run watch    # recompile on every save
```

After building, open `index.html` (via a local server) to test in a browser.

## Deploy

Push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) compiles
`app.ts` and publishes to GitHub Pages at <https://shifumin.github.io/howlong/>.

- Pages **Source** is set to **GitHub Actions** (not "deploy from a branch").
- The repo must stay **public** (free GitHub Pages requirement).

### Cache strategy and when to bump `CACHE` in `sw.js`

`index.html` and `app.js` are both served **network-first**, because they ship
together and must never drift apart. A reload picks up either one.

| Changed file | Served how | Bump `CACHE`? |
|--------------|------------|---------------|
| `index.html` | network-first | No — a reload picks it up |
| `app.ts` → `app.js` | network-first | No — a reload picks it up |
| `manifest.json`, `icons/*` | cache-first | **Yes** |

Bump `howlong-vN` → `howlong-vN+1` only when a cache-first asset changes.

`app.js` used to be cache-first, which made the bump mandatory on every
`app.ts` change and turned a forgotten bump into new HTML running against a
stale script — that is how 1.2.0 shipped a pause button that did nothing
(`2fe92dd`, fixed in `55ddc53`). Version 1.3.1 moved `app.js` to network-first
so the mistake is no longer possible; see
`docs/superpowers/specs/2026-08-10-app-js-network-first-design.md`.

Offline still works: every network-first response is written to the cache, and
`app.js` is pre-cached at install, so a failed fetch falls back to the last good
copy.

### Releases are created from the `version` in `package.json`

Bumping `version` in `package.json` and pushing to `main` is the whole release
process. `.github/workflows/release.yml` tags the commit `v<version>` and
publishes a release with auto-generated notes. It keys off "does a tag for this
version exist", so re-running it or pushing without a bump does nothing.

Releases used to be created by hand, which is why 1.3.0, 1.3.1 and 1.3.2 all
shipped while `v1.2.2` still showed as the latest release.

Auto-generated notes are a commit list. When a release deserves the prose the
earlier ones have, replace the body afterwards:

```bash
gh release edit v1.3.2 --notes-file notes.md
```

| Change | What to bump |
|--------|--------------|
| Any user-visible change | `version` in `package.json` |
| A cache-first asset (`manifest.json`, `icons/*`) | also `CACHE` in `sw.js` |

## Conventions

- Commits: Conventional Commits, English (per global CLAUDE.md).
- TypeScript runs in `strict` mode (`tsconfig.json`). Keep it compiling cleanly.
- All time values are in **minutes**, with a **1-minute minimum** at every entry
  point (timer stop, manual add, edit, import) — no 0-minute records.

## Layout

| File | Role |
|------|------|
| `app.ts` | App source (TypeScript). |
| `app.js` | Compiled output (generated from `app.ts`, git-ignored). |
| `index.html` | Markup + inline CSS; loads `app.js`. |
| `sw.js` | Service Worker (network-first HTML + `app.js`, cache-first shell — see Deploy). |
| `manifest.json` / `icons/` | PWA shell. |
| `tsconfig.json` / `package.json` | TS config and build scripts. |
| `.github/workflows/deploy.yml` | CI: compiles `app.ts`, publishes to Pages. |
| `.github/workflows/release.yml` | CI: tags and releases when `package.json` `version` has no tag. |
| `docs/superpowers/specs/` | Design docs for shipped features (the *why* behind decisions the code doesn't explain). |
