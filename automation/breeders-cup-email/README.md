# Breeders' Cup pre-entry digest emails (one-off, not recurring)

Sends two emails — one for Friday's card, one for Saturday's — listing every Breeders' Cup
pre-entry race in order, horses sorted alphabetically within each race, with any matching
Stable Tour notes attached per horse. Built 2026-10-24 at the user's explicit request, scheduled
to run once at 7am ET on 2026-10-25 (Sunday).

**This is NOT a recurring pipeline.** Once the real draw happens, this script (and this whole
folder) should be deleted — the standard entry-alert email system (`runEntryAlerts()` in
`workers/stable-tour-feed.js`) takes over at that point, same as every other tracked track.

## What it does

1. Reads `BREEDERS_CUP_2026` straight out of `index.html` (same data the frontend's Breeders' Cup
   tab uses) — no separate data file to keep in sync.
2. Fetches the live Stable Tour notes from the Worker's `/data` route.
3. For each day, each race (in the order the card runs), each horse (alphabetical) — attaches any
   notes whose `horse` field matches that horse name (case-insensitive, trimmed), same matching
   rule the frontend's BC notes subsection uses.
4. Renders two emails using the real Keeneland theme color already defined in
   `STYLED_DIGEST_TRACK_THEME` (Breeders' Cup runs at Keeneland this year) and the same
   ribbon-header note-card look the real entry-alert emails use.
5. Sends each through `POST /send-custom-email` — a small generic relay added to the Worker
   2026-10-24 specifically because every other email route is hardwired to the real-drawn-entries
   data model, which doesn't exist yet for pre-entries.

## Running it

```bash
python3 send_bc_preentry_digest.py
```

No dependencies beyond the standard library — deliberately, so a fresh checkout (e.g. a scheduled
cloud run) doesn't need a venv or `pip install` step first.

Requires the Worker's `/send-custom-email` route to already be deployed (manual Cloudflare
dashboard paste-and-deploy, like every other Worker change in this repo).
