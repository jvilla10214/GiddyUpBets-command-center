# Steve Byk Podcast Quote Pipeline (GitHub Actions, no manual transcription)

Replaces the old manual workflow (download the episode → paste into AI Studio → copy the
output back) with a scheduled GitHub Actions job: it watches the "At the Races with Steve Byk"
RSS feed, transcribes any new episode that features a tracked trainer, extracts trainer/horse
quotes, and writes them straight into the shared Stable Tour store — the same database the
Entries tab and the morning entry-alert emails already read from. No separate email step: the
quotes just show up wherever Stable Tour notes already show up.

## How it decides which episodes to bother with

The feed publishes very frequently (multiple ~50-115MB episodes some days) and most of them are
broader industry round-tables, not trainer interviews. Transcribing everything would be slow and
expensive for little payoff, so `fetch_feed.py` only queues an episode when its **title**
contains a tracked trainer's first *and* last name (a plain last-name match had real false
positives — e.g. broadcaster "Dick Powell" vs. an unrelated trainer surname, or "David Aragona"
matching on trainer Carlos David's last name). Known press nicknames that don't match a tracked
trainer's real name (e.g. "Rusty Arnold" for the tracked "George Arnold") are handled via
`nickname_aliases.json` — add to that file as new mismatches turn up.

**First run seeds state without processing anything.** The feed has 350+ historical episodes;
the very first run just records every guid currently in the feed as "seen" and processes
nothing, so it never tries to backfill the whole catalog. Every run after that only looks at
genuinely new episodes.

## Pipeline stages

1. `fetch_feed.py` — parse the RSS feed, filter to new trainer-matching episodes, track
   processed guids in `state/processed_guids.json` (committed back by the Action each run).
2. `transcribe.py` — download the episode's audio, split it into ffmpeg-cut chunks sized to
   stay under Groq's ~25MB per-request limit (stream-copied, no re-encoding), transcribe each
   chunk with Groq's Whisper API (`response_format=verbose_json` for real per-segment
   timestamps), and stitch everything into one absolute-timestamped transcript.
3. `extract_quotes.py` — send the transcript to Claude with a prompt adapted from the validated
   manual-workflow prompt (see the `project_atr_byk_podcast_prompt` memory). One real difference
   from the old audio-native AI Studio workflow: a Whisper transcript has **no speaker labels**,
   so the prompt explicitly asks Claude to infer who's talking from context (Byk addressing a
   guest by name, first-person answers) rather than relying on labeled dialogue. Expect this to
   be slightly less reliable at speaker attribution than the old audio-native approach on
   confusing crosstalk — it's asked to say "[unclear]" rather than guess.
4. `write_notes.py` — match the trainer's exact tracked spelling and `POST /notes` one entry at
   a time (not `/notes/bulk`, which silently drops anything without a resolved trainer), with a
   short delay between writes and a post-batch re-fetch/diff — both defend against a real KV
   read-modify-write race this Worker has hit before under rapid sequential writes.
5. `run.py` — orchestrates all of the above per episode; never marks an episode processed if it
   errored partway through, so a transient failure retries next run instead of silently
   dropping the episode.

## One-time setup

### 1. Get API keys

- **Groq** (transcription): https://console.groq.com/keys — free tier.
- **Anthropic** (quote extraction): https://console.anthropic.com/settings/keys

### 2. Add them as GitHub Actions secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
- `GROQ_API_KEY`
- `ANTHROPIC_API_KEY`

### 3. Test locally before trusting the schedule

```bash
cd automation/podcast-quotes
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
brew install ffmpeg   # if you don't already have it
cp .env.example .env  # then paste your two keys into .env yourself — never commit it
./venv/bin/python run.py
```

The very first run will just print a "seeded state, nothing processed" message — that's
expected. To force a real test end-to-end, temporarily remove one known trainer-matching
episode's guid from `state/processed_guids.json` and re-run.

### 4. Test the real GitHub Actions workflow before relying on the schedule

Repo → **Actions** tab → **Steve Byk podcast — trainer quote extraction** → **Run workflow**
(the `workflow_dispatch` trigger). Watch the run log for each stage's output.

## Schedule

Runs daily at 11:00 UTC (7am ET / 6am during EDT) — ahead of the morning entries/Stable Tour
email send, so anything new is already in the database by the time that goes out.

## Files

- `config.py` — feed URL, Worker base URL, model choices, `.env` loader.
- `nickname_aliases.json` — press-nickname → tracked-trainer-name map for the title filter.
- `fetch_feed.py` — RSS fetch, trainer-name title filter, processed-episode state.
- `transcribe.py` — audio download, ffmpeg chunking, Groq Whisper calls, transcript stitching.
- `extract_quotes.py` — the Claude extraction prompt and bullet-list parser.
- `write_notes.py` — trainer-name resolution and `POST /notes` writes with race-safe verification.
- `run.py` — orchestrator.
- `state/processed_guids.json` — committed; the "already seen" episode list.
- `credentials/`, `logs/`, `tmp/`, `.env`, `venv/` — all gitignored.
