# Decisions Log

A running record of why key architectural and data-source choices were made in this project, so
future work doesn't re-litigate settled questions. Newest at the top. When we make a new
meaningful architectural or data-source decision, add a new entry here in the same format.

---

## Split Historical Weather Data and Bias Tracker into their own sidebar pages
**Date:** 2026-07-08
**Decision:** The "Track Condition & Weather Log" panel (previously a 3-tab panel — Daily Log,
Historical Lookup, Bias Tracker — living on the Dashboard page) is now two sidebar pages: **Historical
Weather Data** (Daily Log + Historical Lookup, still as two tabs within that one page — they're both
"look at recorded/archived weather" views, so keeping them together as tabs still made sense) and
**Bias Tracker** (fully standalone, no tab bar — it was the third tab in a group of three, and with
group size down to one, a tab switcher over a single always-visible tab was pure clutter). All
underlying storage, cross-referencing (Bias Tracker rows still look up that date's Dirt/Turf from
`weatherLog`), and alert-push behavior is unchanged — this was purely a navigation/layout move, same
IDs and functions, just relocated in the DOM and added to `SIDEBAR_PAGES`.
**Why:** User request, continuing the same "one stop shop" sidebar direction from the News Wire
move — with Historical Weather Data and Bias Tracker now dedicated pages, the Dashboard page is
lighter (down to live conditions, wind/compass, Track Play Analysis, AI Racing Summary, NYRA panel,
and Radar), and each area gets a full page's worth of room instead of competing for space in one
long scrolling panel.
**Alternatives considered:** Keeping Bias Tracker under a tab bar for consistency with Historical
Weather Data (rejected — a single-tab switcher has nothing to switch between, so the tab UI would
just be dead chrome); merging Historical Weather Data and Bias Tracker into one page since both stem
from the same original panel (rejected — they're different modes of use, one is "auto-collected
sensor-style data," the other is "manual human read," and the user explicitly asked for them as two
separate buttons).

