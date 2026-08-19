#!/usr/bin/env python3
"""
Weather Bias Predictor Score — real-data tuning check.

Standalone research tool. NOT part of the live site and never touches it —
this only reads the same public Daily Log / Bias Tracker endpoints the site
itself reads from, and writes a markdown report to disk. It has no way to
write back to the Worker's storage and never adjusts the live heuristic.

Purpose: the live Weather Bias Predictor Score (index.html's
computeBiasPredictorScore()) is a hand-tuned heuristic, not a fitted model —
see that function's own comment: "a reasonable starting heuristic, not a
validated model". This script pulls the accumulated Daily Log (weather) and
Bias Tracker (actual observed bias) entries for a track, joins them by date,
and reports how strongly each weather variable actually relates to the real
outcome — so you can sanity-check the heuristic's current weights against
real data and decide whether any of them look worth adjusting. It never
decides that for you.

Usage:
    python3 bias_weather_analysis.py --track saratoga
    python3 bias_weather_analysis.py --track saratoga --output report.md
    python3 bias_weather_analysis.py --track delmar --min-group-n 5

Dependencies (free, standard): requests, pandas, scipy
    pip install requests pandas scipy
"""

import argparse
import os
import sys
from datetime import datetime, timezone

import requests
import pandas as pd
from scipy import stats

DEFAULT_WORKER_URL = "https://stable-tour-feed.jvilla10214.workers.dev"

# Below this many joined rows overall, don't run the analysis at all — same
# spirit as the live site's own sample-size guardrails elsewhere (e.g.
# PP_STATS_MIN_SAMPLE_WINS in index.html), just applied here to this
# specific join instead of post-position win totals.
MIN_TOTAL_ROWS = 15

# Below this many rows in a single bias-outcome group (e.g. "how many days
# were actually Speed-favoring"), that group's mean still gets printed but
# flagged as too thin to draw a conclusion from.
DEFAULT_MIN_GROUP_N = 8

# Correlation-strength labels for the report — deliberately coarse and
# labeled, not just raw numbers, so this stays readable rather than turning
# into unlabeled decimals. Common rule-of-thumb bands, not a statistical
# standard.
def strength_label(r):
    if r is None:
        return "n/a"
    a = abs(r)
    if a < 0.10: return "negligible"
    if a < 0.30: return "weak"
    if a < 0.50: return "moderate"
    return "strong"


# ---------------------------------------------------------------------------
# Track geometry — copied from the TRACKS registry in index.html (heading.
# homestretch/backstretch, degrees). This script is standalone on purpose
# (per the request: not part of the live site), so this is a manual copy,
# not a shared import — keep in sync by hand if a track's heading is ever
# re-measured on the live site. Only tracks with real Bias Tracker data are
# likely to matter here today, but all four NYRA/DMTC-adjacent tracks this
# app tracks bias for are included for when the others accumulate data.
TRACK_HEADINGS = {
    "saratoga": {"homestretch": 243, "backstretch": 63},
    "belmont": {"homestretch": 109, "backstretch": 289},
    "delmar": {"homestretch": 107, "backstretch": 287},
    "monmouth": {"homestretch": 162, "backstretch": 342},
}

# Ordinal wetness scale — matches the live site's own severity ordering in
# estimateDirtCondition()/estimateTurfCondition() and NYRA_CONDITION_CLASS.
DIRT_WETNESS = {"FAST": 0, "GOOD": 1, "MUDDY": 2, "SLOPPY / WET": 3}
TURF_WETNESS = {"FIRM": 0, "GOOD": 1, "YIELDING": 2, "SOFT": 3}

# Bias Tracker's 4-value enum -> signed direction. Mixed / Inconsistent and
# unknown values are excluded from the numeric correlation (there's no
# sensible "amount" for an inconsistent day) but still counted and shown
# separately in the grouped-means table, same as how the live site's own
# calibration check (computeScoreCalibration()) treats Mixed as
# "inconclusive" rather than a directional miss.
def bias_direction(label):
    return {"Speed-favoring": 1, "Neutral / No Bias": 0, "Closer-favoring": -1}.get(label)


