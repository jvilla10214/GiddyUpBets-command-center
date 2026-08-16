// Cloudflare Worker: Stable Tour shared data + auto-import feed + weather log
// -----------------------------------------------------------------------
// Six jobs in one Worker:
//
// 1. Shared storage (GET/POST/DELETE /data, /trainers, /notes) — a KV-backed
//    trainer/notes store so every visitor's browser reads and writes the
//    SAME data instead of each device keeping its own separate localStorage
//    copy. Reads are open to anyone with the URL; writes require the
//    X-Stable-Key header to match WRITE_PASSPHRASE below — not real auth
//    (the passphrase ships in client-side JS, so anyone motivated enough to
//    view-source can find it), just a deterrent against someone stumbling
//    on the URL and vandalizing the shared list.
//
// 2. Auto-import feed (GET /, unchanged from before) — fetches
//    thisishorseracing.com's dedicated Stable Tour category feed, keeps
//    only the pieces that profile a single trainer (skips "Stable Tour
//    Rewind" roundups, which cover multiple days/events, not one barn),
//    fetches each qualifying article's full page, and extracts a
//    horse-by-horse note list from it. The dashboard polls this instead of
//    thisishorseracing.com directly, since that site has no CORS headers
//    and the free public CORS proxies tested against it were unreliable
//    (500s, gateway timeouts).
//
// 3. Shared Daily Weather Log (GET/POST/DELETE /weatherlog, plus /bulk and
//    /bulk-upsert variants, one KV key per track) — same "everyone sees the
//    same data" idea as job #1, but deliberately with NO passphrase gate.
//    Every entry is a deterministic computation from Open-Meteo data (auto-
//    logged, "Log Now"/"+ Add to Log", or NYRA-enriched by job #4's
//    backfill), not free-text anyone could vandalize with junk content, so
//    the write-friction that makes sense for Stable Tour's notes isn't
//    worth the setup step here — this is meant to Just Work for every
//    visitor with zero configuration.
//
// 4. NYRA Track Trends scrape (GET /nyra-trends?track=saratoga) — fetches
//    NYRA's own official Saratoga track-trends page (Andy Serling's daily
//    bias analysis) and parses each day into structured fields. Same CORS
//    problem as job #2 (nyra.com sets no Access-Control-Allow-Origin), same
//    fix. Only Saratoga is wired up — that's the only track-trends URL NYRA
//    publishes at this path. The client does the bias-category inference
//    and Bias Tracker upsert; this endpoint only returns the raw parsed
//    fields, same division of labor as job #2 (worker extracts structure,
//    client interprets it). Two client-side consumers: the Bias Tracker
//    auto-import (job #5), and the Daily Log backfill (job #3) — NYRA only
//    publishes trends for days it actually raced, so the backfill uses this
//    for racing days and falls back to its own Open-Meteo archive
//    computation for the non-racing days NYRA has no entry for.
//
// 5. Shared Bias Tracker (GET/POST/DELETE /biaslog, one KV key per track) —
//    same shape as job #3 (weatherlog), also deliberately open with no
//    passphrase gate. This one DOES carry free-text a visitor could
//    vandalize with junk (unlike weatherlog, which is pure computed
//    numbers) — that's a real, accepted tradeoff, not an oversight: gating
//    writes behind Stable Tour's passphrase would also block every ordinary
//    visitor from saving their own manual bias read, since that passphrase
//    is a team-internal secret, not something a random visitor is expected
//    to have. Manual entries have always been freely editable by anyone
//    (previously just stuck in their own browser, unseen by others); making
//    that shared keeps the same openness it already had rather than adding
//    new friction. The NYRA Track Trends auto-import (job #4) also writes
//    through this same open endpoint — see autoImportNyraTrends() client-side
//    for how it protects manual entries from being overwritten by a re-scrape.
//
// 6. NYRA Entries / morning-line odds (GET /nyra-entries?track=saratoga&
//    date=YYYY-MM-DD) — fetches every carded race for the given day from
//    NYRA's own entries page and returns each horse's post position, jockey,
//    trainer, weight, scratch status, current odds, and morning-line odds.
//    Same CORS problem and fix as jobs #2/#4, and same Saratoga-only scope
//    as job #4 (the only NYRA entries URL this app has verified). Read-only,
//    no storage — the client fetches this fresh per page load rather than
//    caching it in KV, since odds and scratches change throughout race day.
//
// Deploy: paste into the dashboard's Workers editor -> Deploy. Requires a KV
// namespace bound as STABLE_KV (Worker settings -> Bindings -> KV Namespace)
// for jobs #1, #3, and #5 to work — jobs #2, #4, and #6 (fetch-and-parse
// only, no storage) work without it.
// -----------------------------------------------------------------------

