# Keeneland Barn Notes quote import

Scheduled GitHub Actions job (`.github/workflows/keeneland-barn-notes.yml`) that watches
https://www.keeneland.com/barnnotes for new Barn Notes PDFs and saves the horse quotes in them
as Stable Tour notes, the same store the Entries tab and the morning entry-alert emails read.

## How it works

1. `run.py` lists the PDFs on the Barn Notes page and skips any already in
   `state/processed_pdfs.json` (committed back by the workflow after each run).
2. Each new PDF's text comes out with `pdftotext`. That text is messy: photo captions and sidebar
   boxes land mid-paragraph, sometimes mid-quote.
3. `extract.py` sends the text to Claude (`claude-opus-5-5`, JSON-schema output) to pick out each
   direct quote about a named horse: horse, speaker, the speaker's role, the horse's trainer.
   It drops captions that broke into quotes and skips quotes not about a horse.
4. `run.py` files each quote using the same rules as the rest of the store:
   - a trainer on their own horse → note under that trainer;
   - a jockey → jockey note (no trainer), shown wherever the horse runs;
   - an owner, assistant or anyone else → note under the horse's trainer, prefixed with the
     speaker's name ("Davant Latham: …").

   Name matching mirrors the Worker's `resolveTrackedTrainer()`. The nickname list and the
   "files under another trainer" rules (`TRAINER_FIRST_NAME_ALIASES`, `TRAINER_SUCCESSORS`) are
   read straight from `workers/stable-tour-feed.js`, so they can't drift. A trainer or jockey
   named in full who isn't tracked yet is added; a bare surname that matches more than one
   person is skipped, not guessed. Quotes already in the store for that horse (e.g. via
   SmartPony) are skipped.
5. Notes are saved with one `POST /notes/bulk` per PDF (one KV write, so no read-modify-write
   race between sequential writes). Each note's link is the PDF URL plus `?speaker=…`, because
   the Worker dedupes on (trainer, jockey, horse, link) and an owner's and a trainer's quote on
   the same horse from one PDF would otherwise collapse into one.

A PDF that fails (download, extraction, Worker error) is left unprocessed so the next hourly
run retries it.

## Running it by hand

Actions → **Keeneland Barn Notes — quote import** → **Run workflow**. "Dry run" (on by default
for manual runs) prints what would be saved without writing anything. "Only PDF" processes one
specific PDF URL.

Locally: `pip install -r requirements.txt`, have `pdftotext` (poppler-utils) installed, set
`ANTHROPIC_API_KEY`, then `DRY_RUN=1 python run.py`.

## Setup

Uses the `ANTHROPIC_API_KEY` repository secret the podcast pipeline already has. Nothing to
deploy on the Worker side.