# ---------------------------------------------------------------------------
# The live heuristic's current weighting — hand-transcribed from
# computeBiasPredictorScore() in index.html, for the comparison section.
# Keep this in sync by hand if that function changes; it's deliberately a
# plain data structure here (not parsed out of the JS) so it's easy to read
# and easy to see exactly what this script is comparing against.
HEURISTIC_SUMMARY = [
    ("Homestretch headwind/tailwind", "dominant factor: tailwind up to +2.5 (favors speed), headwind up to -2.5 (favors closers), tiered by strength"),
    ("Backstretch wind (combined with homestretch)", "secondary: only two specific combos apply, ±1.0 or ±0.5"),
    ("Dirt moisture (SLOPPY/WET or MUDDY label)", "+1.5 / +0.8 toward speed — turf has no equivalent term at all today"),
    ("Tide (Del Mar only)", "+1.5 Low / -1.5 High toward speed — no data to check yet, Del Mar has 0 Bias Tracker entries"),
    ("Apparent temp >=90F or <=40F", "+0.5 toward speed — the function's own comment calls this its least certain signal"),
    ("Humidity >=80%", "+0.5 toward speed — same stamina-extrapolation caveat as apparent temp"),
]

# Which of the above can actually be checked against history today. Daily
# Log entries never store humidity or apparentTemp at all (see index.html
# maybeAutoLogYesterday(), which explicitly nulls both out when computing
# the retrospective score — "aren't part of the daily archive stats
# gathered here") and tide only applies to a track with zero Bias Tracker
# entries so far. This script substitutes daily temp high/low as the
# closest available proxy for apparent temp and says so in the report;
# humidity has no substitute and is just reported as untestable.
UNTESTABLE_FACTORS = [
    "Humidity — not stored in the Daily Log at all, no historical data exists to check this against.",
    "Tide (Del Mar) — Del Mar currently has 0 Bias Tracker entries, so this can't be checked yet either way.",
    "Apparent temp — not stored directly; this report uses daily temp high/low as the closest available stand-in and flags every finding that uses it.",
]


def fetch_json(url):
    res = requests.get(url, timeout=20)
    res.raise_for_status()
    return res.json()


def fetch_weatherlog(base_url, track):
    data = fetch_json(f"{base_url}/weatherlog?track={track}")
    return data.get("entries", [])


def fetch_biaslog(base_url, track):
    data = fetch_json(f"{base_url}/biaslog?track={track}")
    return data.get("entries", [])


def wind_components(speed, source_deg, heading_deg):
    """Exact port of windComponents() in index.html. source_deg is the
    meteorological "wind FROM" direction (matches Open-Meteo's
    wind_direction_10m, same field the Daily Log stores). Positive headwind
    means the wind blows into the horses as they run toward heading_deg."""
    import math
    rad = math.radians(source_deg - heading_deg)
    return speed * math.cos(rad), speed * math.sin(rad)


def build_rows(weatherlog, biaslog, track):
    """One row per date with both a completed (non-partial) Daily Log entry
    and a Bias Tracker entry for that same date — the join the whole
    analysis runs on. Adds the derived wind-component and wetness-index
    columns used below."""
    heading = TRACK_HEADINGS.get(track)
    bias_by_date = {e["date"]: e for e in biaslog}

    rows = []
    for w in weatherlog:
        if w.get("isPartial"):
            continue
        b = bias_by_date.get(w["date"])
        if not b:
            continue

        row = {
            "date": w["date"],
            "wind_avg_mph": w.get("windAvg"),
            "wind_gust_peak_mph": w.get("windGustPeak"),
            "wind_prevailing_deg": w.get("windPrevailingDeg"),
            "rain_total_in": w.get("rainTotal"),
            "temp_high_f": w.get("tempHigh"),
            "temp_low_f": w.get("tempLow"),
            "dirt_condition_label": w.get("dirtConditionLabel"),
            "turf_condition_label": w.get("turfConditionLabel"),
            "dirt_bias": b.get("dirtBias"),
            "turf_bias": b.get("turfBias"),
        }

        row["dirt_wetness_index"] = DIRT_WETNESS.get(row["dirt_condition_label"])
        row["turf_wetness_index"] = TURF_WETNESS.get(row["turf_condition_label"])

        if heading and row["wind_avg_mph"] is not None and row["wind_prevailing_deg"] is not None:
            hw, cw = wind_components(row["wind_avg_mph"], row["wind_prevailing_deg"], heading["homestretch"])
            row["homestretch_headwind_mph"] = hw
            row["homestretch_crosswind_mph"] = cw
        else:
            row["homestretch_headwind_mph"] = None
            row["homestretch_crosswind_mph"] = None

        row["dirt_bias_num"] = bias_direction(row["dirt_bias"])
        row["turf_bias_num"] = bias_direction(row["turf_bias"])

        rows.append(row)

    return pd.DataFrame(rows)


