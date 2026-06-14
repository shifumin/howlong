# timeboxing

A personal time-tracking PWA that combines **timeboxing** and **timeblocking**.
Record the start/end of everyday activities (bath, dinner, …) with one tap, and
see the average / median time at a glance.

No build step, no dependencies, no server. A single `index.html` (Vanilla JS + CSS)
that stores everything in the browser's `localStorage` on your device.

## Features

- **Activities** — add an activity once, reuse it from then on
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

- Single-file PWA: `index.html` (Vanilla JS + CSS), no build/dependencies
- Storage: `localStorage` (device-local; data is never sent anywhere)
- `manifest.json` + `sw.js` (Service Worker) for "Add to Home Screen" and offline launch
- Icons: `icons/` (180 / 192 / 512 / maskable)

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

## Deploy with GitHub Pages

This repository is structured so that `index.html` sits at the root, which is all
GitHub Pages needs.

1. Create a **public** repository named `timeboxing` and push this directory
   (GitHub Pages on free accounts requires a public repository)
2. On GitHub: **Settings → Pages**
3. **Source**: *Deploy from a branch*
4. **Branch**: `main`, folder `/ (root)` → **Save**
5. After a minute, the app is served at `https://<username>.github.io/timeboxing/`
   over HTTPS (required for PWA / Service Worker)

## Privacy

The repository contains code only. Activity records live solely in your device's
`localStorage` and are never transmitted to GitHub or any server.
