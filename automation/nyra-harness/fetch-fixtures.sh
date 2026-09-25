#!/usr/bin/env bash
# Caches the test articles, both NYRA news listings, and a /data snapshot.
# Run from anywhere; writes to automation/nyra-harness/fixtures/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
for p in $(node -e 'for (const a of require("./articles.json")) console.log(a.path)') belmont/news/ saratoga/news/; do
  f="fixtures/$(echo "$p" | tr / _).html"
  curl -sS -A "$UA" --max-time 30 -o "$f" -w "$p %{http_code}\n" "https://www.nyra.com/$p"
done
curl -sS --max-time 30 -o fixtures/data.json -w "/data %{http_code}\n" https://stable-tour-feed.jvilla10214.workers.dev/data