# Variable -> (dataframe column, human label). Kept separate per surface
# since dirt/turf wetness index means different things and turf has no
# tide/dirt-moisture equivalent in the live heuristic at all.
DIRT_VARIABLES = [
    ("wind_avg_mph", "Average wind speed (mph)"),
    ("wind_gust_peak_mph", "Peak wind gust (mph)"),
    ("homestretch_headwind_mph", "Homestretch headwind component (+) / tailwind (-)"),
    ("homestretch_crosswind_mph", "Homestretch crosswind component (magnitude, signed)"),
    ("rain_total_in", "Total rainfall (in)"),
    ("dirt_wetness_index", "Dirt wetness index (0=Fast .. 3=Sloppy/Wet)"),
    ("temp_high_f", "Daily high temp (°F) — apparent-temp proxy, see caveat"),
    ("temp_low_f", "Daily low temp (°F) — apparent-temp proxy, see caveat"),
]
TURF_VARIABLES = [
    ("wind_avg_mph", "Average wind speed (mph)"),
    ("wind_gust_peak_mph", "Peak wind gust (mph)"),
    ("homestretch_headwind_mph", "Homestretch headwind component (+) / tailwind (-)"),
    ("homestretch_crosswind_mph", "Homestretch crosswind component (magnitude, signed)"),
    ("rain_total_in", "Total rainfall (in)"),
    ("turf_wetness_index", "Turf wetness index (0=Firm .. 3=Soft)"),
    ("temp_high_f", "Daily high temp (°F) — apparent-temp proxy, see caveat"),
    ("temp_low_f", "Daily low temp (°F) — apparent-temp proxy, see caveat"),
]

APPARENT_TEMP_PROXY_COLS = {"temp_high_f", "temp_low_f"}


def correlate(df, xcol, ycol):
    sub = df[[xcol, ycol]].dropna()
    n = len(sub)
    if n < 3:
        return {"n": n, "pearson_r": None, "pearson_p": None, "spearman_rho": None, "spearman_p": None}
    pear = stats.pearsonr(sub[xcol], sub[ycol])
    spear = stats.spearmanr(sub[xcol], sub[ycol])
    return {
        "n": n,
        "pearson_r": pear.statistic, "pearson_p": pear.pvalue,
        "spearman_rho": spear.statistic, "spearman_p": spear.pvalue,
    }


def grouped_means(df, xcol, bias_col, min_group_n):
    order = ["Speed-favoring", "Neutral / No Bias", "Closer-favoring", "Mixed / Inconsistent"]
    sub = df[[xcol, bias_col]].dropna()
    rows = []
    for cat in order:
        vals = sub.loc[sub[bias_col] == cat, xcol]
        if len(vals) == 0:
            continue
        rows.append({
            "category": cat, "n": len(vals),
            "mean": vals.mean(), "std": vals.std() if len(vals) > 1 else float("nan"),
            "thin": len(vals) < min_group_n,
        })
    return rows


def analyze_surface(df, surface, variables, bias_col, min_group_n):
    """Returns (correlation_results, groupmeans_by_var) for one surface."""
    corr_results = []
    group_results = {}
    for col, label in variables:
        c = correlate(df, col, f"{bias_col}_num")
        c.update({"col": col, "label": label})
        corr_results.append(c)
        group_results[col] = grouped_means(df, col, bias_col, min_group_n)
    return corr_results, group_results


# Thresholds for the auto-flagged mismatch section — deliberately explicit
# constants, not hidden magic, so they're easy to see and adjust.
STRONG_R = 0.40
WEAK_R = 0.15


def flag_mismatches(corr_results, heuristic_weighted_high):
    """Simple, transparent rule: a variable the heuristic leans on heavily
    but that shows a weak real-data correlation (with a usable n) is
    flagged as possibly overweighted; a variable that shows a surprisingly
    strong correlation despite little/no role in the current heuristic is
    flagged as possibly underweighted. Purely descriptive — this prints
    observations, it never changes anything."""
    flags = []
    for c in corr_results:
        if c["n"] < MIN_TOTAL_ROWS or c["pearson_r"] is None:
            continue
        r = c["pearson_r"]
        heavily_weighted = c["col"] in heuristic_weighted_high
        if heavily_weighted and abs(r) < WEAK_R:
            flags.append(f"- **{c['label']}** is a heavily-weighted factor in the live heuristic, but shows only a {strength_label(r)} relationship in real data (r={r:.2f}, n={c['n']}). Worth reviewing whether it's overweighted.")
        if not heavily_weighted and abs(r) >= STRONG_R:
            flags.append(f"- **{c['label']}** shows a {strength_label(r)} relationship in real data (r={r:.2f}, n={c['n']}) despite little or no role in the current heuristic. Worth considering whether it should be weighted at all.")
    return flags


