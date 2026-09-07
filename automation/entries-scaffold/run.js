// Standalone (no Claude/AI at runtime) daily job for the GiddyUpBets Command Center project.
// Fetches Saratoga/Belmont entries and, if drawn and not already uploaded today, builds a
// formatted Google Doc scaffold and uploads it to the shared "GupB Daily Entries" Drive folder.
//
// This replaces the Claude-desktop-app-only scheduled task of the same name — same format, same
// dedupe rule, same post-upload verification — but runs via macOS launchd against a Google Cloud
// service account, so it works even when the desktop app (and the user's own login session) is
// closed. See ../../.claude/scheduled-tasks/saratoga-belmont-entries-scaffold/SKILL.md for the
// full history of the format (including the tool-call truncation bug that forced Google-Doc-via-
// HTML instead of a raw .docx upload).
//
// Setup: see README.md in this directory for the one-time service-account + launchd steps.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { buildEntriesHtml } = require('./build-html');

const WORKER_BASE = 'https://stable-tour-feed.jvilla10214.workers.dev';
const FOLDER_ID = '1l22JvNDafER_MdC_b49boRcP4SV7oxEF'; // "GupB Daily Entries"
const TRACKS = [
  { id: 'saratoga', display: 'Saratoga' },
  { id: 'belmont', display: 'Belmont' },
];
const SERVICE_ACCOUNT_KEY_PATH = path.join(__dirname, 'credentials', 'service-account.json');
const LOG_PATH = path.join(__dirname, 'logs', 'run.log');

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, stamped + '\n');
}

function todayIso() {
  // America/New_York regardless of the machine's own TZ setting.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function fetchEntries(trackId, isoDate) {
  const url = `${WORKER_BASE}/entries?track=${trackId}&date=${isoDate}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  }
  return res.json();
}

function driveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
    throw new Error(
      `Missing service account key at ${SERVICE_ACCOUNT_KEY_PATH}. See README.md for setup.`
    );
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function findExisting(drive, title) {
  const escaped = title.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and name = '${escaped}' and trashed = false`,
    fields: 'files(id, name)',
  });
  return res.data.files && res.data.files.length > 0 ? res.data.files[0] : null;
}

async function uploadEntriesDoc(drive, title, html) {
  const res = await drive.files.create({
    requestBody: {
      name: title,
      parents: [FOLDER_ID],
      mimeType: 'application/vnd.google-apps.document',
    },
    media: {
      mimeType: 'text/html',
      body: html,
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

function expectedRaceHeaders(data) {
  return [...data.races]
    .sort((a, b) => a.raceNumber - b.raceNumber)
    .map((r) => `R${r.raceNumber}:`);
}

function expectedLastLineFragment(data) {
  const races = [...data.races].sort((a, b) => a.raceNumber - b.raceNumber);
  const lastRace = races[races.length - 1];
  const horses = [...lastRace.horses].sort(
    (a, b) => parseInt(a.postPosition, 10) - parseInt(b.postPosition, 10)
  );
  const h = horses[horses.length - 1];
  const scrSuffix = h.scratched ? ' (SCR)' : '';
  return `${h.name}${scrSuffix}`;
}

async function verifyUpload(drive, fileId, data) {
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' }
  );
  const text = typeof res.data === 'string' ? res.data : String(res.data);

  const missing = expectedRaceHeaders(data).filter((h) => !text.includes(h));
  if (missing.length > 0) {
    throw new Error(`verification failed: missing race header(s) ${missing.join(', ')}`);
  }

  const lastFragment = expectedLastLineFragment(data);
  if (!text.includes(lastFragment)) {
    throw new Error(`verification failed: last horse "${lastFragment}" not found in uploaded doc`);
  }

  return true;
}

async function processTrack(drive, track, isoDate) {
  const data = await fetchEntries(track.id, isoDate);

  if (!data.races || data.races.length === 0) {
    return { track: track.display, status: 'skipped', reason: 'no races drawn yet' };
  }

  const title = `${track.display} Entries — ${isoDate}`;
  const existing = await findExisting(drive, title);
  if (existing) {
    return { track: track.display, status: 'skipped', reason: 'already exists' };
  }

  const html = buildEntriesHtml(track.display, isoDate, data);
  const uploaded = await uploadEntriesDoc(drive, title, html);
  await verifyUpload(drive, uploaded.id, data);

  return {
    track: track.display,
    status: 'created',
    link: uploaded.webViewLink || `https://docs.google.com/document/d/${uploaded.id}/edit`,
  };
}

async function main() {
  const isoDate = todayIso();
  log(`run start, date=${isoDate}`);

  let drive;
  try {
    drive = driveClient();
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const track of TRACKS) {
    try {
      const result = await processTrack(drive, track, isoDate);
      results.push(result);
      if (result.status === 'created') {
        log(`${result.track}: CREATED ${result.link}`);
      } else {
        log(`${result.track}: skipped (${result.reason})`);
      }
    } catch (err) {
      results.push({ track: track.display, status: 'error', error: err.message });
      log(`${track.display}: ERROR ${err.message}`);
      process.exitCode = 1;
    }
  }

  log(`run end`);
}

main();
