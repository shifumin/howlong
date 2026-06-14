# CLAUDE.md

A personal time-tracking PWA (timeboxing + timeblocking). Single `index.html`
(inline CSS) + a TypeScript script, deployed to GitHub Pages via GitHub Actions.

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
`app.ts` and publishes to GitHub Pages at <https://shifumin.github.io/timeboxing/>.

- **Do not** build or commit `app.js` for deployment — CI does it.
- Pages **Source** is set to **GitHub Actions** (not "deploy from a branch").
- The repo must stay **public** (free GitHub Pages requirement).
- After a deploy, reload the site to pick it up (the Service Worker serves the
  HTML network-first, so a normal reload gets the latest version).

## Conventions

- Commits: Conventional Commits, English (per global CLAUDE.md).
- TypeScript runs in `strict` mode (`tsconfig.json`). Keep it compiling cleanly.
- All time values are in **minutes**, with a **1-minute minimum** at every entry
  point (timer stop, manual add, edit, import) — no 0-minute records.

## Layout

| File | Role |
|------|------|
| `app.ts` | App source (TypeScript). **Edit this.** |
| `app.js` | Compiled output. Generated, git-ignored. Do not edit. |
| `index.html` | Markup + inline CSS; loads `app.js`. |
| `sw.js` | Service Worker (network-first HTML, cache-first assets). |
| `manifest.json` / `icons/` | PWA shell. |
| `tsconfig.json` / `package.json` | TS config and build scripts. |
