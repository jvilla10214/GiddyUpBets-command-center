"""Shared config for the Kentucky HBPA YouTube quote pipeline."""
import os


def _load_dotenv(path):
    """Minimal .env loader (no extra dependency) — only sets a variable if
    it isn't already in the environment, so real GitHub Actions secrets
    always win over anything accidentally left in a local .env."""
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

CHANNEL_VIDEOS_URL = "https://www.youtube.com/@kentuckyhbpa7026/videos"
WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
PROCESSED_VIDEO_IDS_PATH = os.path.join(STATE_DIR, "processed_video_ids.json")
DROPPED_QUOTES_PATH = os.path.join(STATE_DIR, "dropped_quotes.json")

TMP_DIR = os.path.join(os.path.dirname(__file__), "tmp")
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")

FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
YTDLP_BIN = os.environ.get("YTDLP_BIN", "yt-dlp")

# YouTube bot-walled GitHub Actions' shared runner IPs ("Sign in to confirm
# you're not a bot") from 2026-10-16 through 2026-10-20, even with these
# cookies present — confirmed the wall targets cloud/datacenter IPs
# specifically, not this cookies mechanism. Since 2026-10-24 this pipeline
# runs on a self-hosted runner on a home Mac instead (see the GitHub
# Actions workflow file's own comment), confirmed NOT to need cookies at
# all for captions (step 1 of that migration: a cookie-less caption fetch
# succeeded). Left in as a fallback rather than removed — still useful if a
# future video needs the full audio-download path instead of captions, and
# harmless if it stays unused. Optional, not required: ytdlp_auth_args()
# below only passes --cookies when a real file actually exists at this
# path, so an unset secret or a write step that never ran just means no
# cookies get passed, not a broken yt-dlp invocation pointed at a missing
# file.
YTDLP_COOKIES_PATH = os.environ.get("YTDLP_COOKIES_PATH", "")

# Even with cookies and a JS runtime (Deno, installed in the workflow)
# present, yt-dlp's newer challenge-solver system won't actually fetch/run
# its JS solver component without this explicit opt-in — confirmed real
# 2026-10-16 (every download still failed with "n challenge solving
# failed... The page needs to be reloaded" until this flag was added). This
# is yt-dlp's own documented, maintained solver component (not a random
# third-party script) and its own "(recommended)" option for this exact
# warning, not a bot-detection workaround.
YTDLP_REMOTE_COMPONENTS_ARGS = ["--remote-components", "ejs:github"]


def ytdlp_auth_args():
    args = list(YTDLP_REMOTE_COMPONENTS_ARGS)
    if YTDLP_COOKIES_PATH and os.path.exists(YTDLP_COOKIES_PATH):
        args += ["--cookies", YTDLP_COOKIES_PATH]
    return args

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Groq's Whisper endpoint rejects files above this size — these clips run
# 2-15 minutes (single-digit MB as audio), so a single request is normally
# enough, but chunking kicks in automatically if a longer upload ever shows
# up (same approach and same real limit as automation/podcast-quotes/).
GROQ_MAX_CHUNK_BYTES = 24 * 1024 * 1024
GROQ_MODEL = "whisper-large-v3-turbo"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

ANTHROPIC_MODEL = "claude-sonnet-5"
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"

# Source tags for auto-added trainers/jockeys — current standing policy
# (2026-10-11) is to auto-track anyone a real quote names, not require
# upfront manual curation, with a user-run weekly audit as the mitigation.
# See project_auto_track_trainers_shipped_2026-10-11 in memory.
TRAINER_SOURCE_TAG = "kentuckyhbpa-auto-unverified"
JOCKEY_SOURCE_TAG = "kentuckyhbpa-auto-unverified"
