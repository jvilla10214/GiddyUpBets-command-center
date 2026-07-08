# GiddyUpBets Command Center

A single-file, no-backend weather and track-condition dashboard for Saratoga Race Course. It pulls
live conditions, short- and long-range forecasts, radar, and official NYRA scratches/rail data into
one screen, layers a rule-based handicapping read on top of the wind and track condition, and keeps
a running local log of daily conditions plus a live alert feed — all from a single `index.html` file
with no build step, no server, and no paid APIs.

**Live:** https://jvilla10214.github.io/GiddyUpBets-command-center/
**Repo:** https://github.com/jvilla10214/GiddyUpBets-command-center

## Layout

A persistent left icon-rail (not a hamburger menu — always visible, same on mobile and desktop)
switches between four pages: **Dashboard** (live conditions, wind/compass, Track Play Analysis, AI
Racing Summary, NYRA panel, Radar & Storm Forecast), **News Wire**, **Historical Weather Data**
(Daily Log + Historical Lookup, as two tabs within that page), and **Bias Tracker**. It's a plain
show/hide toggle over static DOM, config-driven (`SIDEBAR_PAGES` in the script), so adding another
page later is a new sidebar button plus one array entry — no restructuring. More pages (e.g. the
floated future Calendar/archive page) can slot in the same way.

## What's fully working right now

**AI Racing Summary**
- A highlighted "briefing" callout near the top of the dashboard, clearly labeled **Automated —
  Rule-Based**, that fills in 2-4 sentence templates from data already on the page: current wind
  speed/direction, a wind-trend read (last ~3h vs. the prior ~3h of hourly data), the same
  headwind/tailwind-to-the-stretch math the Track Play Analysis panel uses, and the dirt/turf
  condition + Drying/Wetting/Holding trend.
- Not a live AI/LLM call — every sentence is template text gated by thresholds, so it only ever
  states what the underlying data supports. If wind is trending up, it'll project *when* (an actual
  clock time from the Wind Forecast Scrubber's steps) it should turn into a stretch headwind rather
  than naming a race number, since there's no race post-time schedule wired in; rain language stays
  general ("in the area") rather than inventing a direction, since there's no geographic rain data.
- Regenerates every time conditions refresh (auto or manual).

**Live conditions**
- Wind compass (rotating needle, true direction + speed) and an animated wind-flow overlay
  (Windy.com-style streaklines) drawn directly on the track photo, both driven by live wind data.
- Temperature (with feels-like), wind gusts, rainfall (current rate + last 6h/24h/48h + today's
  total), humidity, cloud cover, barometric pressure, and a plain-language conditions description.
- Auto-refreshes every 5 minutes, with a visible countdown, manual refresh button, and a
  connection-status pill that turns red and auto-retries if a fetch fails.

**Track condition**
- Two independent condition badges — **Main Track (Dirt)** (Fast/Good/Muddy/Sloppy) and **Turf
  Course** (Firm/Good/Yielding/Soft) — each a heuristic off rainfall, weighted differently (dirt
  reacts to the instant rate + today's total; turf leans on rolling 24h/48h totals since turf drains
  slower and stays soft longer).
- A Drying/Wetting/Holding trend indicator next to each, from comparing the last 6h of rain against
  the prior 6h, plus current wind/sun.
- A **Track Conditions & Rail — NYRA Scratches** panel embedding NYRA's own live scratches page
  (official track/turf condition, which races run on which turf course, and rail settings in feet) —
  the real stewards' call, shown right next to our heuristic for comparison.

**Forecasting**
- **Wind Forecast Scrubber** — a slider from "Now" to +6h in 30-minute steps that re-projects the
  compass, track wind-flow overlay, gusts, temp, and rain rate using Open-Meteo's 15-minute
  forecast data.
- **Track Play Analysis** — a rule-based (not AI/LLM) read of wind vs. the actual stretch-run
  geometry (headwind/tailwind/crosswind on the homestretch and backstretch), combined with track
  condition, written out as a plain-English handicapping note. Clearly labeled heuristic.
- **Radar & Storm Forecast** — one consolidated panel with two views: live weather radar ("Now") and
  a multi-day ECMWF precipitation forecast ("Forecast — Storms"), toggled with two buttons, so you
  can see both what's happening right now and what might come through later.
