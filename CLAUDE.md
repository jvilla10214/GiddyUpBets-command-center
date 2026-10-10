# GiddyUpBets Command Center

Two independent pieces that deploy differently — keep that straight before touching either one.

## 1. Frontend — `index.html` (static, GitHub Pages)

A single-file dashboard (HTML+CSS+JS inline, no build step, no framework) for Saratoga
race-day conditions: live weather/wind/track condition, radar, NYRA scratches embed, a
rule-based (not LLM) handicapping read, Daily Log, Bias Tracker, News Wire, Race Recaps.

- **Deploy:** auto-deploys to GitHub Pages on every push to `main` (live within ~1-2 min at
  https://jvilla10214.github.io/GiddyUpBets-command-center/). Don't remove `.nojekyll` —
  Pages builds have broken intermittently without it before.
- **Local preview:** no server needed for a quick look (just open the file), but iframes
  (NYRA, Windy) behave more like production under a real server:
  ```bash
  python3 -m http.server 8000
  ```
- **`README.md` is stale** (last substantively edited mid-July) — it describes the
  original "no backend, no API keys" version accurately for the frontend, but predates the
  Worker backend below entirely. Don't trust it for anything backend-related.

## 2. Backend — `workers/stable-tour-feed.js` (Cloudflare Worker + KV)

Despite the filename, this is now the shared backend for most of the app's server-side
features: Daily Log / Bias Tracker shared storage, Stable Tour trainer notes, Race Recaps
(pulled from a Google Doc), tracked-horse entry-alert emails (Resend), Del Mar/Saratoga
entries import, and a couple of Cron Triggers. Each numbered section in the file's header
comment documents one feature/route.

- **Deploy is manual, not git-triggered:** paste the file into the Cloudflare dashboard's
  Workers editor and hit Deploy. Pushing to `main` does **not** update the live Worker —
  don't assume a `git push` shipped a backend change.
- **Requires a KV namespace** bound as `STABLE_KV` (Worker settings → Bindings).
- **Secrets** (set in the Cloudflare dashboard, never committed to the repo):
  `RESEND_API_KEY`, `PIRATE_WEATHER_API_KEY`, `SMARTPONY_EMAIL`, `SMARTPONY_PASSWORD`.
- **Account is on Workers Paid** (upgraded 2026-10-09) — 10,000 subrequests/invocation (up from
  50 on free), so the subrequest-budget juggling below is mostly historical now. **The
  5-Cron-Trigger-per-Worker cap is unchanged by the plan upgrade** (paid raises the limit to 250
  per *account* across multiple Workers, not per Worker) — don't assume paid means unlimited
  triggers on this one Worker.
- **4 of this Worker's 5 Cron Trigger slots are in use** (redesigned 2026-10-10 — one slot was
  freed by this change, available for future use). `scheduled()` dispatches on the exact cron
  string, so every expression has to match verbatim in the dashboard — see the Worker's own header
  comment (search `Cron Trigger`) before touching this again:
  - `0 11,12 * * *` (`ENTRY_ALERTS_DAILY_CRON`) — the stable-mail (entry-alert) emails, once daily
    at 7am Eastern (dual UTC hour covers both EDT/EST, code filters to the real current hour, no
    DST edit needed). Runs BOTH the day-of and day-before checks together — "7am day of" and "7am
    day before" are one fire, not two. On demand: `/debug-run-scheduled`.
  - `0 11,12,19,20 * * *` (`NYRA_NEWS_CRON`) — NYRA News import only, 7am/3pm Eastern. On demand:
    `/debug-run-nyra-import`.
  - `0,30 13,21 * * *` (`SIDE_JOBS_CRON`) — most other import/maintenance jobs: BloodHorse, TDN
    main, DRF, Stable Tour feed, TDN notebook, HRN, and SmartPony all run together twice daily
    (13:00 & 21:00); results backfill + note dedupe + trainer angle stats run once daily (13:30,
    the only other slot with work — 21:30 is unused).
  - `*/30 * * * *` (`RECAP_SYNC_CRON`) — two things piggybacked on the same 30-min cadence: (1)
    re-pulls the Race Recap Google Doc so an edit shows up without clicking "Re-sync" (only
    explicitly-labeled sections, e.g. "Belmont - 9/19", get auto-synced — an unlabeled section is
    deliberately skipped, not guessed); (2) the stable-mail "day of draw" check — sends a horse's
    digest the moment its card's entries are drawn, same day, instead of waiting for the once-daily
    7am check above (same dedup key, so whichever reaches a horse first is the real send).
- `automation/nyra-harness/` is a local-only test harness for the NYRA News extractor
  (`node run.mjs` scores it against hand-labeled articles). Run it before changing that code.

## Conventions

- **Commits go straight to `main`** — no branch/PR workflow in use on this repo currently.
- **Build multi-part features in verified stages** (logic → storage → UI → wire-up), not as
  one big change — confirm each stage works before moving to the next.
- **Free/keyless data sources only**, by design on the frontend side — no paid weather or
  data APIs, no backend just to hide a key. (The Worker does hold a couple of real API
  keys/secrets for email and weather, but those live in Cloudflare's dashboard, not in code.)
- **Don't build around bot-detection.** Equibase and Racing Post both actively block
  scraping (Incapsula / bot-challenge walls) — this has been tested multiple times and
  confirmed deliberate. Treat that as a hard boundary, not a bug to route around with proxies.
- **Check `DECISIONS.md` before proposing a different data source, storage approach, or
  platform** — it's a running log of why the current choices were made (Open-Meteo over
  paid weather APIs, Cloudflare Worker+KV over Firebase, single-file HTML over a framework,
  embedding NYRA's iframe instead of scraping it, etc.), so those don't get relitigated from
  scratch.
