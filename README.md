# timeboxing

A personal time-tracking PWA that combines **timeboxing** and **timeblocking**.
Record the start/end of everyday activities (bath, dinner, …) with one tap, and
see the average / median time at a glance.

No server. The app is a single `index.html` (inline CSS) plus one script
(`app.js`) that stores everything in the browser's `localStorage` on your device.
The script is written in **TypeScript** (`app.ts`) and compiled to `app.js`;
GitHub Actions builds and deploys it to GitHub Pages on every push.

## Features

- **Activities** — add an activity once, reuse it from then on
- **Reorder & rename** — move activities up/down with ▲▼ buttons (works on iPhone
  touch) and rename them; the display order is saved
- **Start / Stop timer** — one running activity at a time (exclusive). A live timer
  shows the elapsed time; closing the tab does not reset it (the start time is kept
  in `localStorage` so measurement continues)
- **Statistics** — per activity: average, median, count, and latest, computed automatically
- **Planned time** — set a planned duration per activity; when the average exceeds it,
  the value is highlighted in red (no notifications)
- **History** — a tidy, stats-first view by default; expand to see every record, and
  edit / delete / manually add records (for missed or mistaken taps)
- **JSON export / import** — back up or restore all data as a dated JSON file
- **Quota handling** — `QuotaExceededError` is caught and prompts an export

All time values are in **minutes**.

## Tech

- PWA: `index.html` (inline CSS) + `app.js` (compiled from `app.ts`)
- Language: **TypeScript** (`strict` mode), compiled with `tsc` — no bundler, no runtime dependencies
- Storage: `localStorage` (device-local; data is never sent anywhere)
- `manifest.json` + `sw.js` (Service Worker, network-first HTML) for "Add to Home Screen" and offline launch
- Icons: `icons/` (180 / 192 / 512 / maskable)
- CI/CD: GitHub Actions builds and deploys to GitHub Pages (`.github/workflows/deploy.yml`)

## Development

Requires Node.js.

```bash
npm install        # install TypeScript (dev dependency)
npm run build      # compile app.ts -> app.js once
npm run watch      # recompile automatically on every save
```

Then open `index.html` (e.g. via a local server) to try it. `app.js` is
git-ignored — you only ever commit `app.ts`; the build happens in CI.

## Data model

```json
{
  "activities": [
    {
      "id": "a...",
      "name": "入浴",
      "plannedMinutes": 20,
      "records": [
        { "start": "2026-05-31T22:00", "end": "2026-05-31T22:22", "minutes": 22 }
      ]
    }
  ]
}
```

Records data stays in `localStorage` on the device only. iOS may rarely clear
`localStorage`, so **JSON export is the backup mechanism**.

## Usage on iPhone

1. Open the published URL (see below) in Safari
2. Share → **Add to Home Screen**
3. Launch from the home-screen icon — it runs full-screen like a native app

## Deploy (automatic)

Deployment is automated by GitHub Actions. On every push to `main`, the workflow
in `.github/workflows/deploy.yml`:

1. installs dependencies (`npm ci`),
2. compiles `app.ts` → `app.js` (`npm run build`),
3. assembles the static site and publishes it to GitHub Pages.

So the only thing you do is **edit `app.ts` and push** — the compiled site appears
at `https://<username>.github.io/timeboxing/` (HTTPS) a minute later.

One-time setup (already done for this repo): the repository is **public** (free
GitHub Pages requires it) and **Settings → Pages → Source** is set to
**GitHub Actions**.

## Privacy

The repository contains code only. Activity records live solely in your device's
`localStorage` and are never transmitted to GitHub or any server.
