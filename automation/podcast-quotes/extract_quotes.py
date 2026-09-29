"""Send a transcript to Claude and extract trainer Q&A pairs, following the
same prompt design validated in the manual AI Studio workflow (see
project_atr_byk_podcast_prompt_2026-08-26 in memory) — with one adjustment:
a Whisper transcript has no speaker labels, so the prompt explicitly asks
Claude to infer speaker turns from context (Byk addressing a guest by name,
first-person answers) rather than assuming labeled dialogue like the old
audio-native Gemini workflow could rely on.
"""
import json
import re

import requests

import config

EXTRACTION_PROMPT_TEMPLATE = """This is a timestamped but NOT speaker-labeled transcript of an episode of \
"At the Races with Steve Byk," a horse racing interview podcast. Steve Byk is the host; the \
guests on this episode are: {guest_names}.

Because the transcript has no speaker labels, infer who is talking from context — Byk usually \
addresses a guest by name or asks a direct question, and the guest usually answers in first \
person about their own horses. Use [unclear] for anything you can't confidently attribute or \
make out — don't guess.

For {trainer_names_only} ONLY (ignore any other guests on this episode), extract every question \
Steve Byk asks along with the direct quote that answers it, in order, with the nearest preceding \
timestamp marker from the transcript. Output as plain text only, no tables, no markdown \
formatting — one Q&A pair per bullet, in a single continuous list, in this exact shape:

- [HH:MM:SS] Q: <question, paraphrased briefly if needed> — Horse: <horse name if stated, else \
"unclear"> — A: "<direct quote>"

If a trainer discusses multiple horses, give one bullet per horse. If the horse's name is never \
stated (common when Byk's question named it but the transcript couldn't attribute the line), \
say "unclear" for the horse rather than guessing — a human will fill it in.

TRANSCRIPT:
{transcript}
"""


def build_prompt(transcript_text, guest_names, trainer_names):
    return EXTRACTION_PROMPT_TEMPLATE.format(
        guest_names=", ".join(guest_names),
        trainer_names_only=", ".join(trainer_names),
        transcript=transcript_text,
    )


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
        # leaving zero tokens for the actual bullet-list answer — confirmed
        # by testing, not theoretical.
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": prompt}],
    }
    r = requests.post(config.ANTHROPIC_MESSAGES_URL, headers=headers, json=body, timeout=180)
    r.raise_for_status()
    data = r.json()
    return "".join(block.get("text", "") for block in data.get("content", []))


BULLET_RE = re.compile(
    r"^-\s*\[(?P<ts>[\d:]+)\]\s*Q:\s*(?P<question>.*?)\s*—\s*Horse:\s*(?P<horse>.*?)\s*—\s*A:\s*\"(?P<quote>.*)\"\s*$"
)

# Confirmed real (2026-09-29): telling the model "say 'unclear', don't guess"
# in the prompt isn't reliable enough on its own — same lesson as this
# project's Workers AI narration-limits finding (a model told not to
# embellish embellishes anyway; the fix has to be a real check, not a
# stronger instruction). In practice the model sometimes invents a
# descriptive placeholder instead of the literal word "unclear" when no real
# registered name was ever stated — two real examples that made it all the
# way into Stable Tour before this existed: "(Curlin half-sister, unnamed)"
# and "Somerset West (sibling)" (a hypothetical, not-yet-existing horse the
# trainer was just speculating about). Neither is a real registered name,
# and no amount of prompt wording fixes that reliably — so this normalizes
# any horse field matching these patterns to the literal "unclear" instead,
# which write_notes.py already skips (its own "unclear" in horse.lower()
# check) — one shared filter, not a second parallel skip-list to keep in
# sync.
NOT_A_REAL_HORSE_NAME_RE = re.compile(
    r"[()]|\bunnamed\b|\bsibling\b|\bhalf[- ]sister\b|\bhalf[- ]brother\b|"
    r"\bfull[- ]sister\b|\bfull[- ]brother\b|\byearling\b|\bfoal\b|"
    r"\bcolt by\b|\bfilly by\b",
    re.IGNORECASE,
)


def normalize_horse_field(horse):
    """Real registered horse names don't contain parentheses or descriptive
    placeholder words ("sibling", "unnamed", etc.) — anything matching those
    is a model-invented placeholder for a horse that was never actually
    named, not a parsing artifact to clean up. Collapses to the literal
    "unclear" so the one existing downstream filter (write_notes.py) is the
    only place that decides what to do with an unnamed horse."""
    horse = horse.strip()
    if not horse or NOT_A_REAL_HORSE_NAME_RE.search(horse):
        return "unclear"
    return horse


def parse_bullets(raw_text):
    """Parses the model's bullet-list output into structured entries. Any
    line that doesn't match the expected shape is kept in `unparsed` rather
    than silently dropped, so nothing goes missing without a trace."""
    entries = []
    unparsed = []
    for line in raw_text.splitlines():
        line = line.strip()
        if not line or not line.startswith("-"):
            continue
        m = BULLET_RE.match(line)
        if m:
            entries.append(
                {
                    "timestamp": m.group("ts"),
                    "question": m.group("question").strip(),
                    "horse": normalize_horse_field(m.group("horse")),
                    "quote": m.group("quote").strip(),
                }
            )
        else:
            unparsed.append(line)
    return entries, unparsed


def extract_quotes(transcript_text, guest_names, trainer_names):
    prompt = build_prompt(transcript_text, guest_names, trainer_names)
    raw = call_claude(prompt)
    entries, unparsed = parse_bullets(raw)
    return {"raw": raw, "entries": entries, "unparsed": unparsed}


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: extract_quotes.py <transcript.json> [trainer names, comma-separated]")
        sys.exit(1)
    with open(sys.argv[1]) as f:
        transcript = json.load(f)
    trainer_names = sys.argv[2].split(",") if len(sys.argv) > 2 else ["Unknown"]
    result = extract_quotes(transcript["text"], trainer_names, trainer_names)
    print(f"{len(result['entries'])} entries parsed, {len(result['unparsed'])} unparsed lines")
    print(json.dumps(result["entries"], indent=2))
    if result["unparsed"]:
        print("--- unparsed ---")
        print("\n".join(result["unparsed"]))
