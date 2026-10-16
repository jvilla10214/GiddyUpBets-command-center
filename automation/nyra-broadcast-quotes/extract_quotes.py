"""Send candidate transcript windows (from find_segments.py) to Claude and
extract Maggie Wolfendale's paddock-analysis observations.

A paddock read is NOT a trainer's own quote — it's Maggie's own third-person
observation about a horse walking into the paddock before its race
(appearance, demeanor, how it's traveling), stored as a normal Stable Tour
note with the trainer auto-matched from that day's real entries (see
write_notes.py) rather than attributed as something the trainer said. See
the original validated design in project_nyra_broadcast_quotes_deferred
memory for the full rationale.

Grepping for "maggie" (find_segments.py) is a high-recall, low-precision
filter — plenty of hits will be a false positive (someone else named Maggie,
a passing mention, a handoff to her for something other than paddock
analysis). This prompt does the real filtering: only genuine paddock-analysis
observations survive.
"""
import json
import re

import requests

import config

EXTRACTION_PROMPT_TEMPLATE = """These are timestamped excerpts from NYRA's "America's Day at the Races" \
broadcast, each one pulled from around a mention of "Maggie" in the full transcript (a cheap, \
high-recall filter — most of these will NOT turn out to be her paddock analysis, and your job is \
to tell which ones genuinely are).

Keep an excerpt ONLY if it is Maggie Wolfendale doing paddock analysis — her own observation about \
a specific horse's appearance, demeanor, or how it's traveling as it walks into the paddock before \
its race. Discard: any excerpt that isn't actually her (a different Maggie, or the name said by \
someone else in an unrelated context), any handoff to her for something other than paddock \
analysis (a interview, a betting segment, etc.), and anything that never actually names or clearly \
identifies the horse she's discussing.

For each excerpt worth keeping, output one bullet in this exact shape, plain text only, no tables, \
no markdown:

- [HH:MM:SS] Horse: <horse name, exactly as stated> — Observation: "<Maggie's observation, trimmed \
to just the horse/appearance/trip content — drop any banter, handoff chatter, or talk about a \
different horse that happens to be in the same excerpt>"

If NONE of the excerpts below qualify, output nothing.

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
    r"^-\s*\[(?P<ts>[\d:]+)\]\s*Horse:\s*(?P<horse>.*?)\s*—\s*Observation:\s*\"(?P<obs>.*)\"\s*$"
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
                "horse": normalize_horse_field(m.group("horse")),
                "observation": m.group("obs").strip(),
            })
        else:
            unparsed.append(line)
    return entries, unparsed


def extract_paddock_notes(windows):
    if not windows:
        return {"raw": "", "entries": [], "unparsed": []}
    prompt = build_prompt(windows)
    raw = call_claude(prompt)
    entries, unparsed = parse_bullets(raw)
    return {"raw": raw, "entries": entries, "unparsed": unparsed}


if __name__ == "__main__":
    import sys

    import find_segments

    if len(sys.argv) < 2:
        print("usage: extract_quotes.py <stitched_transcript.txt>")
        sys.exit(1)
    text = open(sys.argv[1]).read()
    windows = find_segments.find_candidate_windows(text)
    print(f"{len(windows)} candidate window(s) sent to Claude")
    result = extract_paddock_notes(windows)
    print(f"{len(result['entries'])} entries parsed, {len(result['unparsed'])} unparsed lines")
    print(json.dumps(result["entries"], indent=2))
