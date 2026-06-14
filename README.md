# timeboxing

**App: https://shifumin.github.io/timeboxing/**

A personal time-tracking PWA that combines **timeboxing** and **timeblocking**.
Record the start/end of everyday activities (bath, dinner, …) with one tap, and
see the average / median time at a glance.

No server. The app is a single `index.html` (inline CSS) plus one script
(`app.js`) that stores everything in the browser's `localStorage` on your device.

## Features

- **Activities** — add an activity once, reuse it from then on
- **Reorder, rename & delete** — move activities up/down with ▲▼ buttons (works on
  iPhone touch), rename or delete them; the display order is saved
- **Start / Stop timer** — one running activity at a time (exclusive). A live timer
  shows the elapsed time; closing the tab does not reset it (the start time is kept
  in `localStorage` so measurement continues)
- **Statistics** — per activity: average, median, count, and latest, computed automatically
- **Planned time** — set a planned duration per activity; when the average exceeds it,
  the value is highlighted in red (no notifications)
- **History** — a tidy, stats-first view by default; expand to see every record, and
  edit / delete / manually add records (for missed or mistaken taps)
- **JSON export / import** — back up or restore all data as a dated JSON file

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
      "name": "夕食",
      "plannedMinutes": 20,
      "records": [
        { "start": "2026-05-31T22:00", "end": "2026-05-31T22:22", "minutes": 22 }
      ]
    }
  ]
}
```

The order of the `activities` array is the display order (the ▲▼ buttons reorder
the array; there is no separate order field).

Records data stays in `localStorage` on the device only. iOS may rarely clear
`localStorage`, so **JSON export is the backup mechanism**.

## Usage on iPhone

1. Open https://shifumin.github.io/timeboxing/ in Safari
2. Share → **Add to Home Screen**
3. Launch from the home-screen icon — it runs full-screen like a native app
