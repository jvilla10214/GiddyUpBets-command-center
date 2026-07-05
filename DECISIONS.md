# Decisions Log

A running record of why key architectural and data-source choices were made in this project, so
future work doesn't re-litigate settled questions. Newest at the top. When we make a new
meaningful architectural or data-source decision, add a new entry here in the same format.

---

## NWS active-alerts API added as a new "Severe Wx" alert category
**Date:** 2026-07-05
**Decision:** Added a `severe` category to the existing Alert Feed, sourced from the National
Weather Service's free, keyless `api.weather.gov/alerts/active?point=<lat>,<lon>` endpoint for
Saratoga's coordinates. Only alerts NWS itself rates Moderate severity or higher are surfaced
(Minor/Unknown — e.g. Air Quality Alert — are filtered out). Alerts are diffed against a persisted
"last seen" list (`localStorage`, same edge-triggered pattern as the existing weather-alert
threshold crossings) so an alert fires once when it becomes active and once more when NWS lifts it,
rather than re-firing on every 5-minute poll. Fetched alongside the existing Open-Meteo call inside
`fetchWeather()`, in its own try/catch so a hiccup on the NWS side never breaks the weather display.
**Why:** This is the actual government call that triggers real-world race delays (severe
thunderstorms/lightning, excessive heat) — more authoritative for that purpose than our own
threshold-crossing wind/rain alerts, which are just heuristic reads of raw Open-Meteo numbers.
Confirmed via direct `curl` before building: the endpoint is CORS-open
(`access-control-allow-origin: *`), needs no API key, and returns a clean GeoJSON feature list with
a stable `id`, `event`, `severity`, and `expires` per alert — everything needed for dedupe and
display without scraping or a proxy.
**Alternatives considered:** Deriving "severe weather" purely from Open-Meteo's WMO weather codes
(rejected — WMO codes describe current conditions, not government-issued watches/warnings, so
there's no way to know a Severe Thunderstorm Warning or Excessive Heat Warning is in effect from
weather codes alone); surfacing every NWS severity tier including Minor/Unknown (rejected — floods
the feed with routine advisories like Air Quality Alerts that don't affect racing).

## AI Racing Summary: rule-based template filling, not a live LLM call
**Date:** 2026-07-05
**Decision:** Added a highlighted "briefing" callout near the top of the dashboard, labeled
**Automated — Rule-Based**, that generates 2-4 sentences from data already computed elsewhere on
the page (current wind + a last-~3h-vs-prior-~3h trend read, the existing headwind/tailwind-to-the-
stretch math, dirt/turf condition + Drying/Wetting/Holding trend). Sentence choice is gated by
numeric thresholds against a fixed set of templates — no external API call, no LLM in the loop.
**Why:** The point was "AI-sounding" commentary the user could trust, not a black box. A rule-based
generator means every sentence is traceable to a specific number already on screen and testable in
isolation (verified against ~6 synthetic scenarios — increasing wind with a future headwind onset,
already-headwind-and-strengthening, easing headwind, calm, rain-but-still-fast, wetting trend,
tailwind — before wiring it into `render()`, per the project's stage-then-verify pattern). Two
data gaps shaped the wording: there's no race post-time schedule (Race Card was removed, see below),
so a future headwind is described by an actual clock time from the Wind Forecast Scrubber's steps
instead of "Race X"; and there's no geographic rain data, so rain is described as "in the area"
rather than inventing a direction like "north of the course."
**Alternatives considered:** A real LLM call (rejected — no backend to hold a key, and the user
explicitly wanted rule-based-with-thresholds for now, matching how Track Play Analysis already
works); inventing race-number or directional specifics to match the more vivid example phrasing
(rejected — would state things the data doesn't actually support).

## Consolidate Radar + Futurecast into one panel
**Date:** 2026-07-05
**Decision:** Replaced two separate widgets (a RainViewer-tiles-on-Leaflet radar map, and a
standalone Windy.com forecast iframe) with a single "Radar & Storm Forecast" panel: one Windy
embed whose `src` we swap between Windy's real-radar product and its ECMWF rain-forecast product,
via two buttons we built ourselves ("Now — Radar" / "Forecast — Storms").
**Why:** The user wanted one consolidated radar showing current *and* future rainfall/storms, not
two disconnected widgets. Windy's embed already includes an internal product switcher, but it lives
inside a cross-origin iframe we can't script or verify programmatically — building our own toggle
means every state is something we can actually test, rather than trusting an unverified internal
UI. This also let us drop RainViewer/Leaflet entirely (one fewer dependency, and RainViewer's free
nowcast only ever covered ~30-60 min ahead anyway, so Windy's radar product wasn't a downgrade).
**Alternatives considered:** Keep both panels but visually group them; try to make Windy's own
in-embed switcher work and just document it; try to overlay real forecast tiles on our own Leaflet
map (not possible for free — Windy doesn't expose raw forecast tile URLs outside a paid API).

## Move Alert Feed from a permanent sidebar to a header bell + dropdown
**Date:** 2026-07-04
**Decision:** The Alert Feed was originally built as a permanent third grid column (later made
collapsible), then moved to a notification bell icon in the header with an unread-count badge and
a dropdown popover, reusing the same filter/render logic.
**Why:** The permanent column was taking up too much layout room even when collapsed (a CSS grid
column still reserves its width). The user asked for alternatives; a header bell + dropdown reclaims
100% of that space when not in use and is a familiar, zero-explanation-needed pattern.
**Alternatives considered:** A slide-out drawer (similar space reclaim, more animation work for no
extra benefit here); toast notifications with a history button (more "ephemeral," less of a
persistent list to scan). Bell + dropdown was the smallest footprint and reused the most code.

## Add `.nojekyll` to fix intermittent GitHub Pages build failures
**Date:** 2026-07-04
**Decision:** Added an empty `.nojekyll` file to the repo root.
**Why:** This repo had no `.nojekyll`, so every GitHub Pages deploy ran through GitHub's legacy
Jekyll processing pipeline even though the site is plain static HTML/JS with no Jekyll needs. One
deploy got stuck "building" indefinitely (fixed by manually re-triggering at the time) and a later
deploy outright failed with `"Page build failed"` — same root cause both times, confirmed via the
Pages API (`pages` resource showed `"status":"errored"`). Skipping Jekyll entirely removes this
whole class of failure.
**Alternatives considered:** None seriously — this is the standard, well-known fix for this exact
symptom on a static (non-Jekyll) site.

## Remove Race Card / Post-Time Forecasts
**Date:** 2026-07-04
**Decision:** Removed the Race Card feature entirely (race number + post time entry, bulk-paste
parser, per-race weather lookup) — markup, CSS, and all related JS.
**Why:** User request — no longer wanted on the dashboard. Superseded whatever value the
paste-based post-time workflow (below) was providing.
**Alternatives considered:** N/A — direct removal request.

## Unified Alert Feed: local rule-based detection, not an external notification service
**Date:** 2026-07-04
**Decision:** Weather alerts are generated client-side by comparing each new fetch's derived state
(wind tier, rain active/inactive, rainfall tier, dirt condition tier) against a persisted previous
state, edge-triggered so sustained conditions don't refire every 5-minute poll. Bias alerts fire
from the same in-page code whenever the Daily Log changes. Everything is stored in `localStorage`
via the same pattern as the Weather Log.
**Why:** Consistent with the "no backend" constraint — there's no server to run a real push/webhook
notification pipeline from, and a local rule engine is fully within what a static page can do
reliably. Built and verified in stages (detection logic tested directly via 10 synthetic transition
cases before any UI existed, then UI against sample data, then wired together) per explicit
feedback that large features should be verified incrementally, not shipped as one big change.
**Alternatives considered:** None seriously explored — a client-only rule engine was the obvious fit
given the architecture; the open questions were about *where alerts render* (see the bell/dropdown
entry above), not how they're generated.

## Firebase Firestore chosen as the future shared-storage backend
**Date:** 2026-07-04
**Decision:** When asked to make the Weather Log "go live on the site" (visible to all visitors, not
just the browser that logged it), the user chose Firebase Firestore over Supabase or a simpler
JSON-blob store (e.g. JSONBin.io) as the eventual shared database. Setup (installing Node/npm,
then `firebase-tools`) was started but interrupted before a project was actually created or wired
into the app — **this is not implemented yet**, only decided.
**Why:** Firestore has a public-safe "client config" model (access controlled by server-side
security rules, not by keeping the config secret) that fits a static-site-with-shared-data use case
well, same general shape as Supabase's anon-key model. The user's call between the two was
Firestore.
**Alternatives considered:** Supabase (hosted Postgres, same public-safe-key pattern — presented as
the recommended option but not what was chosen); JSONBin.io-style flat JSON store (simplest to set
up, but cruder — no real querying, easier to accidentally overwrite data, less room to grow into a
future bias tracker).

## Track Condition & Weather Log stored in `localStorage`, not a real database
**Date:** 2026-07-04
**Decision:** The Daily Log (and, later, the Alert Feed) persist via `localStorage` rather than any
server-side storage.
**Why:** The app has no backend by design (see "single-file HTML/JS" below), and `localStorage` is
the only persistence mechanism available to a pure static page. It's genuinely durable across
reloads and browser restarts — the gap is only that it's per-browser/per-device, not shared across
visitors. That gap is exactly what the Firestore decision above is meant to eventually close.
**Alternatives considered:** No persistence at all (rejected — defeats the purpose of a "data
foundation for a bias tracker" that needs to accumulate over days); a real backend database
(rejected *for now* since it's a real scope/cost/infrastructure change from "single static file,
no server" — revisit once Firestore is actually wired in).

## NYRA scratches/rail/turf-condition data: embed live, don't scrape
**Date:** 2026-07-04
**Decision:** The "Track Conditions & Rail" panel embeds NYRA's own CDN-hosted scratches page
(`tr-cdn.nyra.com/direct/scratches/SARscratch.html`) directly in an iframe, cache-busted on the same
5-minute refresh cycle, rather than fetching and parsing it into our own data.
**Why:** Cross-origin browser security (same-origin policy) blocks reading a cross-origin iframe's
DOM, and a direct `fetch()` to that URL is blocked by CORS — confirmed by testing both. Embedding
the exact iframe URL NYRA already uses on their own public page is legitimate (it's not
circumventing anything; it's the same embed they serve) and gives live, official data with zero
manual entry, at the cost of not being able to parse it into our own structured data (e.g., to feed
the Track Play Analysis automatically).
**Alternatives considered:** Scraping via a CORS proxy (works technically, but see the Equibase
entry below for why deliberately routing around a site's access model is a line we don't cross);
parsing the page server-side (would require standing up a backend, out of scope).

## Race-card post times: paste-in instead of scraping Equibase
**Date:** 2026-07-03
**Decision:** Built a flexible bulk-paste parser (accepting formats like `"1 1:05 PM"`, `"Race 2:
1:35pm"`) for entering a day's post times, instead of automatically pulling them from Equibase.
**Why:** Equibase's post-time pages are protected by Incapsula bot-detection — confirmed by testing
a direct `fetch()` (CORS-blocked), an iframe embed (loads visually but its DOM can't be read
cross-origin), and two different public CORS proxies (both got served Equibase's bot-challenge wall
instead of real content, with response headers explicitly identifying Incapsula). This isn't a
"wrong URL" problem; it's a deliberate technical barrier, and defeating anti-bot protection to pull
data from a commercial data provider is not something to build around. NYRA's own post-time pages
were checked too and found to only contain generic season-wide policy text, not daily schedules.
**Alternatives considered:** A paid Equibase/DRF data feed (out of scope — user explicitly wanted
free-only); scraping via a proxy anyway (rejected on the grounds above).
**Note:** The Race Card feature this served was later removed entirely (see 2026-07-04 entry
above) — this decision is kept here for the reasoning, in case per-race auto post-times are
reconsidered later.

## Track condition and turf/dirt splits are heuristic estimates, not official data
**Date:** Initial build (first committed 2026-07-03)
**Decision:** "Main Track (Dirt)" and "Turf Course" condition badges are computed client-side from
Open-Meteo rainfall data using simple, clearly-labeled threshold heuristics (dirt weights the
instant rain rate + today's total; turf weights rolling 24h/48h totals, since turf drains slower and
stays soft longer after rain than dirt does), not sourced from an official feed.
**Why:** There's no free, official, real-time track-condition API — the actual call is made by the
track superintendent/stewards and published on NYRA's own site. Rather than pretend to have official
data, the app computes an honestly-labeled estimate and displays it directly alongside NYRA's real
scratches/conditions panel for comparison, so the two are never confused with each other.
**Alternatives considered:** Only showing the NYRA official panel and skipping our own estimate
(rejected — the heuristic is still useful on its own, e.g. for the Wind Forecast Scrubber's
*projected* conditions, which NYRA obviously can't provide since it hasn't happened yet).

## Single-file HTML/JS app instead of Streamlit/Python
**Date:** Initial build (first committed 2026-07-03)
**Decision:** The entire dashboard is one `index.html` file (HTML + CSS + JS inline), with no
backend, no build step, and no framework.
**Why:** The goal was something that could be opened directly in a browser or dropped onto any
static host (GitHub Pages, embedded as an iframe on the main GiddyUpBets site, etc.) with zero
setup — no Python environment, no `pip install`, no server process to keep running. A Streamlit app
would require a persistent Python process (real hosting cost/complexity) for a dashboard that's
fundamentally just "fetch some JSON and render it," which plain JS handles fine.
**Alternatives considered:** Streamlit/Python (rejected — needs a running server, heavier
deployment story); a JS framework build step like React/Vite (rejected — adds tooling/build
complexity with no real benefit at this scale; a single file is easier to hand off and reason about
end to end).

## Open-Meteo instead of a paid weather API
**Date:** Initial build (first committed 2026-07-03)
**Decision:** All core weather data (current conditions, hourly/15-minute/daily forecast, and later
the historical archive) comes from [Open-Meteo](https://open-meteo.com).
**Why:** It's free with no API key and no rate-limit-driven backend needed to hide a secret, has
generous limits for a low-traffic dashboard, and covers everything needed: current conditions,
short-term (15-min) forecast for the scrubber, daily aggregates for the log, and a free historical
archive (ERA5 reanalysis) for the lookback feature. A paid API (e.g. Tomorrow.io, Weather.com/IBM)
would require a backend to keep the key secret, contradicting the single-file/no-backend goal.
**Alternatives considered:** NWS/NOAA API (US-only, less convenient historical archive access);
paid providers (rejected — would force a backend into existence just to hide a key, for data
Open-Meteo already provides for free).