- **Next 8 Hours** ticker — hourly temp/feels-like/rain probability/wind strip.

**Logging & history** (sidebar → Historical Weather Data)
- **Daily Log** tab — automatically logs the most recently *completed* day (high/low temp, average
  wind + peak gust + prevailing direction, rain total, dirt + turf condition, conditions text) once
  it's over, or on demand via "Log Today's Snapshot Now" (flagged as partial since the day isn't
  finished). This is the data foundation the Bias Tracker reads from.
- **Historical Lookup** tab — pull any date from the last year live from Open-Meteo's free archive
  API, with a button to add it to the permanent log.

**Bias Tracker** (its own sidebar page)
- Logs your own read of how a card actually played (running-style bias, rail notes, free-form
  notes), one entry per racing day. There's no free automated source for "how it played" — that's an
  inherently qualitative/human read — so this is manual entry by design. Each row cross-references
  that same date's Dirt/Turf condition from the Daily Log (on the Historical Weather Data page) so
  you can compare at a glance. Saving a note pushes a Bias alert, same as an auto-logged day.
- **Trends** — a rollup above the entry table: a bar chart of how often each running-style bias has
  been logged (All Time / Last 30 Days / Last 14 Days), a dry-vs-wet dirt-condition cross-tab, and
  average wind speed per bias category. Pure aggregation over data already in `localStorage` — no
  external source, so unlike the weather/news/entries integrations, this can't break or go stale.
- **Analyze Pasted Text** — paste race results or chart text from anywhere (Equibase, DRF, HRN, a
  news recap) into the Add Bias Note form and click "Analyze Pasted Text" for a suggested
  running-style bias, based on keyword-matching standard chart/trip-note language ("wire to wire,"
  "rallied," "closed well," etc.). Since you paste it yourself, there's no fetch/proxy/bot-wall
  involved — sidesteps the reliability problems that shelved automated entries/results import (see
  DECISIONS.md). Shows exactly which phrases it matched and pre-fills the bias field and notes —
  Save is still a manual, reviewed step, never an auto-fill.

**Alerts**
- A bell icon in the header with an unread-count badge opens a dropdown **Alert Feed**, filterable
  by category (All / Weather / Severe Wx / Bias).
- **Weather alerts** fire automatically on real threshold *crossings* (not every refresh while a
  condition holds): wind or gusts crossing 15 and 25 mph, rain starting/stopping, today's rainfall
  crossing 0.25" and 0.5", and the dirt condition tier changing.
- **Severe Wx alerts** pull from the National Weather Service's official active-alerts API
  (api.weather.gov) for Saratoga's coordinates — the actual government source that triggers
  real-world race delays (severe thunderstorms, lightning, excessive heat), not our own heuristic.
  Only Moderate-severity-and-up alerts surface (Minor/Unknown, e.g. routine air-quality advisories,
  are filtered out); an alert fires once when it becomes active and again when NWS lifts it.
- **Bias alerts** fire whenever the Daily Log or Bias Tracker gains or updates an entry.
- Capped at the 50 most recent alerts, newest first.

**Racing News Wire** (its own sidebar page)
- A dedicated page (left sidebar → News Wire) pulling general racing-industry news from three free
  RSS feeds — DRF, Thoroughbred Daily News, and America's Best Racing — merged, sorted newest-first,
  capped at 30 items in a card grid, refreshing every 15 minutes. DRF's feed exposes CORS directly;
  TDN and ABR don't, so those two route through rss2json.com (free, keyless) to be readable from the
  browser.
- Deliberately **not** filtered to Saratoga-only (would sit empty for long stretches outside major
  local stories) — items mentioning Saratoga by name are flagged instead, so they still stand out
  inside the general wire.
- If one source fails, the other two still render — a single feed hiccup doesn't blank the panel.

## What's stubbed out or planned but not built yet

