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

# YouTube bot-walls GitHub Actions' shared runner IPs ("Sign in to confirm
# you're not a bot") — confirmed real 2026-10-16 by triggering this
# pipeline's own workflow and watching yt-dlp fail with exactly that error,
# despite working fine from a local/home IP. The fix is real cookies from a
# logged-in YouTube session (a separate account from anything the user
# cares about, per that day's decision) — the workflow writes the
# YOUTUBE_COOKIES secret to a file and points this at it; empty/unset
# locally, where a home IP doesn't need it.
YTDLP_COOKIES_PATH = os.environ.get("YTDLP_COOKIES_PATH", "")


def ytdlp_cookie_args():
    return ["--cookies", YTDLP_COOKIES_PATH] if YTDLP_COOKIES_PATH else []

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
