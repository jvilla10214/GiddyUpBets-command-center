"""One-off Breeders' Cup entries digest emails — see README.md.

Not a recurring pipeline. Reads BREEDERS_CUP_2026 out of index.html, fetches live
Stable Tour notes, builds two emails (Friday, Saturday), sends each through the
Worker's /send-custom-email route. Standard library only, deliberately, so a
fresh checkout can run this with no setup step.

Updated 2026-10-27 for the real drawn card: BREEDERS_CUP_2026 now holds
official SmartPony-sourced entries (real post positions, trainers, jockeys,
morning-line odds, scratch status), not condition-book pre-entries. Scratched
horses are excluded from the email entirely rather than shown struck-through
— a scratched horse has nothing left to bet or watch for. Theme switched to
Breeders' Cup's own real purple (matching BREEDERS_CUP_THEME in workers/
stable-tour-feed.js, used for the real production entry-alert email once
this same card is live there) now that it's an official card, not a
Keeneland-green pre-entry placeholder.
"""
import html
import json
import re
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"
# GitHub Pages' own real base URL (same site index.html deploys to) — see
# PAGES_BASE's own usage in toc_html()/main() for why this exists at all.
PAGES_BASE = "https://jvilla10214.github.io/GiddyUpBets-command-center"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Breeders' Cup's own real purple (sampled directly from breederscup.com,
# #512d6d — see BREEDERS_CUP_THEME in workers/stable-tour-feed.js, the same
# accent used there once this card is live in the real production entry-
# alert email). Was Keeneland's green while this was still a pre-entry
# placeholder; now that it's the real drawn card, the event's own branding
# is the correct theme, not the host track's.
THEME = {"accent": "#512d6d", "bg": "#faf7fd", "ink": "#201530", "dim": "#7a6b8a", "hairline": "#e6ddf0"}

# Same fixed colors as NOTE_TYPE_RIBBON_COLORS in workers/stable-tour-feed.js
# — all three fixed, not THEME['accent'], so "indigo = quote / gold = race
# recap / steel blue = full card recap" stays a reliable shortcut across
# every track's email, BC's own Keeneland-green included. Quote was
# originally THEME['accent'] here too (matching the Worker's own pre-2026-
# 10-24 design) until a real user-reported bug: that made the QUOTE ribbon
# the same color as the race-tag badge directly above it, so the two
# blended together. Fixed alongside the Worker's own copy of this same bug.
NOTE_TYPE_RIBBON_COLORS = {"quote": "#5b4e8f", "race": "#c99a2e", "fullCard": "#4a6b8a"}

# Same NTRA-standard saddlecloth colors as index.html's SADDLECLOTH_COLORS /
# the worker's SADDLECLOTH_COLORS_EMAIL — ported here rather than shared
# since this is a separate one-off Python script. Posts 13-24 (BC-size AE
# fields) reuse the 1-12 colors with a white diagonal sash (rendered as a
# two-tone gradient) rather than inventing a 13th-24th flat color.
SADDLECLOTH_COLORS = {
    1: {"bg": "#e21f26", "fg": "#ffffff"}, 2: {"bg": "#ffffff", "fg": "#000000"},
    3: {"bg": "#1c4faa", "fg": "#ffffff"}, 4: {"bg": "#ffd400", "fg": "#000000"},
    5: {"bg": "#1a7a3c", "fg": "#ffffff"}, 6: {"bg": "#000000", "fg": "#ffd400"},
    7: {"bg": "#f7941d", "fg": "#000000"}, 8: {"bg": "#f2a7c3", "fg": "#000000"},
    9: {"bg": "#40e0d0", "fg": "#000000"}, 10: {"bg": "#7b2d8e", "fg": "#ffffff"},
    11: {"bg": "#9a9a9a", "fg": "#c1272d"}, 12: {"bg": "#9acd32", "fg": "#000000"},
}


def pp_badge_html(pgm, also_eligible=False):
    try:
        n = int(pgm)
    except (TypeError, ValueError):
        n = None
    ae_tag = (
        f' <span style="display:inline-block; padding:1px 4px; border-radius:3px; '
        f'font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:9.5px; '
        f'letter-spacing:0.03em; color:#8a6400; background:rgba(240,180,41,0.18); '
        f'vertical-align:middle;">AE</span>'
        if also_eligible else ""
    )
    colors = SADDLECLOTH_COLORS.get(n) if n else None
    border = ""
    if not colors and n and 13 <= n <= 24:
        base = SADDLECLOTH_COLORS[((n - 1) % 12) + 1]
        colors = {"bg": f"linear-gradient(135deg, {base['bg']} 50%, #ffffff 50%)", "fg": "#000000"}
        border = " border:1px solid rgba(0,0,0,0.45);"
    if not colors:
        return f'<span style="display:inline-block; font-family:\'Courier New\',monospace; font-weight:700; font-size:12px; margin-right:8px;">{esc(pgm)}</span>{ae_tag}'
    return (
        f'<span style="display:inline-block; width:22px; height:22px; line-height:22px; text-align:center; '
        f'border-radius:4px;{border} background:{colors["bg"]}; color:{colors["fg"]}; '
        f'font-family:\'Courier New\',monospace; font-weight:700; font-size:12px; vertical-align:middle; margin-right:8px;">{n}</span>{ae_tag}'
    )

# A recap's "track" field is the raw lowercase track id (see
# readAllRecapIndexes() in workers/stable-tour-feed.js) — fine as a key, but
# "belmont"/"saratoga" shown as-is next to a recap date reads badly. Same
# map/same fix as ENTRIES_TRACK_LABEL in the Worker's own entry-alert email,
# which already does this lookup correctly; this script just hadn't been
# updated to match when the recap-origin tag was added here.
TRACK_LABEL = {
    "saratoga": "Saratoga", "belmont": "Belmont", "delmar": "Del Mar", "monmouth": "Monmouth",
    "york": "York", "ascot": "Ascot", "epsomdowns": "Epsom Downs", "newmarket": "Newmarket",
    "curragh": "Curragh", "longchamp": "Longchamp",
    "shatin": "Sha Tin", "happyvalley": "Happy Valley", "meydan": "Meydan",
    "churchilldowns": "Churchill Downs", "santaanita": "Santa Anita", "oaklawnpark": "Oaklawn Park",
    "keeneland": "Keeneland", "gulfstreampark": "Gulfstream Park", "colonialdowns": "Colonial Downs",
    "kentuckydowns": "Kentucky Downs", "ellispark": "Ellis Park", "fairgrounds": "Fair Grounds",
    "woodbine": "Woodbine", "parx": "Parx",
}

# Official stakes names, by date then race number — race numbers alone
# aren't unique across the two days (both have a "Race 6", a different race
# each day). Same map as BREEDERS_CUP_RACE_NAMES in workers/stable-tour-
# feed.js (ported there for the real drawn-card entry-alert email); kept
# here too so this one-time pre-entry send shows the same race names.
BREEDERS_CUP_RACE_NAMES = {
    "2026-10-30": {
        6: "Breeders' Cup Juvenile Turf Sprint",
        7: "Breeders' Cup Juvenile Fillies",
        8: "John Deere Breeders' Cup Juvenile Fillies Turf",
        9: "FanDuel Breeders' Cup Juvenile",
        10: "Brown Advisory Breeders' Cup Juvenile Turf",
    },
    "2026-10-31": {
        4: "Breeders' Cup Filly & Mare Sprint",
        5: "Prevagen Breeders' Cup Turf Sprint",
        6: "Breeders' Cup Dirt Mile",
        7: "Maker's Mark Breeders' Cup Filly & Mare Turf",
        8: "Cygames Breeders' Cup Sprint",
        9: "FanDuel Breeders' Cup Mile",
        10: "Longines Breeders' Cup Distaff",
        11: "Longines Breeders' Cup Turf",
        12: "Longines Breeders' Cup Classic",
    },
}

COUNTRY_SUFFIX_RE = re.compile(r"\s*\([a-zA-Z]{2,4}\)\s*$")


def normalize_horse_key(name):
    return COUNTRY_SUFFIX_RE.sub("", (name or "").strip()).strip().lower()


def fetch_url(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": BROWSER_UA})
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode("utf-8")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_bc_data():
    text = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    m = re.search(r"const BREEDERS_CUP_2026 = (\{.*?\n  \});\n", text, re.S)
    if not m:
        raise RuntimeError("Could not find BREEDERS_CUP_2026 in index.html")
    return json.loads(m.group(1))


def esc(s):
    return html.escape(s or "", quote=False)


DATE_LABEL_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def format_date_label(date_str):
    """ISO date -> M/D/Y, matching formatEmailDateLabel() in
    workers/stable-tour-feed.js and the project's month/day/year convention
    for everything user-facing."""
    m = DATE_LABEL_RE.match(date_str or "")
    if not m:
        return date_str or "—"
    year, month, day = m.groups()
    return f"{int(month)}/{int(day)}/{year}"


# Note-age badge — same shape/position as the Worker's "NEW" badge on a
# quote ribbon (white pill, inline next to the QUOTE label), tiered by age
# instead of a single color. Thresholds match stableNoteAgeBadgeHtml() in
# index.html, so a quote reads the same age-wise in the UI and in email.
AGE_BADGE_COLORS = {"mild": "#a9a496", "caution": "#f0b429", "stale": "#e05252"}


def note_age_badge_html(date_str):
    m = DATE_LABEL_RE.match(date_str or "")
    if not m:
        return ""
    year, month, day = (int(x) for x in m.groups())
    days = (date.today() - date(year, month, day)).days
    if days < 122:
        return ""
    months = round(days / 30.4)
    tier = "mild" if days < 183 else "caution" if days < 274 else "stale"
    color = AGE_BADGE_COLORS[tier]
    return (
        f'<span style="display:inline-block; background:#ffffff; color:{color}; font-weight:700; '
        f'font-size:9px; letter-spacing:0.04em; padding:1px 6px; border-radius:8px; margin-left:7px; '
        f'vertical-align:middle;">{months} MO OLD</span>'
    )


def notes_for_horse(all_notes, tracked_trainers, horse_name):
    # normalize_horse_key strips the country suffix — the official entry
    # reads "Forever Young (JPN)" but every Stable Tour quote for that horse
    # is filed under the bare "Forever Young". Without stripping both sides
    # the same way (recaps_for_horse already did; this one didn't), every
    # foreign-bred horse (JPN/IRE/FR/GB/etc.) showed zero quotes in the real
    # Sunday digest despite the notes genuinely existing (confirmed real
    # 2026-10-26, caught via Forever Young specifically).
    key = normalize_horse_key(horse_name)
    matches = [n for n in all_notes if normalize_horse_key(n.get("horse")) == key]
    # Same rule the frontend's BC notes subsection uses: a trainer-less note
    # always shows; a note naming a trainer only shows once that trainer is
    # actually tracked.
    matches = [n for n in matches if not n.get("trainer") or n["trainer"] in tracked_trainers]
    matches.sort(key=lambda n: (n.get("date") or "", n.get("capturedAt") or ""), reverse=True)
    # Full history, not capped — user confirmed 2026-10-24 Gmail's clip
    # threshold is fine, this should show everything we have.
    return matches


# Recurring non-trainer, non-jockey podcast guests stored in the jockey
# field purely to reuse its existing "always show" display behavior (see
# write_episode_analyst_notes() in automation/podcast-quotes/write_notes.py)
# — same set as PODCAST_ANALYST_NAMES in index.html/workers/stable-tour-
# feed.js, kept here too so this script's own note cards don't mislabel him.
PODCAST_ANALYST_NAMES = {"David Aragona", "Steve Andersen", "ITM Staff"}


# "NEW" means genuinely never sent in a real (non-test) digest before — not
# just "newest by date" — n.digestedAt is set the first time a REAL send
# succeeds for this note, same field and same meaning as the Worker's
# runEntryAlerts()/buildStyledEntryDigestEmail() path, so a quote only ever
# shows NEW once across either email pipeline, never both. See main()'s
# post-send loop, which PATCHes digestedAt via /notes/bulk-cleanup.
def new_badge_html(n):
    if n.get("digestedAt"):
        return ""
    return (
        f'<span style="display:inline-block; background:#ffffff; color:{THEME["accent"]}; font-weight:700; '
        f'font-size:9px; letter-spacing:0.04em; padding:1px 6px; border-radius:8px; margin-left:7px; '
        f'vertical-align:middle;">NEW</span>'
    )


def note_card_html(n):
    is_analyst = n.get("jockey") in PODCAST_ANALYST_NAMES
    role_icon = "&#127908;" if n.get("trainer") else "&#128202;" if is_analyst else "&#127943;"
    role_label = "Trainer" if n.get("trainer") else "Analyst" if is_analyst else "Jockey"
    speaker = n.get("trainer") or n.get("jockey") or ""
    source = n.get("source") or ("auto-imported" if n.get("autoImported") else "manual")
    quote_hue = NOTE_TYPE_RIBBON_COLORS["quote"]
    new_badge = new_badge_html(n)
    age_badge = note_age_badge_html(n.get("date"))
    return f"""
    <div style="border-radius:6px; overflow:hidden; margin:4px 0 8px;">
      <div style="background:{quote_hue}; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10.5px; letter-spacing:0.05em; padding:6px 12px;">{role_icon} QUOTE &mdash; {esc(format_date_label(n.get('date')))}{new_badge}{age_badge}</div>
      <div style="background:{quote_hue}12; padding:10px 12px; font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:{THEME['ink']};">
        {esc(n.get('note'))}
        <div style="font-family:Arial,Helvetica,sans-serif; font-size:10.5px; color:{THEME['dim']}; margin-top:5px;"><strong style="color:{THEME['ink']};">{esc(speaker)}</strong> ({role_label}) &middot; {esc(source)}</div>
      </div>
    </div>"""


def ribbon_block_html(hue, icon, label, body_html):
    return f"""
    <div style="border-radius:6px; overflow:hidden; margin:4px 0 8px;">
      <div style="background:{hue}; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10.5px; letter-spacing:0.05em; padding:6px 12px;">{icon} {label}</div>
      <div style="background:{hue}12; padding:10px 12px; font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:{THEME['ink']};">{body_html}</div>
    </div>"""


def recaps_for_horse(recap_index, horse_name):
    key = normalize_horse_key(horse_name)
    entries = recap_index.get(key, [])
    return sorted(entries, key=lambda e: e.get("date") or "", reverse=True)


def recap_timeline_items(entries):
    """Returns (date, type_priority, tiebreak, html) tuples for every Full
    Card Recap / Race Recap box, one item per box rather than one per date —
    a date with both gets two items. type_priority breaks ties against
    quotes sharing the same date (see horse_timeline_html): full card above
    race recap above quote, matching the reading order the entries have
    always had when just the two of them shared a date."""
    items = []
    for e in entries:
        date_label = format_date_label(e.get("date"))
        origin_tag = f" &middot; {esc(TRACK_LABEL.get(e['track'], e['track']))}" if e.get("track") else ""
        if e.get("fullCardRecap"):
            html_block = ribbon_block_html(
                NOTE_TYPE_RIBBON_COLORS["fullCard"], "&#128197;",
                f"FULL CARD RECAP &mdash; {esc(date_label)}{origin_tag}", esc(e["fullCardRecap"]),
            )
            items.append((e.get("date") or "", 2, "", html_block))
        if e.get("recap"):
            race_tag = f" RACE {e['raceNumber']}" if e.get("raceNumber") else ""
            html_block = ribbon_block_html(
                NOTE_TYPE_RIBBON_COLORS["race"], "&#127937;",
                f"RACE RECAP &mdash; {esc(date_label)}{race_tag}{origin_tag}", esc(e["recap"]),
            )
            items.append((e.get("date") or "", 1, "", html_block))
    return items


def horse_timeline_html(all_notes, tracked_trainers, recap_index, horse_name):
    """Quotes, race recaps, and full card recaps all merged into ONE list,
    newest date first top-to-bottom — user request 2026-10-30, replacing the
    old layout that showed every recap first (as its own already-sorted
    block) and every quote after (as a separate already-sorted block), which
    read as two separately-chronological groups instead of one real
    timeline. Same-date ties fall back to recap-type priority (full card,
    then race recap, then quote) and, among quotes themselves, capturedAt."""
    items = list(recap_timeline_items(recaps_for_horse(recap_index, horse_name)))
    for n in notes_for_horse(all_notes, tracked_trainers, horse_name):
        items.append((n.get("date") or "", 0, n.get("capturedAt") or "", note_card_html(n)))
    items.sort(key=lambda it: (it[0], it[1], it[2]), reverse=True)
    return "".join(it[3] for it in items)


def race_anchor_id(race_num):
    return f"race-{race_num}"


def race_html(race, all_notes, tracked_trainers, recap_index, date_str):
    tag = f"RACE {race['num']} &middot; {esc(race['post'])} &middot; {esc(race['purse'])} {esc(race['cond'])} &middot; {esc(race['dist'])} {esc(race['surf'])}"
    race_name = BREEDERS_CUP_RACE_NAMES.get(date_str, {}).get(race["num"])
    race_name_html = (
        f'<div style="font-family:Georgia,\'Times New Roman\',serif; font-weight:700; font-size:16px; color:{THEME["accent"]}; margin-bottom:6px;">{esc(race_name)}</div>'
        if race_name else ""
    )
    # Real post-position order now, not alphabetical — alphabetical was a
    # pre-entry-only concession (no post positions existed yet to sort by).
    # Scratched horses are dropped entirely, not shown struck-through —
    # nothing left to bet or watch for once scratched, and "officially
    # entered" per the user's own ask means the horses actually running.
    horses = sorted((h for h in race["horses"] if not h.get("scratched")), key=lambda h: int(h["pgm"]))
    horses_html = []
    for idx, h in enumerate(horses):
        divider = f'<div style="border-top:1px dashed {THEME["hairline"]}; margin:14px 0 10px;"></div>' if idx > 0 else ""
        timeline_html = horse_timeline_html(all_notes, tracked_trainers, recap_index, h["name"])
        jt_line = f"{h.get('trainer') or '—'} &middot; {h.get('jockey') or '—'}" + (f" &middot; {esc(h['mlOdds'])}" if h.get("mlOdds") else "")
        horses_html.append(f"""
        {divider}
        <div style="margin:10px 0 3px;">
          {pp_badge_html(h['pgm'], h.get('alsoEligible'))}
          <span style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:15px; color:{THEME['ink']}; vertical-align:middle;">{esc(h['name'])}</span>
        </div>
        <div style="font-family:'Courier New',Courier,monospace; font-size:10.5px; color:{THEME['dim']}; margin:0 0 6px 30px;">{jt_line}</div>
        {timeline_html}""")
    return f"""
      <div id="{race_anchor_id(race['num'])}" style="padding:16px 30px; border-bottom:1px solid {THEME['hairline']};">
        {race_name_html}
        <span style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px; letter-spacing:0.06em; background:{THEME['accent']}; color:#ffffff; padding:3px 9px; border-radius:3px; margin-bottom:10px;">{tag}</span>
        {''.join(horses_html)}
      </div>"""


def page_filename(day):
    return f"{day['date']}.html"


# Confirmed real 2026-10-27: even the "name" anchor trick doesn't actually
# make Gmail jump within the email body — Gmail (web and app) simply
# doesn't support in-message anchor navigation at all, a documented email-
# client limitation, not something fixable with different HTML. The real
# fix newsletter platforms use for exactly this is a "view in browser" page:
# link each race pill to a REAL hosted copy of this same email (same
# GitHub Pages site index.html already deploys to) with the race's anchor
# in the URL — clicking it from Gmail opens a real browser tab, where the
# anchor-scroll already confirmed to work correctly takes over. page_url is
# None while building the *hosted page itself* (it doesn't need to link to
# itself) and the real URL when building the actual *email*.
def toc_html(day, page_url=None):
    races = day["races"]
    if len(races) < 2:
        return ""
    pills = []
    for r in races:
        name = BREEDERS_CUP_RACE_NAMES.get(day["date"], {}).get(r["num"], "")
        href = f"{page_url}#{race_anchor_id(r['num'])}" if page_url else f"#{race_anchor_id(r['num'])}"
        pills.append(
            f'<a href="{esc(href)}" title="{esc(name)}" '
            f'style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px; '
            f'color:{THEME["accent"]}; background:{THEME["hairline"]}; text-decoration:none; padding:3px 10px; '
            f'border-radius:10px; margin:2px 3px;">R{r["num"]}</a>'
        )
    note = (
        f'<div style="font-family:Arial,Helvetica,sans-serif; font-size:9.5px; color:{THEME["dim"]}; margin-top:6px;">'
        f"Opens the web version of this email, scrolled to that race &mdash; Gmail itself can't jump within a message.</div>"
        if page_url else ""
    )
    return f"""
    <div style="padding:10px 30px 14px; text-align:center; border-bottom:1px solid {THEME['hairline']};">
      <span style="display:block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:9px; letter-spacing:0.08em; text-transform:uppercase; color:{THEME['dim']}; margin-bottom:6px;">Jump to a race</span>
      {''.join(pills)}
      {note}
    </div>"""


def active_horse_count(day):
    return sum(1 for r in day["races"] for h in r["horses"] if not h.get("scratched"))


def build_day_body(day, all_notes, tracked_trainers, recap_index, page_url=None):
    horse_count = active_horse_count(day)
    races_html = "".join(race_html(r, all_notes, tracked_trainers, recap_index, day["date"]) for r in day["races"])
    return f"""
    <div style="background:{THEME['bg']}; color:{THEME['ink']}; font-family:Georgia,'Times New Roman',serif; max-width:640px; margin:0 auto;">
      <div style="padding:26px 30px 20px; text-align:center; border-bottom:3px double {THEME['accent']};">
        <div style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:22px; color:{THEME['accent']}; margin-bottom:6px;">GiddyUpQuotes &mdash; Breeders' Cup</div>
        <div style="font-family:'Courier New',Courier,monospace; font-size:11px; color:{THEME['dim']};">Keeneland &middot; {esc(day['label'])} &middot; {horse_count} entered horses &middot; OFFICIAL ENTRIES &mdash; POST POSITIONS DRAWN</div>
      </div>
      {toc_html(day, page_url)}
      {races_html}
    </div>"""


def build_day_email(day, all_notes, tracked_trainers, recap_index):
    horse_count = active_horse_count(day)
    subject = f"GiddyUpQuotes — Breeders' Cup Official Entries — {day['label']} ({horse_count} horses)"
    page_url = f"{PAGES_BASE}/bc-digest/{page_filename(day)}"
    html_body = build_day_body(day, all_notes, tracked_trainers, recap_index, page_url=page_url)
    return subject, html_body


def build_day_page(day, all_notes, tracked_trainers, recap_index):
    """The hosted 'view in browser' copy — same content as the email, just
    without its own page_url (no point linking to itself), wrapped as a
    real standalone document so a browser (not Gmail) renders it and the
    anchor-scroll toc_html() points at actually works."""
    body = build_day_body(day, all_notes, tracked_trainers, recap_index, page_url=None)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GiddyUpQuotes — Breeders' Cup Official Entries — {esc(day['label'])}</title>
</head>
<body style="margin:0; padding:20px 0; background:{THEME['bg']};">
{body}
</body>
</html>"""


def main():
    # --pages-only: regenerate the hosted "view in browser" pages (bc-digest/
    # *.html) from current data without sending a real email or re-running
    # /notes/bulk-cleanup — added 2026-10-30 so a stale page (e.g. one that
    # predates notes getting digestedAt set by the real production entry-
    # alert pipeline, which is what made every quote wrongly show NEW) can be
    # refreshed on its own, separate from the "send real mail" side effect.
    pages_only = "--pages-only" in sys.argv

    bc_data = load_bc_data()
    data = fetch_url(f"{WORKER_BASE}/data")
    all_notes = data.get("notes", [])
    tracked_trainers = set(data.get("trainers", []))
    recap_index = fetch_url(f"{WORKER_BASE}/recap-index").get("byHorse", {})

    pages_dir = REPO_ROOT / "bc-digest"
    pages_dir.mkdir(exist_ok=True)

    for day in bc_data["days"]:
        page_html = build_day_page(day, all_notes, tracked_trainers, recap_index)
        (pages_dir / page_filename(day)).write_text(page_html, encoding="utf-8")
        print(f"{day['label']}: wrote {pages_dir / page_filename(day)}", flush=True)

    if pages_only:
        print("--pages-only: skipped email send and digestedAt patching.", flush=True)
        return

    sent_note_ids = set()
    for day in bc_data["days"]:
        subject, html_body = build_day_email(day, all_notes, tracked_trainers, recap_index)
        result = fetch_url(f"{WORKER_BASE}/send-custom-email", method="POST", body={"subject": subject, "html": html_body})
        print(f"{day['label']}: sent -> {result}", flush=True)
        for race in day["races"]:
            for h in race["horses"]:
                if h.get("scratched"):
                    continue
                for n in notes_for_horse(all_notes, tracked_trainers, h["name"]):
                    sent_note_ids.add(n["id"])

    # Mark every note just sent as "digested" — same field/meaning as the
    # Worker's runEntryAlerts() uses for the real production entry-alert
    # emails — so the "NEW" badge only ever shows a quote once, across
    # either email pipeline. Only patches notes that don't already have
    # digestedAt set (a note already sent via the real daily pipeline
    # shouldn't re-show as NEW here just because this script saw it first).
    to_patch = [n["id"] for n in all_notes if n["id"] in sent_note_ids and not n.get("digestedAt")]
    if to_patch:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        patches = [{"id": nid, "digestedAt": now} for nid in to_patch]
        result = fetch_url(f"{WORKER_BASE}/notes/bulk-cleanup", method="POST", body={"deleteIds": [], "patches": patches})
        print(f"Marked {result.get('patched', 0)} notes as digested (NEW badge will clear next send).", flush=True)


if __name__ == "__main__":
    sys.exit(main())