# Columns the live heuristic leans on heavily today, for the flag logic
# above — homestretch wind is the dominant term by a wide margin.
HEAVILY_WEIGHTED_DIRT_COLS = {"homestretch_headwind_mph"}
HEAVILY_WEIGHTED_TURF_COLS = set()  # the live score has never predicted Turf Bias at all


def format_corr_table(corr_results):
    lines = ["| Variable | n | Pearson r | Spearman ρ | Strength |", "|---|---|---|---|---|"]
    for c in corr_results:
        note = " *(apparent-temp proxy)*" if c["col"] in APPARENT_TEMP_PROXY_COLS else ""
        if c["pearson_r"] is None:
            lines.append(f"| {c['label']}{note} | {c['n']} | n/a (too few rows) | n/a | n/a |")
        else:
            lines.append(
                f"| {c['label']}{note} | {c['n']} | {c['pearson_r']:.2f} (p={c['pearson_p']:.3f}) "
                f"| {c['spearman_rho']:.2f} (p={c['spearman_p']:.3f}) | {strength_label(c['pearson_r'])} |"
            )
    return "\n".join(lines)


def format_group_table(group_results, variables):
    lines = []
    for col, label in variables:
        groups = group_results.get(col, [])
        if not groups:
            continue
        lines.append(f"\n**{label}**\n")
        lines.append("| Bias outcome | n | Mean | Std dev |")
        lines.append("|---|---|---|---|")
        for g in groups:
            thin = " *(too few to trust)*" if g["thin"] else ""
            std_str = f"{g['std']:.2f}" if g["std"] == g["std"] else "n/a"  # NaN check
            lines.append(f"| {g['category']}{thin} | {g['n']} | {g['mean']:.2f} | {std_str} |")
    return "\n".join(lines)


