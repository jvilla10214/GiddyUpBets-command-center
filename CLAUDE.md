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
- Cron Triggers fire `scheduled()` for the entry-alert emails and Stable Tour dedupe; there's
  a `/debug-run-scheduled` GET route to trigger that logic on demand without waiting for cron.

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