## Sidebar navigation: persistent icon-rail, not a hamburger menu, and moved News Wire to its own page
**Date:** 2026-07-08
**Decision:** Restructured the page around a left sidebar (`.app-shell` = `.sidebar` + one `.page`
per section) instead of one long scrolling page. Two pages exist today — Dashboard (everything that
was already there, minus News Wire) and News Wire (moved out, and given a full-page two-column card
grid instead of the cramped 380px-tall single-column list it had as a right-column tile). The
sidebar is a permanent icon-rail — same on mobile and desktop, not a collapsible hamburger drawer —
config-driven (`SIDEBAR_PAGES` array), same show/hide-over-static-DOM pattern already used for the
Daily Log/Historical Lookup/Bias Tracker tabs.
**Why:** User request, framed around the "Bloomberg terminal / one-stop shop" direction — a
permanent nav rail matches how real trading terminals work and reads as "sections of one workspace"
rather than "tabs you might miss." It also sets up the infrastructure for the Calendar/email-archive
page floated earlier as a future idea: that's just another sidebar button and `.page` div, no
architectural rework needed. A hamburger-style collapsible drawer was the alternative but was
rejected as unnecessary complexity — with only 2-3 pages, a small persistent rail costs little
screen space and needs no open/close state to manage.
**Gotcha hit and fixed while building this:** wrapping the existing `.grid` inside a flex item
(`.page` inside `.app-shell`) broke mobile layout with real horizontal overflow, from two separate
flexbox/grid intrinsic-sizing issues stacked on top of each other — worth documenting since it'll
bite again if this shell is restructured further: (1) `.app-shell` used `align-items: flex-start`
(needed on desktop so the sidebar doesn't stretch to the content column's height), but at the
mobile breakpoint where `flex-direction` switches to `column`, `flex-start` on the now-vertical
cross-axis means "shrink-to-fit content" instead of "stretch to container width" — fixed by
overriding to `align-items: stretch` inside the same `max-width: 900px` media query. (2) Even with
`.page` correctly clamped, `.grid`'s `1fr` track (under `max-width: 900px`) was resolving to its
widest child's max-content size (e.g. the 10-column log table) rather than the container's actual
width, because an `fr` track needs a *definite* container size to resolve against and one wasn't
reliably available through the new flex ancestor chain — fixed with `minmax(0, 1fr)` instead of
bare `1fr` (forces the track's minimum to 0 so it can shrink below content size) plus an explicit
`width: 100%; min-width: 0;` on `.grid` itself. Caught via `document.documentElement.scrollWidth` vs
`clientWidth` in the live preview, not visually — the emulated mobile viewport in this session's
preview tool didn't reliably reflect resizes in `window.innerWidth` reads, so numeric DOM
measurements were the trustworthy signal, not screenshots alone.
**Alternatives considered:** None seriously for the nav pattern itself (hamburger drawer was the
only real alternative, addressed above). For the overflow bug, no alternative fixes were considered
since `minmax(0, 1fr)` + explicit width is the standard, narrowly-scoped fix for this exact
grid/flexbox interaction.

## Racing News Wire: general industry news + Saratoga flagging, not Saratoga-only filtering
**Date:** 2026-07-08
**Decision:** Added a right-column panel pulling merged, newest-first RSS from three sources — DRF
(fetched directly, CORS-open), Thoroughbred Daily News, and America's Best Racing (both routed
through rss2json.com, a free keyless RSS-to-JSON bridge, since neither exposes CORS). Capped at 30
items, refreshes every 15 minutes. The wire shows general racing-industry news; items mentioning
"Saratoga" in the title are visually flagged rather than the feed being filtered to Saratoga-only.
Title/link from every item are rendered via DOM APIs (`textContent`, a real `<a>` element with the
href set as a property) instead of `innerHTML` string interpolation, and links are restricted to
`http(s)://` — both guard against a compromised or malformed feed injecting markup or a
`javascript:` URI, since these are externally-controlled strings.
**Why:** Paulick Report and BloodHorse (the two outlets originally proposed) turned out to have
dropped public RSS in recent site redesigns (confirmed via direct `curl` — 404s on every path
tried), so the source list was substituted for three that actually work. Saratoga-only filtering was
considered but rejected: on a slow news day the wire would just sit empty, which defeats the point
of a "wire" the user glances at regularly; flagging keeps it populated while still surfacing local
relevance. Using rss2json for TDN/ABR is a different situation from the Equibase/NYRA CORS walls
documented elsewhere in this file — RSS is explicitly published for outside programs to consume, not
gated behind bot detection, so bridging the missing CORS header isn't circumventing anything.
**Alternatives considered:** A CORS proxy instead of rss2json (rejected — rss2json is purpose-built
for exactly this browser-can't-read-RSS problem and returns clean JSON instead of raw XML to parse);
building a dedicated "trainer quotes" scraper as a separate feature (rejected — no clean free source
for that specifically; it's already a subset of normal coverage inside DRF/TDN/ABR, so a separate
scraper would be redundant with the general wire).

## Bias Tracker: manual entry, per-racing-day, joined against the Daily Log by date
**Date:** 2026-07-08
**Decision:** Added a third tab ("Bias Tracker") alongside Daily Log/Historical Lookup in the
Track Condition & Weather Log panel. Entries are hand-entered (date, a running-style-bias dropdown,
an optional rail note, free-form notes) and stored in `localStorage` (`giddyupbets_bias_log_v1`),
one entry per date — same grain and same load/save/upsert pattern already used for the Daily Log.
Each rendered row looks up that date's Dirt/Turf condition from `weatherLog` and displays it inline,
so conditions and how-it-played sit side by side without needing to flip tabs. Saving a note pushes
a `bias`-category alert, same as an auto-logged day.
**Why:** There's no free, automated source for "how a card actually played" — real bias reads
(who could and couldn't make the lead work, whether the rail was live or dead) are an inherently
qualitative, human judgment call, not something scraped or pulled from an API. The Daily Log was
explicitly built as the data foundation for this feature (see its original 2026-07-03 entry below)
specifically so this join-by-date would be trivial once bias entry existed. Per-day (not per-race)
grain was chosen because the app doesn't track a race schedule/post-time list — that feature (the
paste-in Race Card) was removed on 2026-07-04 — and per-day matches how the Daily Log already works,
so no new date/race-identity concept had to be introduced.
**Alternatives considered:** Extending the existing Daily Log table with extra bias columns instead
of a separate tab (rejected — that table is already 10 columns wide; a dedicated tab keeps each
table focused while still cross-referencing by date); per-race granularity (rejected — would require
rebuilding some form of race/post-time list, which was deliberately removed and is out of scope
right now).

## Home-screen/favicon branding: horseshoe icon + web app manifest
**Date:** 2026-07-05
**Decision:** Added a real icon set (`assets/favicon-32.png`, `assets/icon-192.png`,
`assets/icon-512.png`, `assets/apple-touch-icon.png`) generated from a horseshoe graphic the user
supplied, padded to a square black-background canvas (matching the site's existing dark theme, and
deliberately opaque rather than transparent — iOS's own guidance is to supply apple-touch-icons
without alpha, since it doesn't composite transparency the way you'd expect), plus a `manifest.json`
(name/short_name/theme_color/icons) so "Add to Home Screen" on phone and "Install" on desktop pick
up the horseshoe instead of a generated default letter tile.
**Why:** There was no favicon, apple-touch-icon, or manifest at all before this, so every platform
fell back to auto-generating a plain letter icon from the page title. This is a static file with no
build step, so the icons are pre-generated once (via `sips`, no new tooling/dependency added) rather
than generated at request time.
**Alternatives considered:** None seriously — this is standard boilerplate for any static site that
wants a real home-screen icon, no architectural tradeoff to weigh.

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
