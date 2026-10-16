# Kentucky HBPA Quote Pipeline (GitHub Actions)

Watches the [Kentucky HBPA YouTube channel](https://www.youtube.com/@kentuckyhbpa7026) for new
videos — short (2-15 min), well-produced trainer/jockey interviews and work reports, mostly tied
to Keeneland/Churchill Downs graded stakes and Derby/Breeders' Cup prep — transcribes each one,
extracts trainer/jockey quotes about a named horse, and writes them straight into the shared
Stable Tour store, same database the Entries tab and the morning entry-alert emails already read
from. Same shape as `automation/podcast-quotes/` (this project's established convention: duplicate
a working pipeline rather than share code), adapted for a YouTube source instead of an RSS feed.

## How this differs from the Steve Byk podcast pipeline

- **Discovery, not filtering.** The Byk feed publishes 350+ historical episodes, mostly broad
  industry round-tables, so `fetch_feed.py` only queues episodes whose title matches an
  already-tracked trainer. This channel is already narrowly scoped (a handful of uploads per race
  day, all about graded-stakes-caliber horses) — `discover.py` queues every new video, no title
  filter. See that file's docstring for the full reasoning, including why a trainer-name filter
  would actively fight the current auto-track-everything policy
  (`project_auto_track_trainers_shipped_2026-10-11` in memory).
- **Speaker identity isn't known ahead of time.** The Byk pipeline already knows which tracked
  trainer is being interviewed before it transcribes anything. Here the speaker could be a
  trainer, jockey, owner, or bloodstock agent — `extract_quotes.py` asks Claude to identify both
  the speaker and their role (using the video title, which very often already names them, plus
  the transcript's own context) rather than assuming a known trainer.
- **Auto-tracks new trainers/jockeys.** `write_notes.py` adds a never-before-seen trainer/jockey
  via `POST /trainers` or `POST /jockeys` (tagged `kentuckyhbpa-auto-unverified`) instead of
  erroring out — current standing policy, not an oversight.
- **Only trainer/jockey quotes get filed.** An owner or bloodstock agent's commentary is real
  content but has no field in the note schema — those get recorded in
  `state/dropped_quotes.json` (reason `non_trainer_jockey_role`) instead of silently discarded.

## Pipeline stages

1. `discover.py` — list the channel's recent uploads via `yt-dlp --flat-playlist`, track
   processed video IDs in `state/processed_video_ids.json` (committed back by the Action each
   run). First run seeds state without processing anything, same "don't backfill the whole
   channel on day one" guard as the Byk pipeline.
2. `transcribe.py` — download a video's audio via `yt-dlp -x --audio-format m4a`, transcribe via
   Groq's Whisper API (`response_format=verbose_json`). Most clips are under Groq's ~25MB
   per-request limit in one call; a chunking fallback (ffmpeg stream-copy, same approach as the
   Byk pipeline) kicks in automatically for longer videos — confirmed necessary in testing (a
   14-minute clip ran 33MB, over the limit).
3. `extract_quotes.py` — send the title + transcript to Claude, parse the bullet-list response
   into `{timestamp, speaker, role, horse, question, quote}` entries.
4. `write_notes.py` — resolve or auto-track the speaker, skip non-trainer/jockey roles and
   unclear horses/speakers, `POST /notes` one entry at a time with the same race-safe
   verify-and-retry pattern as the Byk pipeline (a real KV read-modify-write race has repeatedly
   dropped notes under rapid sequential writes in this project). Link uniqueness uses a running
   per-(horse, timestamp) counter rather than trusting the model's timestamp alone — confirmed
   necessary in testing (one real sample had 6 distinct Q&A bullets about the same horse all
   stamped with an identical timestamp, which would have silently collapsed to one note under the
   Worker's (name, horse, link) dedup).
5. `run.py` — orchestrates all of the above per video; never marks a video processed if it
   errored partway through, so a transient failure retries next run instead of silently dropping
   the video.

## One-time setup

### 1. Get API keys

Same two keys as `automation/podcast-quotes/` — reuse the same GitHub Actions secrets
(`GROQ_API_KEY`, `ANTHROPIC_API_KEY`) if already configured; no new secrets needed.

### 2. Test locally before trusting the schedule

```bash
cd automation/kentucky-hbpa
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
brew install ffmpeg   # if you don't already have it
cp .env.example .env  # then paste your two keys into .env yourself — never commit it
./venv/bin/python run.py
```

The very first run just prints a "seeded state, nothing processed" message — expected. To force a
real test end-to-end, remove one known video ID from `state/processed_video_ids.json` and re-run.

### 3. Test the real GitHub Actions workflow before relying on the schedule

Repo → **Actions** tab → **Kentucky HBPA — trainer/jockey quote extraction** → **Run workflow**
(the `workflow_dispatch` trigger). Watch the run log for each stage's output.

## Schedule

Runs twice daily — 16:00 and 01:00 UTC, i.e. 12:00pm and 9:00pm America/New_York during EDT
(11:00am and 8:00pm during EST). Fixed UTC time, no DST adjustment, same convention as the Steve
Byk and Barn Notes pipelines' schedules. Adjust the cron expressions in
`.github/workflows/kentucky-hbpa.yml` if real posting-time patterns suggest a better split.

## Files

- `config.py` — channel URL, Worker base URL, model choices, source tags, `.env` loader.
- `discover.py` — channel listing, processed-video state, per-video upload-date lookup.
- `transcribe.py` — audio download, ffmpeg chunking, Groq Whisper calls, transcript stitching.
- `extract_quotes.py` — the Claude extraction prompt and bullet-list parser.
- `write_notes.py` — speaker resolution/auto-track and `POST /notes` writes with race-safe
  verification.
- `run.py` — orchestrator.
- `state/processed_video_ids.json` — committed; the "already seen" video list.
- `credentials/`, `logs/`, `tmp/`, `.env`, `venv/` — all gitignored.
