# NYRA Broadcast Quote Pipeline (GitHub Actions)

Watches [@thenyra's YouTube streams](https://www.youtube.com/@thenyra/streams) for new
"America's Day at the Races" broadcasts — posted every NYRA racing day, 4.5-6 hours each —
transcribes the full show, and pulls out two kinds of content, writing both into the shared
Stable Tour store (same database the Entries tab and the morning entry-alert emails read from):

1. **Maggie Wolfendale's paddock analysis** — her own third-person observation about a horse
   walking into the paddock before its race, filed as a normal note with the trainer auto-matched
   from that day's real NYRA entries. Deliberately scoped to Maggie only (2026-10-16 decision) —
   Megan Burgess and Acacia Clement also do paddock reads on this broadcast, excluded here.
2. **Post-race trainer/jockey interviews** — any interviewer counts (Maggie, Megan, Acacia, or
   anyone else); what matters is who's being interviewed, not who's asking.

Same shape as `automation/kentucky-hbpa/` and `automation/podcast-quotes/` (this project's
established convention: duplicate a working pipeline rather than share code), but this is the one
pipeline in the repo actually dealing with multi-hour source audio.

## Why the discovery source is "streams," not "videos"

The channel's `/videos` tab interleaves full broadcasts unpredictably with dozens of short
race-call clips and Spanish-language recaps — confirmed during the original investigation that
only 2 full broadcasts showed up in the last 60 `/videos` uploads. `/streams` (past live streams)
has posted one every single racing day without a gap, titled cleanly as `"America's Day at the
Races - <date>"` — trivial to filter on and reverse-chronological by default. The same tab also
carries a daily "Talking Horses" show, filtered out by title.

## Why this transcribes the whole broadcast in one run

The original (2026-09-18) manual research hit a real Groq Whisper rate limit (7,200 seconds of
audio per hour) processing a 6-hour show — at the time, that forced spreading the work across
multiple sessions. A live test against this account on 2026-10-16, before building this pipeline,
showed only a request-count rate limit (2,000 requests per rolling window) — a full broadcast only
needs ~8-10 chunked transcription requests, trivially inside that. So this pipeline transcribes
everything in one run rather than pre-building complex multi-run pacing logic for a constraint
that no longer appears to bind on this account. If that assumption turns out wrong in practice, a
failed run just leaves the broadcast unprocessed for the next scheduled run to retry — no
different from any other transient failure this pipeline already handles that way.

## How identification works

- **Finding candidate segments**: grep the full stitched transcript for cue phrases (`config.py`'s
  `MAGGIE_CUE_PATTERNS` / `INTERVIEW_CUE_PATTERNS`) instead of sending 4.5-6 hours of transcript to
  Claude — same "grep for cues, don't read linearly" approach the original manual process used.
  This is high-recall, low-precision on purpose; Claude does the real filtering next.
- **Extracting content**: `extract_quotes.py` (paddock) and `extract_interviews.py` (interviews)
  send just the candidate windows to Claude, which decides per-window whether it's genuinely
  Maggie's paddock analysis / a real trainer-jockey interview, or a false positive to discard.
- **Resolving the horse's trainer**: `write_notes.py` looks up that day's real NYRA entries (
  `GET /raceday?track=belmont|saratoga&date=...`, already built for this store's Race Day Archive)
  to find the horse's actual trainer, rather than trusting a name the transcript might not state
  clearly. A horse not found there (wrong track that day, a transcription slip) still gets filed
  trainer-less rather than dropped — same precedent as the original manual process's
  Long-Legged Queen case: the horse-note link matters more than having a trainer attached.
- A never-before-seen trainer/jockey is auto-tracked (tags `nyra-maggie-auto-unverified` /
  `nyra-interview-auto-unverified`) rather than requiring the name to already be tracked — current
  standing policy, not an oversight. No per-run review table before filing either, per explicit
  user decision (2026-10-16) — same auto-file-then-audit approach as the other two pipelines.

## One-time setup

Reuses the same `GROQ_API_KEY`/`ANTHROPIC_API_KEY` secrets the other two pipelines already have —
nothing new to add.

### Test locally before trusting the schedule

```bash
cd automation/nyra-broadcast-quotes
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
brew install ffmpeg   # if you don't already have it
cp .env.example .env  # then paste your two keys into .env yourself — never commit it
./venv/bin/python run.py
```

First run just seeds state with the current streams listing — expected. To force a real test,
remove one known video ID from `state/processed_video_ids.json` and re-run (this downloads and
transcribes a real multi-hour broadcast — budget real time and API cost for a manual test run).

### Test the real GitHub Actions workflow before relying on the schedule

Repo → **Actions** tab → **NYRA Broadcast — Maggie's paddock notes & interviews** →
**Run workflow**.

## Schedule

Runs once daily at 03:10 UTC (11:10pm ET during EDT, 10:10pm during EST) — well after that day's
broadcast has aired and posted. Only one new broadcast exists per day, so once daily is enough
(unlike Kentucky HBPA's twice-daily schedule for a channel with multiple short uploads per day).

## Files

- `config.py` — channel URL, Worker base URL, NYRA tracks to try for entries lookup, cue phrase
  lists, source tags, `.env` loader.
- `discover.py` — streams-tab listing, title filtering, processed-video state, upload-date lookup.
- `transcribe.py` — audio download, ffmpeg chunking, Groq Whisper calls, timestamped transcript
  stitching (`[HH:MM:SS] text` format, the same convention the original manual process used).
- `find_segments.py` — cue-phrase grep + window-merging for both paddock and interview candidates.
- `extract_quotes.py` — Claude extraction + bullet parser for Maggie's paddock analysis.
- `extract_interviews.py` — Claude extraction + bullet parser for trainer/jockey interviews.
- `write_notes.py` — trainer resolution via the real Race Day Archive (paddock) or
  nickname/successor-aware auto-track (interviews), and `POST /notes` writes with the same
  race-safe verify-and-retry pattern as the other two pipelines.
- `run.py` — orchestrator; runs both extraction passes over one transcript per broadcast.
- `state/processed_video_ids.json` — committed; the "already seen" broadcast list.
- `credentials/`, `logs/`, `tmp/`, `.env`, `venv/` — all gitignored.
