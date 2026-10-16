"""Send candidate interview-handoff windows (from find_segments.py) to
Claude and extract post-race trainer/jockey Q&A — same speaker+role
identification approach as automation/kentucky-hbpa/extract_quotes.py (no
pre-known interviewee here either), duplicated rather than shared per this
project's automation/ convention.

Any interviewer counts (Maggie, Megan, Acacia, or anyone else) — what
matters for a quote is who's being interviewed, not who's asking, per the
2026-10-16 scope decision to add interviews back in alongside the
paddock-only Maggie pipeline.
"""
import re

import requests

import config

EXTRACTION_PROMPT_TEMPLATE = """These are timestamped excerpts from NYRA's "America's Day at the Races" \
broadcast, each one pulled from around a likely post-race interview handoff cue in the full \
transcript (a cheap, high-recall filter — some of these will NOT turn out to be an actual trainer \
or jockey interview, and your job is to tell which ones genuinely are).

Keep an excerpt ONLY if it's a real interview exchange with a trainer or jockey about a specific \
horse's race, trip, or performance. Discard: betting/handicapping segments, a win announcement with \
no actual interview, banter that never addresses a specific horse, and anything where you can't \
tell who's being interviewed or what horse it's about.

For each qualifying excerpt, identify the speaker (the trainer or jockey being interviewed, not the \
host) from context — the host usually says their name or role, and the speaker answers in first \
person about their own horse. Use "unclear" for anything you can't confidently attribute — don't \
guess.

Output one bullet per question-and-answer exchange, plain text only, no tables, no markdown, in \
this exact shape:

- [HH:MM:SS] Speaker: <full name, or "unclear"> — Role: <trainer|jockey|other> — Horse: <horse \
name, or "unclear"> — Q: <question, paraphrased briefly if needed> — A: "<direct quote>"

If one person discusses multiple horses, give one bullet per horse. If NONE of the excerpts below \
qualify, output nothing.

EXCERPTS:
{excerpts}
"""


def build_prompt(windows):
    excerpts = "\n\n".join(
        f"=== Excerpt at {w['start']}s-{w['end']}s ===\n{w['text']}" for w in windows
    )
    return EXTRACTION_PROMPT_TEMPLATE.format(excerpts=excerpts)


def call_claude(prompt):
    headers = {
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": config.ANTHROPIC_MODEL,
        "max_tokens": 8000,
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


def extract_interviews(windows):
    if not windows:
        return {"raw": "", "entries": [], "unparsed": []}
    prompt = build_prompt(windows)
    raw = call_claude(prompt)
    entries, unparsed = parse_bullets(raw)
    return {"raw": raw, "entries": entries, "unparsed": unparsed}


if __name__ == "__main__":
    import sys
    import json

    import find_segments

    if len(sys.argv) < 2:
        print("usage: extract_interviews.py <stitched_transcript.txt>")
        sys.exit(1)
    text = open(sys.argv[1]).read()
    windows = find_segments.find_interview_windows(text)
    print(f"{len(windows)} candidate window(s) sent to Claude")
    result = extract_interviews(windows)
    print(f"{len(result['entries'])} entries parsed, {len(result['unparsed'])} unparsed lines")
    print(json.dumps(result["entries"], indent=2))
