# Entries Scaffold Automation (standalone, no Claude Code involved at runtime)

Fetches Saratoga/Belmont entries from the Worker and uploads a formatted Google Doc scaffold
(colored saddlecloth chicklets, morning-line odds, blank space for trip notes) to the shared
**GupB Daily Entries** Drive folder — the same format as the Claude-desktop-app scheduled task
of the same name, but runs via macOS `launchd` against a Google Cloud service account, so it
works even when the Claude desktop app (and your own login session, within limits — see the
LaunchAgent note below) is closed.

Because this runs as a plain Node script calling the Google Drive API directly — no LLM tool
call in the loop — it does **not** have the "large tool-call payload silently truncates"
failure mode that broke the first .docx-based version of this job in production on 2026-09-06.
That was specific to routing a big blob through an LLM-driven tool call, not a real Drive API
limit.

## One-time setup

### Stage 2 — Google Cloud service account

You need a credential that isn't tied to your own Google login, so the script can run
unattended. This creates a "robot" identity with its own email address, then you share the
Drive folder with that identity (just like sharing with a person).

1. Go to **https://console.cloud.google.com/** and sign in with the Google account that owns
   the GupB Daily Entries folder (jvilla10214@gmail.com).
2. If you don't already have a project, create one — top-left project picker → **New Project**.
   Name it something like `gupb-entries-automation`. (Free tier; the Drive API has no cost for
   this volume of usage.)
3. **Enable the Drive API**: left sidebar → *APIs & Services* → *Library* → search
   "Google Drive API" → click it → **Enable**.
4. **Create the service account**: *APIs & Services* → *Credentials* → **Create Credentials** →
   **Service account**. Name it e.g. `entries-scaffold-bot`. You can skip the optional
   "grant this service account access to project" and "grant users access" steps — click
   **Done**.
5. **Create a key**: click into the new service account → **Keys** tab → **Add Key** →
   **Create new key** → **JSON** → Create. A `.json` file downloads to your Mac.
6. **Copy the service account's email address** — it's on the service account's details page,
   looks like `entries-scaffold-bot@gupb-entries-automation.iam.gserviceaccount.com`.
7. **Share the Drive folder with it**: open Google Drive, find the "GupB Daily Entries" folder,
   right-click → **Share** → paste the service account's email → set role to **Editor** →
   **Send** (or **Share**, no notification email needed — the checkbox for that can be
   unchecked, it's a robot address, not a person).
8. **Move the downloaded key into this project**: rename the downloaded file to
   `service-account.json` and move it to:
   ```
   /Users/VILLA/Downloads/GiddyUpBets-command-center/automation/entries-scaffold/credentials/service-account.json
   ```
   This path is already gitignored — it will never get committed.

### Test it manually before scheduling anything

```bash
cd /Users/VILLA/Downloads/GiddyUpBets-command-center/automation/entries-scaffold
node run.js
```

Expect one line per track: either `skipped (no races drawn yet)`, `skipped (already exists)`,
or `CREATED <link>`. Check `logs/run.log` for the same output. If you see an auth error, double
check the key file is at the exact path above and that the folder was actually shared with the
service account's email (not just "enabled" — sharing is what grants access).

### Stage 3 — macOS launchd (runs it automatically, hourly, 6am–12pm ET)

A ready-made launch agent is included: `com.giddyupbets.entries-scaffold.plist`.

1. Copy it into place:
   ```bash
   cp /Users/VILLA/Downloads/GiddyUpBets-command-center/automation/entries-scaffold/com.giddyupbets.entries-scaffold.plist ~/Library/LaunchAgents/
   ```
2. Load it:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.giddyupbets.entries-scaffold.plist
   ```
   (If that errors because it's already loaded from a previous attempt, first run
   `launchctl bootout gui/$(id -u)/com.giddyupbets.entries-scaffold` then retry the bootstrap.)
3. To test without waiting for the next scheduled hour:
   ```bash
   launchctl kickstart gui/$(id -u)/com.giddyupbets.entries-scaffold
   ```
   Then check `logs/run.log` and `logs/launchd.out.log` / `logs/launchd.err.log`.

**Important nuance**: a `launchd` LaunchAgent (as opposed to a system-wide LaunchDaemon) only
runs while you're **logged into your Mac user account** — it does *not* require the Claude
desktop app to be open, but it does require your Mac to be on and you to be logged in (not
sitting at the login screen). For a Mac you use daily and rarely fully log out of, this is a
much lower bar than "the app must be open." If the Mac is asleep or off at a scheduled hour,
launchd runs the missed job automatically the next time it wakes/logs in — no cron-style
catch-up logic needed.

## Files

- `run.js` — orchestrator: date, fetch, dedupe-check, build, upload, verify, log.
- `build-html.js` — pure HTML-building logic (same format as the Claude-driven version),
  reusable/testable without any Drive credentials.
- `com.giddyupbets.entries-scaffold.plist` — the launchd schedule.
- `credentials/service-account.json` — **you provide this, gitignored, never commit it.**
- `logs/` — `run.log` (script's own log) plus launchd's stdout/stderr captures, gitignored.
