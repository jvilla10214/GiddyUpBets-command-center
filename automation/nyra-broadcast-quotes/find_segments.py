"""Find candidate windows in a full broadcast's stitched transcript where
Maggie Wolfendale might be doing paddock analysis, instead of sending the
whole 4.5-6 hour transcript to Claude. Same "grep for cues, don't read
linearly" approach the original manual process used — a name mention is a
cheap, high-recall filter; Claude (in extract_quotes.py) does the real work
of deciding whether a given window is actually her paddock analysis and
pulling out the horse/observation.
"""
import re

import config

LINE_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$")

MAGGIE_CUE_RE = re.compile("|".join(config.MAGGIE_CUE_PATTERNS), re.IGNORECASE)
INTERVIEW_CUE_RE = re.compile("|".join(config.INTERVIEW_CUE_PATTERNS), re.IGNORECASE)

# How much context around a cue to pull in — generous on both sides since a
# paddock walk-up conversation or a post-race interview can run a couple
# minutes and the cue phrase itself doesn't always land right at the start.
BEFORE_SECONDS = 30
AFTER_SECONDS = 150


def parse_lines(stitched_text):
    lines = []
    for line in stitched_text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        h, mnt, s, text = m.groups()
        ts = int(h) * 3600 + int(mnt) * 60 + int(s)
        lines.append((ts, text))
    return lines


def _windows_for_cue(lines, cue_re, before=BEFORE_SECONDS, after=AFTER_SECONDS):
    """Returns a list of {start, end, text} windows, merging overlapping or
    near-adjacent cue hits into one contiguous block so one conversation
    doesn't get split into several overlapping candidates."""
    hit_indices = [i for i, (_, text) in enumerate(lines) if cue_re.search(text)]
    if not hit_indices:
        return []

    raw_windows = [(lines[i][0] - before, lines[i][0] + after) for i in hit_indices]
    raw_windows.sort()
    merged = [raw_windows[0]]
    for start, end in raw_windows[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))

    windows = []
    for start, end in merged:
        block_lines = [f"[{h:02d}:{m:02d}:{s:02d}] {text}" for ts, text in lines
                        if start <= ts <= end
                        for h, m, s in [(ts // 3600, (ts % 3600) // 60, ts % 60)]]
        if block_lines:
            windows.append({"start": start, "end": end, "text": "\n".join(block_lines)})
    return windows


def find_candidate_windows(stitched_text):
    """Maggie-mention windows — candidates for her paddock analysis."""
    return _windows_for_cue(parse_lines(stitched_text), MAGGIE_CUE_RE)


def find_interview_windows(stitched_text):
    """Post-race interview handoff windows — candidates for a trainer/jockey
    interview, any interviewer."""
    return _windows_for_cue(parse_lines(stitched_text), INTERVIEW_CUE_RE)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: find_segments.py <stitched_transcript.txt>")
        sys.exit(1)
    text = open(sys.argv[1]).read()
    for label, finder in [("Maggie paddock", find_candidate_windows), ("Interview", find_interview_windows)]:
        windows = finder(text)
        print(f"=== {label}: {len(windows)} candidate window(s) ===")
        for w in windows:
            print(f"--- {w['start']}s-{w['end']}s ---")
            print(w["text"][:500])
            print()
