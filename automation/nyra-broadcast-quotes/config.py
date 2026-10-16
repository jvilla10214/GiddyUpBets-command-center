"""Shared config for the NYRA broadcast ("America's Day at the Races") quote
pipeline. Two extraction passes over the same transcript, per explicit user
decisions on 2026-10-16:
  1. Maggie Wolfendale's paddock analysis ONLY — Megan Burgess and Acacia
     Clement also do paddock reads on this broadcast (confirmed during the
     original manual research), deliberately excluded here, not an
     oversight.
  2. Post-race trainer/jockey interviews — any interviewer counts (Maggie,
     Megan, Acacia, or anyone else); what matters is who's being
     interviewed, not who's asking.
"""
import os


def _load_dotenv(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# The full daily broadcast lives on the channel's "streams" tab (past live
# streams), not "videos" — confirmed during the original investigation that
# /videos interleaves it unpredictably with dozens of short race-call clips,
# while /streams has posted one every single racing day without a gap. The
# same tab also carries a daily "Talking Horses" show — TITLE_PREFIX below
# filters that out.
CHANNEL_STREAMS_URL = "https://www.youtube.com/@thenyra/streams"
TITLE_PREFIX = "America's Day at the Races"

WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"

# NYRA tracks this store actually archives Race Day data for (see
# NYRA_IMPORT_TRACKS in workers/stable-tour-feed.js) — tried in order against
# GET /raceday?track=X&date=Y to find which one raced on a given date, rather
# than parsing the track name out of the broadcast audio itself.
RACEDAY_TRACKS = ["belmont", "saratoga"]

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
PROCESSED_VIDEO_IDS_PATH = os.path.join(STATE_DIR, "processed_video_ids.json")
DROPPED_QUOTES_PATH = os.path.join(STATE_DIR, "dropped_quotes.json")

TMP_DIR = os.path.join(os.path.dirname(__file__), "tmp")
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")

FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
YTDLP_BIN = os.environ.get("YTDLP_BIN", "yt-dlp")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Groq's Whisper endpoint rejects a single file above this size — these
# multi-hour broadcasts always need chunking (unlike the HBPA pipeline's
# short clips, where it was an edge case). A live test against this account
# on 2026-10-16 showed only a request-count rate limit (2,000/window), not
# the audio-duration-per-hour limit the original 2026-09-18 manual research
# hit — so this pipeline transcribes the whole show in one run rather than
# spreading it across multiple scheduled runs, with a plain retry-next-run
# fallback (run.py leaves a video unprocessed on any error) if that turns
# out to be wrong in practice.
GROQ_MAX_CHUNK_BYTES = 24 * 1024 * 1024
GROQ_MODEL = "whisper-large-v3-turbo"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

ANTHROPIC_MODEL = "claude-sonnet-5"
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"

# Auto-track source tags — current standing policy (2026-10-11): auto-track
# any trainer/jockey a note resolves to, with the user's weekly audit as the
# safety net instead of upfront gatekeeping. See
# project_auto_track_trainers_shipped_2026-10-11 in memory. No per-run
# review table before filing, per explicit user decision 2026-10-16 — same
# auto-file-then-audit approach as automation/kentucky-hbpa/ and
# automation/keeneland-barn-notes/.
TRAINER_SOURCE_TAG = "nyra-maggie-auto-unverified"
INTERVIEW_TRAINER_SOURCE_TAG = "nyra-interview-auto-unverified"
INTERVIEW_JOCKEY_SOURCE_TAG = "nyra-interview-auto-unverified"

# Cue phrases that mark a handoff to Maggie's paddock segment — used to find
# candidate windows in the full stitched transcript instead of sending the
# whole multi-hour transcript to Claude (same "grep for cues, don't read
# linearly" approach the original manual process used). Deliberately named
# "Maggie" only, not Megan/Acacia, per the 2026-10-16 scope decision.
MAGGIE_CUE_PATTERNS = [
    r"\bmaggie\b",
]

# Cue phrases for a post-race trainer/jockey interview handoff — any
# interviewer counts here (Maggie, Megan, Acacia, or anyone else), since
# what matters for a quote is who's being interviewed, not who's asking.
# Same phrase list the original manual research found worked for finding
# these segments by grep (project_nyra_broadcast_quotes_deferred memory).
INTERVIEW_CUE_PATTERNS = [
    r"\bcongratulations\b",
    r"\bhow did (that|it|he|she|they) feel\b",
    r"\btalk (about|to us about)\b",
    r"\bwinner'?s circle\b",
    r"\bjoin(s|ing)? us\b",
]
