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

### ⚠️ Changing `app.ts` requires bumping `CACHE` in `sw.js`

Only the HTML is served network-first. `app.js` is **not** in the Service
Worker's `ASSETS` list, so it falls through to the cache-first branch: a
returning visitor keeps the old `app.js` until the cache name changes.

| Changed file | Served how | Bump `CACHE`? |
|--------------|------------|---------------|
| `index.html` | network-first | No — a reload picks it up |
| `app.ts` → `app.js` | cache-first | **Yes** |
| `manifest.json`, `icons/*` | cache-first | **Yes** |

Bump `howlong-vN` → `howlong-vN+1` in the same push that changes `app.ts`.
Skipping it deploys new HTML against stale JS — that is how 1.2.0 shipped a
pause button that did nothing (`2fe92dd`, fixed in `55ddc53`).

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
| `sw.js` | Service Worker (network-first HTML, cache-first assets — see Deploy). |
| `manifest.json` / `icons/` | PWA shell. |
| `tsconfig.json` / `package.json` | TS config and build scripts. |
| `.github/workflows/deploy.yml` | CI: compiles `app.ts`, publishes to Pages. |
| `docs/superpowers/specs/` | Design docs for shipped features (the *why* behind decisions the code doesn't explain). |