def build_report(track, df_dirt, df_turf, dirt_corr, dirt_groups, turf_corr, turf_groups,
                  dirt_flags, min_group_n, weatherlog_n, biaslog_n):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = []
    lines.append(f"# Weather Bias Predictor Score — Real-Data Check ({track})")
    lines.append(f"\nGenerated {now}. Standalone research script, read-only against the live Worker's "
                  f"Daily Log/Bias Tracker storage — this never modifies the live site or its heuristic.\n")

    lines.append("## Sample size")
    lines.append(f"- {weatherlog_n} total Daily Log entries, {biaslog_n} total Bias Tracker entries for `{track}`.")
    lines.append(f"- **{len(df_dirt)} joined rows for Dirt Bias**, **{len(df_turf)} joined rows for Turf Bias** "
                  f"(dates with both a completed Daily Log entry and a same-date Bias Tracker entry).")
    if len(df_dirt) < MIN_TOTAL_ROWS:
        lines.append(f"\n⚠️ **Below the {MIN_TOTAL_ROWS}-row floor this script uses before treating a finding as "
                      f"even preliminary.** The tables below are still computed and shown, but treat them as "
                      f"exploratory only — rerun this once more days have accumulated.")
    else:
        lines.append(f"\nAbove the {MIN_TOTAL_ROWS}-row floor this script applies before treating a finding as "
                      f"at least preliminary. Individual bias-outcome groups below {min_group_n} rows are still "
                      f"shown but marked *(too few to trust)* — small groups (e.g. only 2-3 Speed-favoring days) "
                      f"can look dramatic just from noise.")

    lines.append("\n## What the live heuristic weights today")
    lines.append("\n(Hand-transcribed from `computeBiasPredictorScore()` in index.html — the baseline this report compares against.)\n")
    lines.append("| Factor | Current weighting |")
    lines.append("|---|---|")
    for factor, weight in HEURISTIC_SUMMARY:
        lines.append(f"| {factor} | {weight} |")

    lines.append("\n## What can't be checked against history yet")
    for item in UNTESTABLE_FACTORS:
        lines.append(f"- {item}")

    lines.append("\n## Dirt Bias — correlation with each weather variable")
    lines.append(f"\n(+1 = Speed-favoring, 0 = Neutral, -1 = Closer-favoring. Mixed/Inconsistent days excluded from "
                  f"this correlation — see the grouped table below for where those land.)\n")
    lines.append(format_corr_table(dirt_corr))
    lines.append("\n### Dirt Bias — grouped averages by actual outcome")
    lines.append(format_group_table(dirt_groups, DIRT_VARIABLES))

    lines.append("\n## Turf Bias — correlation with each weather variable")
    lines.append(f"\nNote: **the live heuristic has never predicted Turf Bias at all** — there is no existing "
                  f"turf weighting to compare against here, so this section is purely exploratory groundwork "
                  f"for a possible future turf-specific score, not a check against something that exists today.\n")
    lines.append(format_corr_table(turf_corr))
    lines.append("\n### Turf Bias — grouped averages by actual outcome")
    lines.append(format_group_table(turf_groups, TURF_VARIABLES))

    lines.append("\n## Flagged mismatches (Dirt Bias only — the only surface with an existing heuristic to compare against)")
    if dirt_flags:
        lines.extend(dirt_flags)
    else:
        lines.append(f"- None crossed the {WEAK_R}/{STRONG_R} r thresholds this script flags at, given today's sample size.")

    lines.append("\n---\n*This report is descriptive only. It does not change the live heuristic, and none of "
                  "these numbers should be treated as conclusive with a sample this size — rerun periodically as "
                  "more days accumulate.*")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Check the Weather Bias Predictor Score's weights against real Daily Log / Bias Tracker data.")
    parser.add_argument("--track", default="saratoga", help="Track id, e.g. saratoga, delmar, monmouth, belmont (default: saratoga)")
    parser.add_argument("--worker-url", default=DEFAULT_WORKER_URL, help="Base URL of the Stable Tour worker (default: production)")
    parser.add_argument("--output", default=None, help="Output markdown file path (default: analysis/reports/<track>_<date>.md)")
    parser.add_argument("--min-group-n", type=int, default=DEFAULT_MIN_GROUP_N, help=f"Minimum rows per bias-outcome group before trusting its mean (default: {DEFAULT_MIN_GROUP_N})")
    args = parser.parse_args()

    track = args.track.strip().lower()
    if track not in TRACK_HEADINGS:
        print(f"Warning: no track heading on file for '{track}' — homestretch wind-component columns will be blank for it.", file=sys.stderr)

    print(f"Fetching Daily Log + Bias Tracker for '{track}' from {args.worker_url} ...")
    try:
        weatherlog = fetch_weatherlog(args.worker_url, track)
        biaslog = fetch_biaslog(args.worker_url, track)
    except requests.RequestException as e:
        print(f"Failed to fetch data: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"  {len(weatherlog)} Daily Log entries, {len(biaslog)} Bias Tracker entries.")

    df = build_rows(weatherlog, biaslog, track)
    if df.empty:
        print("\nNo joinable rows at all (no date has both a Daily Log entry and a Bias Tracker entry) — "
              "nothing to analyze yet for this track. Exiting without writing a report.")
        sys.exit(0)

    df_dirt = df.dropna(subset=["dirt_bias"])
    df_turf = df.dropna(subset=["turf_bias"])

    print(f"  {len(df_dirt)} joined rows for Dirt Bias, {len(df_turf)} for Turf Bias.")

    if len(df_dirt) == 0 and len(df_turf) == 0:
        print("\nNo rows have a usable Dirt or Turf Bias value — nothing to analyze yet for this track. "
              "Exiting without writing a report.")
        sys.exit(0)

    dirt_corr, dirt_groups = analyze_surface(df_dirt, "dirt", DIRT_VARIABLES, "dirt_bias", args.min_group_n)
    turf_corr, turf_groups = analyze_surface(df_turf, "turf", TURF_VARIABLES, "turf_bias", args.min_group_n)

    dirt_flags = flag_mismatches(dirt_corr, HEAVILY_WEIGHTED_DIRT_COLS)
    # Turf has no existing heuristic weighting to flag mismatches against —
    # every variable is "not currently weighted", so the over/underweight
    # framing doesn't apply the same way. Intentionally not called here;
    # see the report's Turf section note instead.

    report = build_report(
        track, df_dirt, df_turf, dirt_corr, dirt_groups, turf_corr, turf_groups,
        dirt_flags, args.min_group_n, len(weatherlog), len(biaslog),
    )

    if args.output:
        out_path = args.output
    else:
        # Relative to this script's own location, not the process's current
        # working directory — so `python3 bias_weather_analysis.py` behaves
        # the same whether run from the repo root or from inside analysis/.
        date_str = datetime.now().strftime("%Y-%m-%d")
        reports_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
        os.makedirs(reports_dir, exist_ok=True)
        out_path = os.path.join(reports_dir, f"{track}_{date_str}.md")

    with open(out_path, "w") as f:
        f.write(report)

    print(f"\nReport written to {out_path}")
    if len(df_dirt) < MIN_TOTAL_ROWS:
        print(f"Note: {len(df_dirt)} rows is below this script's own {MIN_TOTAL_ROWS}-row floor — "
              f"treat findings as exploratory, not conclusive.")


if __name__ == "__main__":
    main()
