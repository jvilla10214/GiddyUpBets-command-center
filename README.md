# GiddyUpBets Command Center

A single-file, no-server dashboard: live wind/temp/rain conditions for Saratoga Race Course,
with a wind compass overlaid on your track map. Pulls from [Open-Meteo](https://open-meteo.com)
(free, no API key, refreshes every 5 minutes).

## Run it

Just open `index.html` in a browser — double-click it, or in VS Code use the
**Live Server** extension (right-click `index.html` → "Open with Live Server")
so it behaves the same as it will once deployed.

No `pip install`, no `npm install`, no build step.

## Add your real track photo

Right now the track is a drawn placeholder SVG oval so the dashboard works out of the box.
To use your actual saved image:

1. Drop your image into `assets/track.jpg` (any name/extension is fine, just update the path below).
2. In `index.html`, find this block near the top of the `track-wrap` div:
   ```html
   <!-- <img class="track-photo" src="assets/track.jpg" alt="Saratoga Race Course"> -->
   ```
   Uncomment it (remove the `<!--` and `-->`) and set `src` to your file's path.
3. Optional: delete or comment out the `<svg id="trackSvg">...</svg>` block right below it,
   since the photo will sit on top of it either way (z-index isn't required — the `<img>`
   is absolutely positioned to fully cover the SVG).

The wind compass dial in the bottom-right corner sits on top of whichever track visual you use,
so it'll overlay correctly on your real photo automatically.

## Add your logo

The header ships with a commented-out logo slot sitting right over the "Command Center" text:

```html
<!-- <img class="brand-logo" src="assets/logo.png" alt="GiddyUpBets"> -->
```

1. Drop your logo into `assets/logo.png` (any name/extension is fine, just update the `src`).
   A transparent PNG or SVG works best against the dark header.
2. Uncomment the `<img>` tag. It's absolutely positioned over the "Command Center" label,
   so once it's in place you can delete that text `<div>` if you don't want it peeking out
   from behind a transparent logo.

## Switching to a different track (or adding a dropdown later)

The coordinates are set at the top of the `<script>` block:

```js
const LAT = 43.0723, LON = -73.7859; // Saratoga Race Course
```

When you're ready for multiple tracks, the cleanest next step is turning this into a small
JS object, e.g.:

```js
const TRACKS = {
  saratoga:  { name: "Saratoga Race Course", lat: 43.0723, lon: -73.7859, img: "assets/saratoga.jpg" },
  belmont:   { name: "Belmont Park",         lat: 40.7181, lon: -73.7226, img: "assets/belmont.jpg" },
  churchill: { name: "Churchill Downs",      lat: 38.2039, lon: -85.7695, img: "assets/churchill.jpg" },
};
```
...with a `<select>` in the header that calls `fetchWeather()` with the chosen track's lat/lon.
I can wire this up whenever you're ready — just say the word.

## What's included

- **Wind compass** — rotating needle (true wind direction) + live speed reading, overlaid on the track.
- **Temperature** tile with "feels like."
- **Wind gusts** tile (separate from sustained speed).
- **Rainfall** tile — today's total + current hourly rate, flags red past 0.5".
- **Humidity, cloud cover, pressure, conditions text** (e.g. "Light rain").
- **Track condition estimate** (Fast / Good / Muddy / Sloppy) — a simple heuristic off rainfall,
  clearly labeled as an estimate, not an official call.
- **8-hour ticker** — scrolling strip of upcoming temp / rain probability / wind.
- **Auto-refresh** every 5 minutes, with a visible countdown and manual refresh button.
- **Connection status pill** — turns red if a fetch fails, and it auto-retries on the next cycle.

## Adjusting refresh rate

In `<script>`:
```js
const REFRESH_MS = 5 * 60 * 1000; // change 5 to however many minutes you want
```
Open-Meteo's free tier is generous, but don't go below ~1 minute on a public-facing page.

## Deploying to your site

This is a static file — it can be:
- Embedded directly as a page/section on GiddyUpBets (upload `index.html` + `assets/` folder).
- Dropped into an `<iframe>` on an existing page.
- Hosted for free on GitHub Pages, Netlify, or Vercel if you want it at its own URL.

No backend required unless/until you add things like paid odds feeds or your own database —
happy to help with that step when you get there.
