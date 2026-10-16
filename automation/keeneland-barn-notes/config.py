"""Shared config for the Keeneland Barn Notes quote pipeline."""
import os

BARN_NOTES_URL = "https://www.keeneland.com/barnnotes"
KEENELAND_BASE = "https://www.keeneland.com"
WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"

# Keeneland's edge and the Worker's Cloudflare front both reject a bare
# python-requests UA, same as every other fetch in this project.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

HERE = os.path.dirname(__file__)
STATE_DIR = os.path.join(HERE, "state")
PROCESSED_PDFS_PATH = os.path.join(STATE_DIR, "processed_pdfs.json")
TMP_DIR = os.path.join(HERE, "tmp")

ANTHROPIC_MODEL = "claude-opus-5-5"

# Set DRY_RUN=1 to print what would be saved without writing anything or
# marking PDFs processed (the workflow's manual-run input sets this).
DRY_RUN = os.environ.get("DRY_RUN", "").strip().lower() in ("1", "true", "yes")

# Optional: process just this one PDF URL (absolute), ignoring state. For
# testing a specific edition from a manual workflow run.
ONLY_PDF = os.environ.get("ONLY_PDF", "").strip()

# Safety cap per run so a site change that makes every PDF look "new"
# can't flood the notes store in one go.
MAX_PDFS_PER_RUN = int(os.environ.get("MAX_PDFS_PER_RUN", "15"))