- **Scratch and Odds alerts** — the alert system already has `scratch` and `odds` categories
  defined (icon/label/color) in `ALERT_TYPES`, but with `enabled: false` and no data source, so
  their filter buttons don't render yet. Wiring one up later is a matter of plugging in a feed and
  flipping the flag — no UI restructuring needed. (Scratches specifically are a hard problem: see
  `DECISIONS.md` for why Equibase isn't a usable free source.)
- **Shared/cross-device storage** — the Daily Log, Bias Tracker, and Alert Feed currently live in
  `localStorage` only (see Known Limitations). Firebase Firestore has been chosen as the direction
  for making this shared across visitors/devices; setup is paused mid-way (a Firebase project needs
  to be created before the app-side wiring can be built and verified) — see `DECISIONS.md`.
- **Multi-track support** — the dashboard is hardcoded to Saratoga. A `TRACKS` object + a track
  selector in the header is the natural next step (swap `LAT`/`LON` and the track photo per track).

## Known limitations

- **`localStorage` only, no backend.** The Daily Log, Bias Tracker, Alert Feed, and alert dedupe
  state all live in the visitor's own browser. They don't sync across devices, aren't visible to
  anyone else viewing the site, and are gone if the browser's site data is cleared. This is a static
  file with no server — there's nowhere else for this to live yet (Firestore wiring is planned, see
  `DECISIONS.md`).
- **Single track, hardcoded.** Saratoga's coordinates (`LAT`/`LON`) and photo are constants in the
  script, not configurable from the UI.
- **Track condition / turf split are heuristic estimates, not official calls.** They're clearly
  labeled as such everywhere they appear, and the NYRA panel next to them is the real source of
  truth when the two disagree.
- **Radar "Now" mode can't look far ahead** — real weather radar physically can't forecast days out;
  that's what the "Forecast — Storms" toggle is for, and it's model data (ECMWF), not observed
  radar, so it's less precise about "right now."
- **Historical Lookup lags ~5 days.** Open-Meteo's archive (ERA5 reanalysis) isn't available for the
  most recent few days yet — the date picker is capped accordingly.
- **Wind Forecast Scrubber only projects 6 hours ahead**, limited by how far out we pull 15-minute
  resolution data.
- **No authentication.** The site (and anything added to it later) is fully public.

## How to run it locally

This is a static file — no `npm install`, no `pip install`, no build step. Two ways to run it:

1. **Quickest look:** double-click `index.html` to open it directly in a browser. Works for basic
   viewing, but some browsers restrict embedded iframes (NYRA, Windy) differently under a `file://`
   URL than a real server would.
2. **Recommended (matches production behavior):** serve it locally, e.g.
   ```bash
   python3 -m http.server 8000
   ```
   then open `http://localhost:8000`. In VS Code, the **Live Server** extension works the same way
   (right-click `index.html` → "Open with Live Server").

## Setup notes

- **No API keys, anywhere.** Every data source used is free and keyless:
  - [Open-Meteo](https://open-meteo.com) — current conditions, hourly/15-min/daily forecast, and
    the historical archive API.
  - [Windy.com](https://www.windy.com) embed — live radar and multi-day precipitation forecast.
  - NYRA's own site — live scratches/track-condition/rail iframe, embedded directly (the same iframe
    NYRA uses on their own page).
  - [National Weather Service API](https://api.weather.gov) — official active severe-weather
    alerts for Saratoga's coordinates.
  - [DRF](https://www.drf.com), [Thoroughbred Daily News](https://www.thoroughbreddailynews.com),
    [America's Best Racing](https://www.americasbestracing.net) RSS feeds — Racing News Wire.
    TDN/ABR route through [rss2json.com](https://rss2json.com) (free, keyless) since they don't
    expose CORS themselves.
- **Refresh rate** is set in the script:
  ```js
  const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
  ```
  Open-Meteo's free tier is generous, but don't go below ~1 minute on a public-facing page.
- **Deploying:** this repo auto-deploys to GitHub Pages on every push to `main` (usually live within
  a minute or two). The repo has a `.nojekyll` file — don't remove it, or Pages builds can start
  failing intermittently again (see `DECISIONS.md`). To point this at a different host instead:
  it's just `index.html` + `assets/`, so it can be embedded as a page/section on an existing site,
  dropped into an `<iframe>`, or hosted anywhere static files work (Netlify, Vercel, S3, etc.).

## See also

- `DECISIONS.md` — running log of why key architectural/data-source choices were made, so they
  don't get relitigated from scratch. Check it before proposing a different data source, storage
  approach, or platform for something already decided here.