const FEED_URL = "https://thisishorseracing.com/category/fasig-tipton-stable-tour/feed/";
const NYRA_TRENDS_URL = "https://www.nyra.com/saratoga/racing/track-trends/";
// Lock this to the dashboard's real origin once it has one; "*" is fine
// while testing but defeats the point of CORS as an access control.
const ALLOWED_ORIGIN = "*";
const MAX_ARTICLES_PER_RUN = 8; // caps subrequests/runtime per poll
// A UA that identifies itself as a bot gets a flat 403 from this site's WAF
// on individual article pages (confirmed directly: identical request,
// bot-labeled UA -> 403, a real browser's UA -> 200) — the feed endpoint
// itself didn't seem to care, but using a real UA everywhere here anyway
// rather than relying on that being a permanent distinction.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const WRITE_PASSPHRASE = "giddyup";

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Surface the real failure as JSON instead of Cloudflare's opaque
      // "error code: 1101" page, which gives no clue what actually broke.
      return json({ error: `Unhandled: ${err.message}`, stack: String(err.stack || "").slice(0, 500) }, 500);
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/data" && request.method === "GET") {
      const state = await readState(env);
      return json(state, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/trainers" && request.method === "POST") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return json({ error: "Missing name" }, 400);
      const state = await readState(env);
      const exists = state.trainers.some(t => t.toLowerCase() === name.toLowerCase());
      if (!exists) state.trainers.push(name);
      // Always re-sort and re-save, even on a duplicate — lets re-posting an
      // already-added name (harmless no-op otherwise) double as a one-time
      // way to re-sort the whole existing list after this ordering changed.
      state.trainers.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)) || a.localeCompare(b));
      await env.STABLE_KV.put("trainers", JSON.stringify(state.trainers));
      return json({ trainers: state.trainers }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/trainers/bulk" && request.method === "POST") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const names = Array.isArray(body.names) ? body.names.map(n => (n || "").trim()).filter(Boolean) : [];
      if (!names.length) return json({ error: "Missing names" }, 400);
      const state = await readState(env);
      // One KV write for the whole batch instead of one per name — KV write
      // quota is a hard daily cap (free tier: 1,000/day, account-wide), and
      // a 100-name bulk-add used to cost 100+ writes on its own.
      for (const name of names) {
        const exists = state.trainers.some(t => t.toLowerCase() === name.toLowerCase());
        if (!exists) state.trainers.push(name);
      }
      state.trainers.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)) || a.localeCompare(b));
      await env.STABLE_KV.put("trainers", JSON.stringify(state.trainers));
      return json({ trainers: state.trainers }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/trainers" && request.method === "DELETE") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const name = body.name;
      const state = await readState(env);
      const trainers = state.trainers.filter(t => t !== name);
      const notes = state.notes.filter(n => n.trainer !== name); // cascade — no orphaned notes for a removed trainer
      await env.STABLE_KV.put("trainers", JSON.stringify(trainers));
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      return json({ trainers, notes }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes" && request.method === "POST") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.trainer || !body.horse || !body.note) return json({ error: "Missing required fields" }, 400);
      const state = await readState(env);
      // Multiple devices independently auto-importing the same article would
      // otherwise each file a duplicate note — dedupe on (trainer, horse,
      // link) when a link is present, which auto-imported notes always have.
      if (body.link) {
        const dup = state.notes.find(n => n.trainer === body.trainer && n.horse === body.horse && n.link === body.link);
        if (dup) return json({ note: dup, duplicate: true }, 200, { "Cache-Control": "no-store" });
      }
      const note = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        trainer: body.trainer,
        horse: body.horse,
        note: body.note,
        date: body.date || "",
        source: body.source || "",
        link: body.link || "",
        autoImported: !!body.autoImported,
        capturedAt: new Date().toISOString(),
      };
      state.notes.push(note);
      await env.STABLE_KV.put("notes", JSON.stringify(state.notes));
      return json({ note }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes/bulk" && request.method === "POST") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const items = Array.isArray(body.notes) ? body.notes : [];
      if (!items.length) return json({ error: "Missing notes" }, 400);
      const state = await readState(env);
      const results = [];
      for (const item of items) {
        if (!item.trainer || !item.horse || !item.note) continue;
        if (item.link) {
          const dup = state.notes.find(n => n.trainer === item.trainer && n.horse === item.horse && n.link === item.link);
          if (dup) { results.push({ note: dup, duplicate: true }); continue; }
        }
        const note = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          trainer: item.trainer,
          horse: item.horse,
          note: item.note,
          date: item.date || "",
          source: item.source || "",
          link: item.link || "",
          autoImported: !!item.autoImported,
          capturedAt: new Date().toISOString(),
        };
        state.notes.push(note);
        results.push({ note });
      }
      await env.STABLE_KV.put("notes", JSON.stringify(state.notes)); // one write for the whole batch
      return json({ results }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes" && request.method === "DELETE") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const state = await readState(env);
      const notes = state.notes.filter(n => n.id !== body.id);
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      return json({ notes }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/weatherlog" && request.method === "GET") {
      const track = (url.searchParams.get("track") || "").trim();
      if (!track) return json({ error: "Missing track" }, 400);
      const entries = await readWeatherLog(env, track);
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/weatherlog" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const entry = body.entry;
      if (!track || !entry || !entry.date) return json({ error: "Missing track or entry" }, 400);
      const entries = await readWeatherLog(env, track);
      const filtered = entries.filter(e => e.date !== entry.date);
      filtered.push(entry);
      filtered.sort((a, b) => b.date.localeCompare(a.date));
      await env.STABLE_KV.put(weatherLogKvKey(track), JSON.stringify(filtered));
      return json({ entries: filtered }, 200, { "Cache-Control": "no-store" });
    }

    // One KV write for the whole batch — used only for the one-time,
    // per-browser migration of pre-existing local-only log history into the
    // shared store (see loadWeatherLog() client-side). Existing dated
    // entries win over incoming ones so this can never clobber a value
    // another device already wrote for that date.
    if (url.pathname === "/weatherlog/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const items = Array.isArray(body.entries) ? body.entries : [];
      if (!track || !items.length) return json({ error: "Missing track or entries" }, 400);
      const entries = await readWeatherLog(env, track);
      for (const item of items) {
        if (!item?.date) continue;
        if (!entries.some(e => e.date === item.date)) entries.push(item);
      }
      entries.sort((a, b) => b.date.localeCompare(a.date));
      await env.STABLE_KV.put(weatherLogKvKey(track), JSON.stringify(entries));
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    // Distinct from /weatherlog/bulk above (which only inserts, existing
    // dates always win — that one is safety-first, built for a one-time
    // local->shared migration). This one overwrites by date, same "replace
    // or append" semantics as /biaslog/bulk — used to backfill/enrich Daily
    // Log history with NYRA Track Trends condition data, which needs to be
    // able to update a date that already has a Command-Center-only entry.
    if (url.pathname === "/weatherlog/bulk-upsert" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const items = Array.isArray(body.entries) ? body.entries : [];
      if (!track || !items.length) return json({ error: "Missing track or entries" }, 400);
      const entries = await readWeatherLog(env, track);
      for (const item of items) {
        if (!item?.date) continue;
        const idx = entries.findIndex(e => e.date === item.date);
        if (idx === -1) entries.push(item);
        else entries[idx] = item;
      }
      entries.sort((a, b) => b.date.localeCompare(a.date));
      await env.STABLE_KV.put(weatherLogKvKey(track), JSON.stringify(entries)); // one write for the whole batch
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/weatherlog" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date;
      if (!track || !date) return json({ error: "Missing track or date" }, 400);
      const entries = (await readWeatherLog(env, track)).filter(e => e.date !== date);
      await env.STABLE_KV.put(weatherLogKvKey(track), JSON.stringify(entries));
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/biaslog" && request.method === "GET") {
      const track = (url.searchParams.get("track") || "").trim();
      if (!track) return json({ error: "Missing track" }, 400);
      const entries = await readBiasLog(env, track);
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/biaslog" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const entry = body.entry;
      if (!track || !entry || !entry.date) return json({ error: "Missing track or entry" }, 400);
      const entries = await readBiasLog(env, track);
      const filtered = entries.filter(e => e.date !== entry.date);
      filtered.push(entry);
      filtered.sort((a, b) => b.date.localeCompare(a.date));
      await env.STABLE_KV.put(biasLogKvKey(track), JSON.stringify(filtered));
      return json({ entries: filtered }, 200, { "Cache-Control": "no-store" });
    }

    // Unconditional per-item upsert (overwrite by date), unlike weatherlog's
    // bulk route — used both for the one-time local-history migration (seeding
    // an empty store, where "overwrite" and "insert if missing" are the same
    // thing) and for autoImportNyraTrends()'s batched re-scrape updates,
    // which already decided client-side exactly which dates are safe to
    // touch (see its own comment on never overwriting a manual entry).
    if (url.pathname === "/biaslog/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const items = Array.isArray(body.entries) ? body.entries : [];
      if (!track || !items.length) return json({ error: "Missing track or entries" }, 400);
      const entries = await readBiasLog(env, track);
      for (const item of items) {
        if (!item?.date) continue;
        const idx = entries.findIndex(e => e.date === item.date);
        if (idx === -1) entries.push(item);
        else entries[idx] = item;
      }
      entries.sort((a, b) => b.date.localeCompare(a.date));
      await env.STABLE_KV.put(biasLogKvKey(track), JSON.stringify(entries)); // one write for the whole batch
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/biaslog" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date;
      if (!track || !date) return json({ error: "Missing track or date" }, 400);
      const entries = (await readBiasLog(env, track)).filter(e => e.date !== date);
      await env.STABLE_KV.put(biasLogKvKey(track), JSON.stringify(entries));
      return json({ entries }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/nyra-trends" && request.method === "GET") {
      const track = url.searchParams.get("track") || "saratoga";
      if (track !== "saratoga") return json({ error: "Not supported for this track" }, 400);
      let trendsRes;
      try {
        trendsRes = await fetch(NYRA_TRENDS_URL, {
          headers: { "User-Agent": BROWSER_UA },
          cf: { cacheTtl: 3600, cacheEverything: true }, // updates once/day at most
        });
      } catch (err) {
        return json({ error: `NYRA fetch failed: ${err.message}` }, 502);
      }
      if (!trendsRes.ok) return json({ error: `NYRA returned HTTP ${trendsRes.status}` }, 502);
      const html = await trendsRes.text();
      const entries = parseNyraTrackTrends(html);
      return json({ entries }, 200, { "Cache-Control": "public, max-age=3600" });
    }

    if (url.pathname === "/nyra-entries" && request.method === "GET") {
      const track = url.searchParams.get("track") || "saratoga";
      const date = url.searchParams.get("date") || "";
      if (!NYRA_ENTRIES_BASE[track]) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);
      let result;
      try {
        result = await fetchNyraEntriesDay(track, date);
      } catch (err) {
        return json({ error: `NYRA entries fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=120" });
    }

    // Falls through to the original feed-scrape behavior for GET / (and any
    // other unmatched path) — unchanged from before this shared-storage work.
    let feedRes;
    try {
      feedRes = await fetch(FEED_URL, { headers: { "User-Agent": BROWSER_UA }, cf: { cacheTtl: 900, cacheEverything: true } });
    } catch (err) {
      return json({ error: `Feed fetch failed: ${err.message}` }, 502);
    }
    if (!feedRes.ok) {
      return json({ error: `Feed returned HTTP ${feedRes.status}` }, 502);
    }

    const feedXml = await feedRes.text();
    const items = parseFeedItems(feedXml).slice(0, MAX_ARTICLES_PER_RUN);

    const articles = [];
    for (const item of items) {
      const trainer = trainerFromTitle(item.title);
      if (!trainer) continue; // "Stable Tour Rewind" or an unrecognized title format — not a single-trainer piece

      let articleRes;
      try {
        articleRes = await fetch(item.link, {
          headers: { "User-Agent": BROWSER_UA },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
      } catch (err) {
        continue; // skip this one article, don't fail the whole batch
      }
      if (!articleRes.ok) continue;

      const horses = await extractHorseChunks(articleRes);
      articles.push({
        guid: item.guid || item.link,
        title: item.title,
        trainer,
        link: item.link,
        pubDate: item.pubDate,
        horses,
      });
    }

    return json({
      source: FEED_URL,
      fetchedAt: new Date().toISOString(),
      articles,
    }, 200, { "Cache-Control": "public, max-age=900" }); // 15 min — this content updates infrequently
}

function isAuthorized(request) {
  return request.headers.get("X-Stable-Key") === WRITE_PASSPHRASE;
}

// Trainers sort by last name — the last whitespace-separated token, which
// holds even for hyphenated last names ("Ramirez-Rodriguez" stays one
// token) and names with an unstripped leading initial ("W. Bret Calhoun"
// -> "Calhoun").
function lastNameKey(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

// Track IDs come straight from the client's fixed TRACKS registry (7 known
// values today) but this strips anything unexpected anyway before it ever
// touches a KV key, just in case that registry grows in an unexpected way.
function weatherLogKvKey(track) {
  return `weatherlog:${track.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}`;
}

async function readWeatherLog(env, track) {
  const raw = await env.STABLE_KV.get(weatherLogKvKey(track));
  const parsed = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [];
}

function biasLogKvKey(track) {
  return `biaslog:${track.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}`;
}

async function readBiasLog(env, track) {
  const raw = await env.STABLE_KV.get(biasLogKvKey(track));
  const parsed = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [];
}

async function readState(env) {
  const [trainersRaw, notesRaw] = await Promise.all([
    env.STABLE_KV.get("trainers"),
    env.STABLE_KV.get("notes"),
  ]);
  return {
    trainers: trainersRaw ? JSON.parse(trainersRaw) : [],
    notes: notesRaw ? JSON.parse(notesRaw) : [],
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Stable-Key",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

// Minimal regex-based RSS parser — this feed's shape is stable (WordPress
// core RSS2 output) and a full XML parser isn't available in the Workers
// runtime without a dependency, so this mirrors the same "good enough for a
// known, simple source" approach the rest of this app uses for its other
// free/keyless feeds.
function parseFeedItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const guid = extractTag(block, "guid");
    const pubDate = extractTag(block, "pubDate");
    if (title && link) items.push({ title, link, guid, pubDate });
  }
  return items;
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`));
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
}

// "Fasig-Tipton Stable Tour: Todd Pletcher" and "Fasig-Tipton Stable Tour
// with Brad Cox" are the two title conventions this site actually uses for
// single-trainer profiles (verified against real published examples of
// each). "Stable Tour Rewind: ..." pieces (multi-day roundups, not one
// barn) intentionally don't match either and get skipped.
function trainerFromTitle(title) {
  let m = title.match(/Stable Tour:\s*(.+)$/i);
  if (m) return m[1].trim();
  m = title.match(/Stable Tour with\s*(.+)$/i);
  if (m) return m[1].trim();
  return null;
}

// Same dual-pattern heuristic verified against three real articles from
// this site (two different authors, two different formatting conventions):
// some pieces lead each horse's paragraph with "Horse Name: ", others use a
// standalone <h2> heading with just the horse's name. Scoped to the
// <article> boundary so sidebar/related-post headings (which reuse the same
// heading markup) don't get swept in as false "horses".
async function extractHorseChunks(response) {
  const html = await response.text();
  const body = extractArticleBody(html);
  const paragraphs = htmlToPlainParagraphs(body);

  const HORSE_COLON = /^([A-Z][A-Za-z.'’\-\s]{1,40}):\s*([\s\S]*)$/;
  const chunks = [];
  let current = null;
  for (const p of paragraphs) {
    const m = p.match(HORSE_COLON);
    if (m && m[1].trim().split(/\s+/).length <= 5) {
      if (current) chunks.push(current);
      current = { horse: m[1].trim(), text: m[2].trim() };
      continue;
    }
    if (isShortName(p)) {
      if (current) chunks.push(current);
      current = { horse: p, text: "" };
      continue;
    }
    if (current) current.text += (current.text ? "\n\n" : "") + p;
  }
  if (current) chunks.push(current);
  return chunks.filter(c => c.text.length >= 10); // drop anything that didn't pick up real content
}

function extractArticleBody(html) {
  const idx = html.indexOf('class="entry-content"');
  if (idx === -1) return html;
  const start = html.indexOf(">", idx) + 1;
  const end = html.indexOf("</article>", start);
  return html.slice(start, end === -1 ? html.length : end);
}

function htmlToPlainParagraphs(html) {
  const out = [];
  const re = /<(h2 class="wp-block-heading"|p class="wp-block-paragraph")[^>]*>([\s\S]*?)<\/(?:h2|p)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (text) out.push(text);
  }
  return out;
}

function isShortName(s) {
  if (!/^[A-Z][A-Za-z.'’\-\s]{1,40}$/.test(s)) return false;
  if (s.split(/\s+/).length > 5) return false;
  if (/[.!?]$/.test(s)) return false;
  return true;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// ---------- NYRA Track Trends parser ----------
// This page's markup (verified directly, not guessed) is server-rendered,
// static HTML — a plain regex walk is reliable here the same way it is for
// the RSS feed above, no headless browser needed. Structure per year:
//   <h2>2026</h2>
//   <div class="mb-4">
//     <div class="font-bold mb-4"><h3 class="text-sm">Friday, August 14</h3></div>
//     <div>
//       <div class="row">
//         <div>Track Condition: ...</div>
//         <div>Weather: ...</div>
//         <div>Temperature: ...</div>
//         <div>Wind: ...</div>
//       </div>
//       <div class="mt-3"><div><p>analysis text...</p></div></div>
//     </div>
//   </div>
const NYRA_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseNyraTrackTrends(html) {
  const entries = [];
  // Split on year headings — yearParts alternates [preamble, year, section, year, section, ...]
  const yearParts = html.split(/<h2>(\d{4})<\/h2>/);
  for (let i = 1; i < yearParts.length; i += 2) {
    const year = yearParts[i];
    const section = yearParts[i + 1] || "";
    const dayChunks = section.split(/<h3 class="text-sm">/).slice(1);
    for (const chunk of dayChunks) {
      const dateMatch = chunk.match(/^([^<]+)<\/h3>/);
      if (!dateMatch) continue;
      const dateLabel = decodeEntities(dateMatch[1]).trim(); // "Friday, August 14"
      const rest = chunk.slice(dateMatch[0].length);

      const monthDayMatch = dateLabel.match(/,\s*([A-Za-z]+)\s+(\d{1,2})/);
      if (!monthDayMatch) continue;
      const month = NYRA_MONTHS[monthDayMatch[1].toLowerCase()];
      if (!month) continue;
      const day = parseInt(monthDayMatch[2], 10);
      const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      const field = (label) => {
        const m = rest.match(new RegExp(`${label}:\\s*([\\s\\S]*?)</div>`));
        if (!m) return "";
        return decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      };
      const trackCondition = field("Track Condition");
      const weather = field("Weather");
      const temperature = field("Temperature");
      const wind = field("Wind");

      const analysisMatch = rest.match(/<p>([\s\S]*?)<\/p>/);
      const analysis = analysisMatch
        ? decodeEntities(analysisMatch[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
        : "";

      if (trackCondition || analysis) {
        entries.push({ date: isoDate, dateLabel, trackCondition, weather, temperature, wind, analysis });
      }
    }
  }
  return entries;
}

// ---------- NYRA Entries / morning-line odds parser ----------
// Source verified directly (not guessed): nyra.com's entries page is a thin
// shell around an HTMX fragment endpoint, /<track>/rdl/race/?day=YYYY-MM-DD
// &race=N&limit=entries, that server-renders ONE race's full field (post,
// horse, jockey/trainer, weight, current odds, morning line) per request —
// the same "internal fragment over full page" preference already used for
// scratches. There's no single "whole day" fragment: each response embeds a
// nav strip listing every race number carded that day (1..N), so the client
// here fetches race=1 first, reads N off that nav, then fetches the rest in
// parallel. Only Saratoga is wired up, same scope as NYRA Track Trends above
// (the only NYRA entries URL this app has verified end-to-end).
const NYRA_ENTRIES_BASE = { saratoga: "https://www.nyra.com/saratoga" };

// Nav links HTML-encode their querystrings ("...&amp;race=3"), so this
// matches on "race=" alone rather than requiring a raw "&"/"?" just before it.
function maxRaceNumberFromNav(html) {
  const nums = Array.from(html.matchAll(/race=(\d+)"/g)).map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

function parseNyraRaceFragment(html) {
  const headerMatch = html.match(/font-heading">\s*Race\s*(\d+)\s*<\/header>/);
  if (!headerMatch) return null;
  const raceNumber = Number(headerMatch[1]);

  const mtpMatch = html.match(/data-post-time="([^"]+)"[^>]*data-mtp-variant="[^"]*"[^>]*aria-label="[^"]*">([^<]*)<\/span>/);
  const postTimeIso = mtpMatch ? mtpMatch[1] : null;
  const mtpLabel = mtpMatch ? decodeEntities(mtpMatch[2]).trim() : null;

  const purseMatch = html.match(/<section class="flex items-baseline gap-5">[\s\S]*?<div>\s*([\s\S]*?)\s*<\/div>\s*<\/section>/);
  let purse = null, raceType = null;
  if (purseMatch) {
    const lines = purseMatch[1].split("\n").map((s) => decodeEntities(s).trim()).filter(Boolean);
    purse = lines[0] || null;
    raceType = lines.slice(1).join(" ") || null;
  }

  const distMatch = html.match(/title="([^"]+)">([^<]+)<\/div>\s*<div class="text-zinc-800 dark:text-white">\s*([\s\S]*?)\s*<\/div>/);
  const distanceLabel = distMatch ? decodeEntities(distMatch[2]).trim() : null;
  const surface = distMatch ? decodeEntities(distMatch[3]).trim() : null;

  const horses = [];
  const horseRe = /<div class="order-3 flex-1 leading-none"><div class="font-semibold text-lg lg:text-2xl -mt-1 mb-1 leading-tight blend-links"><a href="[^"]*"[^>]*>\s*([^<]+?)\s*<\/a><\/div><div class="text-zinc-800 dark:text-white">([^<]*)<\/div><div class="text-zinc-800 dark:text-white mt-1 text-xs lg:text-sm">([^<]*)<\/div><\/div><div class="order-1[^"]*"><div class="[^"]*">\s*([^<]*?)\s*<\/div><\/div><div class="order-5[^"]*"><div class="[^"]*" title="Current Odds">([^<]*)<\/div><div class="[^"]*" title="Morning Line Odds">\s*ML\s*([^<]*)<\/div>/g;
  let m;
  while ((m = horseRe.exec(html))) {
    const [, nameRaw, jockeyTrainerRaw, weightRaw, postRaw, currentOddsRaw, mlOddsRaw] = m;
    const [jockeyRaw, trainerRaw] = jockeyTrainerRaw.split("&bull;");
    const [weightRawPart, medicationRaw, ageSexRaw] = weightRaw.split("&bull;");
    const currentOdds = decodeEntities(currentOddsRaw).trim();
    const scratched = currentOdds.toUpperCase() === "SCR";
    horses.push({
      postPosition: decodeEntities(postRaw).trim() || null,
      name: decodeEntities(nameRaw).trim(),
      jockey: jockeyRaw ? decodeEntities(jockeyRaw).trim() : null,
      trainer: trainerRaw ? decodeEntities(trainerRaw).trim() : null,
      weight: weightRawPart ? decodeEntities(weightRawPart).trim() : null,
      medication: medicationRaw ? decodeEntities(medicationRaw).trim() : null,
      ageSex: ageSexRaw ? decodeEntities(ageSexRaw).trim() : null,
      scratched,
      currentOdds: scratched ? null : (currentOdds || null),
      mlOdds: decodeEntities(mlOddsRaw).trim() || null,
    });
  }

  return { raceNumber, postTimeIso, mtpLabel, purse, raceType, distanceLabel, surface, horses };
}

async function fetchNyraEntriesDay(track, date) {
  const base = NYRA_ENTRIES_BASE[track];
  const fetchRace = async (n) => {
    const res = await fetch(`${base}/rdl/race/?day=${date}&limit=entries&race=${n}`, {
      headers: { "User-Agent": BROWSER_UA },
      cf: { cacheTtl: 120, cacheEverything: true },
    });
    if (!res.ok) return { html: null, race: null };
    const html = await res.text();
    return { html, race: parseNyraRaceFragment(html) };
  };

  const first = await fetchRace(1);
  const raceCount = first.html ? maxRaceNumberFromNav(first.html) : 1;
  const races = first.race ? [first.race] : [];

  if (raceCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: raceCount - 1 }, (_, i) => i + 2).map((n) => fetchRace(n).catch(() => ({ race: null })))
    );
    for (const { race } of rest) if (race) races.push(race);
  }
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { date, races };
}
