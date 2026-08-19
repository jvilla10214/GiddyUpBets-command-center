# Weather Bias Predictor Score — real-data tuning check

Standalone research script. **Not part of the live site** — it only reads the
same public `/weatherlog` and `/biaslog` endpoints the site itself reads
from, and writes a markdown report to disk. It cannot write back to the
Worker's storage and never modifies the live heuristic.

## What it does

The live Weather Bias Predictor Score (`computeBiasPredictorScore()` in
`index.html`) is a hand-tuned heuristic, not a fitted model. This script
pulls the accumulated Daily Log (weather) and Bias Tracker (actual observed
bias) entries for a track, joins them by date, and reports — with sample
sizes attached to every number — how strongly each weather variable actually
relates to the real outcome. Read the report and decide for yourself whether
anything looks worth re-weighting; the script won't decide that for you.

## Setup

```bash
pip install -r requirements.txt
```

## Usage

```bash
python3 bias_weather_analysis.py --track saratoga
```

Options:
- `--track` — track id (`saratoga`, `delmar`, `monmouth`, `belmont`, ...). Default `saratoga`.
- `--worker-url` — override the Worker base URL (default: production).
- `--output` — output file path (default: `analysis/reports/<track>_<date>.md`).
- `--min-group-n` — minimum rows per bias-outcome group before its mean is trusted rather than flagged thin (default 8).

## Known data gaps (as of 2026-08-19)

- **Humidity isn't stored in the Daily Log at all** — the live site's own
  retrospective-score logic explicitly nulls it out when archiving a day, so
  there's no history to check it against yet. The report says this plainly
  rather than silently skipping it.
- **Apparent temp isn't stored either** — the report uses daily temp
  high/low as the closest available proxy and labels every finding that
  uses it.
- **Tide** only applies to Del Mar, which currently has 0 Bias Tracker
  entries — can't be checked either direction yet.
- Only Saratoga has a meaningful sample right now (see the report's own
  sample-size section for the current count). Other tracks will report
  "not enough data" until their Bias Tracker fills in.

Rerun periodically as more days accumulate — this is meant to be a
recurring check, not a one-time report.
