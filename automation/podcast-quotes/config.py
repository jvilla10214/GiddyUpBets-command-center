"""Shared config for the Steve Byk podcast quote pipeline."""
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

FEED_URL = "https://media.rss.com/at-the-races-with-steve-byk/feed.xml"
WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"

# rss.com's own React shell / some edges reject a generic Python UA — same
# browser-UA workaround this project already uses everywhere else (curl -A).
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
PROCESSED_GUIDS_PATH = os.path.join(STATE_DIR, "processed_guids.json")
NICKNAME_ALIASES_PATH = os.path.join(os.path.dirname(__file__), "nickname_aliases.json")

TMP_DIR = os.path.join(os.path.dirname(__file__), "tmp")
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")

FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Groq's Whisper endpoint rejects files above this size — chunk audio to stay
# safely under it (real limit is 25MB; a lower target leaves headroom for the
# container overhead ffmpeg adds when re-muxing a segment).
GROQ_MAX_CHUNK_BYTES = 24 * 1024 * 1024
GROQ_MODEL = "whisper-large-v3-turbo"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

ANTHROPIC_MODEL = "claude-sonnet-5"
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
