"""Send a video's title + transcript to Claude and extract trainer/jockey
Q&A pairs about a named horse.

One real difference from the Steve Byk podcast pipeline
(automation/podcast-quotes/extract_quotes.py): that pipeline already knows
WHICH tracked trainer is being interviewed before extraction even runs (the
title-match step hands it in). This channel has no such pre-filter (see
discover.py's docstring for why) — every video gets processed, and the
interviewee could be a trainer, a jockey, an owner, a bloodstock agent, or a
broadcaster doing color commentary. So this prompt asks Claude to identify
BOTH who's speaking and what role they have, using the video title (which
very often already names the speaker and their connection, e.g. "hear from
Jose Ortiz, DeVaux") plus the transcript's own self-identifying context
(an interviewer using someone's name, first-person answers about training or
riding decisions) — never guessing an identity with nothing to anchor it.

Only trainer/jockey quotes get filed as Stable Tour notes (the note schema
only has `trainer`/`jockey` fields) — an owner, bloodstock agent, or
broadcaster talking about a horse is real content but has nowhere to go in
the current schema, so those get surfaced in the dropped-quotes log rather
than silently discarded, same as any other skip reason this project already
tracks.
"""
import json
import re

import requests

import config

EXTRACTION_PROMPT_TEMPLATE = """This is a timestamped but NOT speaker-labeled transcript of a Kentucky HBPA \
YouTube video about Thoroughbred racing. The video's title is:

"{title}"

The title often already names who's speaking and their connection to a horse (trainer, jockey, \
owner, bloodstock agent, etc.) — use it as a strong hint, but confirm against what the transcript \
itself actually says (first-person answers about training or riding decisions, an interviewer \
using someone's name). Don't guess a name or role with nothing in the title or transcript to \
anchor it — use "unclear" instead.

Extract every question-and-answer exchange in the transcript where the speaker is talking about a \
specific horse's performance, work, trip, or plans, in order, with the nearest preceding \
timestamp. Output as plain text only, no tables, no markdown formatting — one bullet per \
exchange, in this exact shape:

- [MM:SS] Speaker: <full name, or "unclear"> — Role: <trainer|jockey|owner|agent|other> — Horse: \
<horse name, or "unclear"> — Q: <question, paraphrased briefly if needed> — A: "<direct quote>"

If one person discusses multiple horses, give one bullet per horse. Skip pure narration/highlight \
commentary with no actual interview exchange, and skip small talk that never addresses the horse \
itself (career trivia, scheduling logistics, media-day chit-chat).

TRANSCRIPT:
{transcript}
"""


def build_prompt(title, transcript_text):
    return EXTRACTION_PROMPT_TEMPLATE.format(title=title, transcript=transcript_text)


def call_claude(prompt):
    headers = {
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": config.ANTHROPIC_MODEL,
        "max_tokens": 8000,
        # Without this, Sonnet 5 defaults to extended thinking and can burn
        # the entire max_tokens budget on the (unused, here) thinking block,
        # leaving zero tokens for the actual bullet-list answer — same real
        # issue confirmed in the Byk pipeline, not theoretical here either.
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": prompt}],
    }
    r = requests.post(config.ANTHROPIC_MESSAGES_URL, headers=headers, json=body, timeout=180)
    r.raise_for_status()
    data = r.json()
    return "".join(block.get("text", "") for block in data.get("content", []))


BULLET_RE = re.compile(
    r"^-\s*\[(?P<ts>[\d:]+)\]\s*Speaker:\s*(?P<speaker>.*?)\s*—\s*Role:\s*(?P<role>.*?)\s*—\s*"
    r"Horse:\s*(?P<horse>.*?)\s*—\s*Q:\s*(?P<question>.*?)\s*—\s*A:\s*\"(?P<quote>.*)\"\s*$"
)

# Same real lesson as automation/podcast-quotes/extract_quotes.py: telling
# the model "say unclear, don't guess" isn't reliable enough alone — it
# sometimes invents a descriptive placeholder instead of the literal word.
# One shared pattern, not a second parallel list to keep in sync with that
# file (duplicated here on purpose per this project's "duplicate the working
# pipeline rather than share code" convention for automation/ pipelines).
NOT_A_REAL_HORSE_NAME_RE = re.compile(
    r"[()]|\bunnamed\b|\bsibling\b|\bhalf[- ]sister\b|\bhalf[- ]brother\b|"
    r"\bfull[- ]sister\b|\bfull[- ]brother\b|\byearling\b|\bfoal\b|"
    r"\bcolt by\b|\bfilly by\b",
    re.IGNORECASE,
)


def normalize_horse_field(horse):
    horse = horse.strip()
    if not horse or NOT_A_REAL_HORSE_NAME_RE.search(horse):
        return "unclear"
    return horse


def parse_bullets(raw_text):
    """Any line that doesn't match the expected shape is kept in `unparsed`
    rather than silently dropped, so nothing goes missing without a trace."""
    entries = []
    unparsed = []
    for line in raw_text.splitlines():
        line = line.strip()
        if not line or not line.startswith("-"):
            continue
        m = BULLET_RE.match(line)
        if m:
            entries.append({
                "timestamp": m.group("ts"),
                "speaker": m.group("speaker").strip(),
                "role": m.group("role").strip().lower(),
                "horse": normalize_horse_field(m.group("horse")),
                "question": m.group("question").strip(),
                "quote": m.group("quote").strip(),
            })
        else:
            unparsed.append(line)
    return entries, unparsed


def extract_quotes(title, transcript_text):
    prompt = build_prompt(title, transcript_text)
    raw = call_claude(prompt)
    entries, unparsed = parse_bullets(raw)
    return {"raw": raw, "entries": entries, "unparsed": unparsed}


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("usage: extract_quotes.py <transcript.json> <video title>")
        sys.exit(1)
    with open(sys.argv[1]) as f:
        transcript = json.load(f)
    result = extract_quotes(sys.argv[2], transcript["text"])
    print(f"{len(result['entries'])} entries parsed, {len(result['unparsed'])} unparsed lines")
    print(json.dumps(result["entries"], indent=2))
    if result["unparsed"]:
        print("--- unparsed ---")
        print("\n".join(result["unparsed"]))
