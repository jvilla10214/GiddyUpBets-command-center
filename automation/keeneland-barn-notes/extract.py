"""Pull horse quotes out of one Barn Notes PDF's text with Claude.

pdftotext output from these PDFs is messy: photo captions ("Ag Bullet",
"American History") and sidebar text ("Race Day Essentials", "FREE
DOWNLOAD") land in the middle of paragraphs, sometimes mid-quote. That's
why this step is a model call rather than a regex: it has to tell a caption
from a horse being discussed, and work out who the speaker is and which
horse a quote is about from the surrounding story. Output is constrained to
a JSON schema, so the caller gets structured rows, not prose to parse.
"""
import json

import anthropic

import config

QUOTE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["quotes"],
    "properties": {
        "quotes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["horse", "speaker", "speaker_role", "horse_trainer", "quote", "story_headline"],
                "properties": {
                    "horse": {"type": "string"},
                    "speaker": {"type": "string"},
                    "speaker_role": {"type": "string", "enum": ["trainer", "jockey", "owner", "other"]},
                    "horse_trainer": {"type": ["string", "null"]},
                    "quote": {"type": "string"},
                    "story_headline": {"type": "string"},
                },
            },
        }
    },
}

PROMPT = """Below is the text of a Keeneland "Barn Notes" handout ({edition}), extracted from a PDF.
The extraction is messy: photo captions, sidebar boxes and page furniture are interleaved with
the stories, sometimes in the middle of a sentence or a quote.

Extract every direct quote that is about a specific, named racehorse. For each one return:
- horse: the horse the quote is about, spelled as in the story.
- speaker: the full name of the person quoted (first and last), as the story identifies them.
  If a quote is attributed by surname only ("Wilkes said"), use the full name given earlier in
  the story.
- speaker_role: "trainer" if the speaker trains that horse, "jockey" if they ride or rode it,
  "owner" for an owner or ownership-group representative, otherwise "other".
- horse_trainer: the horse's trainer's full name if the story states it, else null.
- quote: the speaker's exact words about that horse. If the same speaker has several quotes
  about the same horse in one story, return them as ONE item, joined with " […] " in story
  order. Remove any caption or sidebar text that landed inside a quote, and join words that the
  extraction broke across lines. Do not paraphrase, add words, or include the attribution
  ("Wilkes said").
- story_headline: the headline of the story the quote comes from.

Skip: quotes that aren't about a specific horse (for example praise of a jockey's career, a
track employee Q&A, history pieces, business news); quotes whose speaker you can't identify;
and anything that is not a direct quote. If there are no qualifying quotes, return an empty list.

<barn_notes_text>
{text}
</barn_notes_text>"""


class ExtractionRefused(Exception):
    pass


def extract_quotes(pdf_text, edition_label):
    client = anthropic.Anthropic()
    response = client.beta.messages.create(
        model=config.ANTHROPIC_MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={
            "effort": "medium",
            "format": {"type": "json_schema", "schema": QUOTE_SCHEMA},
        },
        messages=[{"role": "user", "content": PROMPT.format(edition=edition_label, text=pdf_text)}],
    )
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise ExtractionRefused(f"model declined ({category})")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("extraction hit max_tokens; output incomplete")
    text = "".join(block.text for block in response.content if block.type == "text")
    return json.loads(text)["quotes"]
