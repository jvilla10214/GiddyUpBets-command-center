// Cloudflare Worker: Stable Tour shared data + auto-import feed + weather log
// -----------------------------------------------------------------------
// Seven jobs in one Worker:
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
// 6. Entries / morning-line odds (GET /entries?track=<id>&date=YYYY-MM-DD)
//    — fetches every carded race for the given day from that track's own
//    entries page and returns each horse's post position, jockey, trainer,
//    weight, scratch status, current odds (where the source publishes it),
//    and morning-line odds (same, where published — see fetchMonmouth-
//    EntriesDay()'s comment for a source that currently doesn't). Same CORS
//    problem and fix as jobs #2/#4. One route, dispatched by
//    ENTRIES_SOURCE_BY_TRACK to a per-track parser — fetchNyraEntriesDay()
//    for NYRA tracks (Saratoga), fetchDmtcEntriesDay() for Del Mar,
//    fetchMonmouthEntriesDay() for Monmouth — since each track's site has
//    genuinely different markup. All three require the requested `date` to
//    match what the source currently has published, returning no races
//    otherwise — a non-race day reads as "no races today", never a preview
//    of some other day's card.
//    Only tracks in that map are supported; add one only after fetching and
//    verifying its actual markup (same rule as every scrape in this file).
//    Read-only, no storage — the client fetches this fresh per page load
//    rather than caching it in KV, since odds and scratches change
//    throughout race day.
//
// 7. TDN Saratoga Notebook (GET /tdn-notebook) — fetches TDN's dedicated
//    Saratoga Notebook tag feed and, for each article, splits it into
//    per-trainer sections with the horse names mentioned in each (see
//    fetchTdnNotebook()'s comment for how — this source covers multiple
//    trainers per article, unlike job #2's one-trainer-per-article shape).
//    Read-only, no storage, same reasoning as job #6. The client is the one
//    that checks a detected trainer against its own tracked list and files
//    notes — this endpoint never adds a new trainer on its own.
//
// 8. Rain Nowcast (GET /pirate-minutely?lat=<lat>&lon=<lon>) — proxies
//    Pirate Weather's minutely block (per-minute precipIntensity,
//    precipProbability, precipType for the next ~60 minutes; blends
//    short-range models with radar) using the PIRATE_WEATHER_API_KEY
//    secret, which never reaches the client. Thin proxy only — no
//    threshold/classification logic here, same "worker extracts, client
//    interprets" split as every other job. Read-only, no storage.
//
// 9. Live official track conditions (GET /track-conditions?track=<id>&date=
//    YYYY-MM-DD) — fetches NYRA's own live scratches/conditions page (a
//    different page than job #4: this is the live, same-day scratches/rail
//    page already iframed client-side for the "Track Conditions & Rail"
//    panel, not the after-the-fact Track Trends analysis page) and parses
//    its fixed Track:/Turf:/Inner:/Mellon:/Widener: labeled rows into structured
//    dirt condition, per-course turf condition, and rail-out-distance
//    fields. No AI/LLM involved — every field is a consistently labeled
//    table row (verified directly against both a live Saratoga raceday and
//    a Belmont sample), so a plain parser is reliable here the same way it
//    is for every other NYRA page this file scrapes. Same CORS problem and
//    fix as jobs #2/#4/#6.
//    The scratches page always reflects whichever day NYRA currently has
//    posted — once that rolls to the next day, the previous day's numbers
//    are gone from the live page. So every successful live parse is also
//    persisted to KV under its own parsed date, and a request for a date
//    that no longer matches the live page falls back to that KV snapshot —
//    this is what lets the Daily Log look up "yesterday's" official
//    conditions the morning after, once the live page has moved on.
//    Only Saratoga is wired up (NYRA_SCRATCHES_CODE_BY_TRACK) — same
//    verify-before-adding rule as every other track map in this file.
//
// 10. Del Mar post-position stats (GET /pp-stats?track=<id>) — fetches
//    DMTC's own "Winning Post Positions" page and parses its win-rate-by-
//    post tables (one per distance/surface combo — e.g. "5 Furlongs on
//    Dirt": post 1, 10 starts, 0 wins, 0%). Season-to-date for the current
//    meet, not a per-day read like job #4/#5 — DMTC doesn't publish a daily
//    narrative bias write-up the way NYRA does, so this is a genuinely
//    different shape of data (aggregate stats, not prose to classify) and
//    is surfaced as its own standalone panel rather than folded into Dirt
//    Bias/Turf Bias. Only Del Mar is wired up (DMTC_PP_STATS_URL_BY_TRACK).
//
// 11. Severe weather alerts (GET /nws-alerts?lat=<lat>&lon=<lon>) — proxies
//    api.weather.gov's active-alerts-by-point endpoint, filtered server-
//    side to exactly "Severe Thunderstorm Warning" and "Tornado Warning"
//    (not Watches, not any other alert type). Free, keyless, official
//    government source. This is the one job in this file that a browser
//    could never do directly even though the API itself is CORS-open —
//    NWS documents a descriptive User-Agent as required, and fetch() is
//    spec-forbidden from setting its own User-Agent header, so this has to
//    go through a server-side context. See NWS_USER_AGENT above.
//
// 12. Ascot live on-site weather (GET /ascot-conditions) — proxies
//    TurfTrax's WeatherTrax station feed for Ascot (its.turftrax.co.uk),
//    the same live data source Ascot's own official "The Going" page
//    (ascot.com/thegoing) embeds via iframe. Genuine on-site sensor
//    readings — temperature, humidity, wind speed/direction/gust, rain —
//    from equipment near the 4-furlong marker on the straight mile, not a
//    regional weather model, so it's the more accurate source for Ascot
//    specifically. The endpoint that actually serves this data rejects
//    requests without a matching Referer header ("Unlicensed Direct
//    Access") — TURFTRAX_REFERER below satisfies that. This job only
//    returns the parsed readings plus their own age in minutes; the
//    client decides whether they're fresh enough to use (same "worker
//    extracts, client interprets" split as every other job here), and
//    falls back to Open-Meteo for anything TurfTrax doesn't report at all
//    (forecast, AQI, soil moisture, etc.) Ascot only — the going/weather
//    report system covers other UK tracks too but only this one has been
//    fetched and verified.
//
// Deploy: paste into the dashboard's Workers editor -> Deploy. Requires a KV
// namespace bound as STABLE_KV (Worker settings -> Bindings -> KV Namespace)
// for jobs #1, #3, #5, and #9 to work — jobs #2, #4, #6, #7, #8, #10, #11,
// and #12 (fetch-and-parse only, no storage) work without it. Job #8
// additionally requires a PIRATE_WEATHER_API_KEY secret (Worker settings ->
// Variables and Secrets -> Add, type "Secret") — get a free key at
// pirateweather.net.
// -----------------------------------------------------------------------

const FEED_URL = "https://thisishorseracing.com/category/fasig-tipton-stable-tour/feed/";
// Per-track config, not a single hardcoded URL — adding another NYRA track
// later (e.g. Belmont, at nyra.com/belmont/racing/track-trends/) is one map
// entry, not a rebuild. Only Saratoga's URL is actually verified right now;
// don't add another track here until its markup has been checked too (same
// rule as every other scrape in this file).
const NYRA_TRENDS_URL_BY_TRACK = { saratoga: "https://www.nyra.com/saratoga/racing/track-trends/" };
// Same one-entry-per-verified-track rule as NYRA_TRENDS_URL_BY_TRACK above.
// Belmont's file exists at this same path (BELscratch.html) — added now
// even though it was a frozen 2023 snapshot when last checked, since that
// turns out to be useful rather than a blocker: its cardDate will never
// match today's date while it's off-season, which is exactly the signal
// the client uses to show "not racing today" instead of a stale or
// misleadingly-official read. Once Belmont's meet is actually live, the
// same endpoint starts returning real same-day data automatically.
const NYRA_SCRATCHES_CODE_BY_TRACK = { saratoga: "SAR", belmont: "BEL" };
// Job #10 — same one-entry-per-verified-track rule as every other map here.
const DMTC_PP_STATS_URL_BY_TRACK = { delmar: "https://www.dmtc.com/handicapping/pp-stats" };
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
// api.weather.gov documents a descriptive User-Agent (app name + contact) as
// required, not optional — and this is the one call in this file a browser
// could never make directly, since fetch() is spec-forbidden from setting
// its own User-Agent header. That's the actual reason job #11 goes through
// this Worker at all, not just convention.
const NWS_USER_AGENT = "GiddyUpBetsCommandCenter/1.0 (https://jvilla10214.github.io/GiddyUpBets-command-center/; contact: jvilla10214@gmail.com)";
const WRITE_PASSPHRASE = "giddyup";

// Job #12 — the visualiser page itself fetches this same URL client-side on
// a timer; the Referer is what its "Unlicensed Direct Access" check is
// actually gating on (confirmed directly: identical request with vs.
// without this header is the difference between a rejection payload and
// real data), not IP or User-Agent.
const TURFTRAX_STREAM_URL = "https://its.turftrax.co.uk/visualiser/stream/ascot.html";
const TURFTRAX_REFERER = "https://its.turftrax.co.uk/visualiser/ascot/";

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

    if (url.pathname === "/tdn-notebook" && request.method === "GET") {
      let result;
      try {
        result = await fetchTdnNotebook();
      } catch (err) {
        return json({ error: `TDN Notebook fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=900" });
    }

    if (url.pathname === "/pirate-minutely" && request.method === "GET") {
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      if (!lat || !lon) return json({ error: "Missing lat/lon" }, 400);
      if (!env.PIRATE_WEATHER_API_KEY) return json({ error: "Pirate Weather API key not configured" }, 500);
      const apiUrl = `https://api.pirateweather.net/forecast/${env.PIRATE_WEATHER_API_KEY}/${lat},${lon}` +
        `?exclude=currently,hourly,daily,alerts,flags&units=us`;
      let pwRes;
      try {
        pwRes = await fetch(apiUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
      } catch (err) {
        return json({ error: `Pirate Weather fetch failed: ${err.message}` }, 502);
      }
      if (!pwRes.ok) return json({ error: `Pirate Weather returned HTTP ${pwRes.status}` }, 502);
      const pwData = await pwRes.json();
      const minutely = (pwData.minutely?.data || []).map((m) => ({
        time: m.time,
        precipIntensity: m.precipIntensity ?? 0,
        precipProbability: m.precipProbability ?? 0,
        precipType: m.precipType || "none",
      }));
      return json({ generatedAt: new Date().toISOString(), minutely }, 200, { "Cache-Control": "public, max-age=60" });
    }

    if (url.pathname === "/nyra-trends" && request.method === "GET") {
      const track = url.searchParams.get("track") || "saratoga";
      const trendsUrl = NYRA_TRENDS_URL_BY_TRACK[track];
      if (!trendsUrl) return json({ error: "Not supported for this track" }, 400);
      let trendsRes;
      try {
        trendsRes = await fetch(trendsUrl, {
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

    if (url.pathname === "/track-conditions" && request.method === "GET") {
      const track = url.searchParams.get("track") || "";
      const date = url.searchParams.get("date") || "";
      const code = NYRA_SCRATCHES_CODE_BY_TRACK[track];
      if (!code) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);

      let parsed = { available: false };
      try {
        const res = await fetch(`https://tr-cdn.nyra.com/direct/scratches/${code}scratch.html`, {
          headers: { "User-Agent": BROWSER_UA },
          cf: { cacheTtl: 300, cacheEverything: true }, // this source's own cache-control is only 30s, but sub-5-minute freshness isn't needed
        });
        if (res.ok) parsed = parseNyraTrackConditions(await res.text());
      } catch (err) {
        // treat as unavailable — falls through to the KV lookup below
      }

      if (parsed.available && parsed.cardDate) {
        // Persist so this date's conditions survive past the live page
        // rolling over to the next day's card — see job #9's comment.
        try {
          await env.STABLE_KV.put(trackConditionsKvKey(track, parsed.cardDate), JSON.stringify(parsed));
        } catch (err) {
          // best-effort — don't fail the request over a cache write
        }
      }

      if (parsed.available && parsed.cardDate === date) {
        return json({ ...parsed, source: "live" }, 200, { "Cache-Control": "public, max-age=60" });
      }

      const cached = env.STABLE_KV ? await env.STABLE_KV.get(trackConditionsKvKey(track, date)) : null;
      if (cached) return json({ ...JSON.parse(cached), source: "cached" }, 200, { "Cache-Control": "public, max-age=300" });

      return json({ available: false }, 200, { "Cache-Control": "public, max-age=60" });
    }

    if (url.pathname === "/entries" && request.method === "GET") {
      const track = url.searchParams.get("track") || "";
      const date = url.searchParams.get("date") || "";
      const source = ENTRIES_SOURCE_BY_TRACK[track];
      if (!source) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);
      let result;
      try {
        if (source === "nyra") result = await fetchNyraEntriesDay(track, date);
        else if (source === "dmtc") result = await fetchDmtcEntriesDay(date);
        else result = await fetchMonmouthEntriesDay(date);
      } catch (err) {
        return json({ error: `Entries fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=120" });
    }

    if (url.pathname === "/results" && request.method === "GET") {
      const track = url.searchParams.get("track") || "";
      const date = url.searchParams.get("date") || "";
      if (!NYRA_ENTRIES_BASE[track]) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);
      let result;
      try {
        result = await fetchNyraResultsDay(track, date);
      } catch (err) {
        return json({ error: `Results fetch failed: ${err.message}` }, 502);
      }
      // Short cache — a race can go from not-yet-final to final at any
      // moment during a card, unlike entries/odds which only drift slowly.
      return json(result, 200, { "Cache-Control": "public, max-age=90" });
    }

    if (url.pathname === "/pp-stats" && request.method === "GET") {
      const track = url.searchParams.get("track") || "";
      const pageUrl = DMTC_PP_STATS_URL_BY_TRACK[track];
      if (!pageUrl) return json({ error: "Not supported for this track" }, 400);
      let res;
      try {
        res = await fetch(pageUrl, {
          headers: { "User-Agent": BROWSER_UA },
          cf: { cacheTtl: 3600, cacheEverything: true }, // this page updates infrequently — season-to-date stats, not a daily read
        });
      } catch (err) {
        return json({ error: `DMTC fetch failed: ${err.message}` }, 502);
      }
      if (!res.ok) return json({ error: `DMTC returned HTTP ${res.status}` }, 502);
      const html = await res.text();
      const result = parseDmtcPostPositionStats(html);
      return json(result, 200, { "Cache-Control": "public, max-age=3600" });
    }

    if (url.pathname === "/nws-alerts" && request.method === "GET") {
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      if (!lat || !lon) return json({ error: "Missing lat/lon" }, 400);
      let res;
      try {
        res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
          headers: { "User-Agent": NWS_USER_AGENT, "Accept": "application/geo+json" },
          cf: { cacheTtl: 60, cacheEverything: true },
        });
      } catch (err) {
        return json({ error: `NWS fetch failed: ${err.message}` }, 502);
      }
      if (!res.ok) return json({ error: `NWS returned HTTP ${res.status}` }, 502);
      const data = await res.json();
      const alerts = (data.features || [])
        .map((f) => f.properties)
        .filter((p) => p?.event === "Severe Thunderstorm Warning" || p?.event === "Tornado Warning")
        .map((p) => ({
          id: p.id, event: p.event, headline: p.headline, severity: p.severity,
          effective: p.effective, expires: p.expires, areaDesc: p.areaDesc,
        }));
      return json({ alerts }, 200, { "Cache-Control": "public, max-age=60" });
    }

    if (url.pathname === "/ascot-conditions" && request.method === "GET") {
      let res;
      try {
        res = await fetch(TURFTRAX_STREAM_URL, {
          headers: { "User-Agent": BROWSER_UA, "Referer": TURFTRAX_REFERER, "Accept": "application/json" },
          cf: { cacheTtl: 120, cacheEverything: true },
        });
      } catch (err) {
        return json({ error: `TurfTrax fetch failed: ${err.message}` }, 502);
      }
      if (!res.ok) return json({ error: `TurfTrax returned HTTP ${res.status}` }, 502);
      let raw;
      try {
        raw = await res.json();
      } catch (err) {
        return json({ error: `TurfTrax response wasn't valid JSON: ${err.message}` }, 502);
      }
      if (raw.status !== 0 || !raw.payload?.content) {
        return json({ error: `TurfTrax rejected the request: ${raw.payload ?? "unknown"}` }, 502);
      }
      return json(parseTurftraxConditions(raw.payload), 200, { "Cache-Control": "public, max-age=120" });
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

function trackConditionsKvKey(track, date) {
  const safeTrack = track.replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "invalid";
  return `trackconditions:${safeTrack}:${safeDate}`;
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

// TurfTrax's "weather-date"/"weather-last-update" strings ("19/08/26",
// "6:08pm") are already Europe/London local time — the station sits at
// Ascot. Comparing them against "now" computed in the same zone lets us
// get an accurate age in minutes without ever needing to know the actual
// UTC offset (GMT vs BST) — both timestamps get treated as if they were
// UTC and subtracted, which is valid as long as they're the same
// wall-clock zone, true here by construction.
function parseTurftraxLocalParts(dateStr, timeStr) {
  const dm = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dateStr || "");
  const tm = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(timeStr || "");
  if (!dm || !tm) return null;
  let hour = parseInt(tm[1], 10);
  const isPm = tm[3].toLowerCase() === "pm";
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return {
    year: 2000 + parseInt(dm[3], 10), month: parseInt(dm[2], 10), day: parseInt(dm[1], 10),
    hour, minute: parseInt(tm[2], 10),
  };
}

function londonNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

function minutesBetweenLocalParts(earlier, later) {
  const a = Date.UTC(earlier.year, earlier.month - 1, earlier.day, earlier.hour, earlier.minute);
  const b = Date.UTC(later.year, later.month - 1, later.day, later.hour, later.minute);
  return Math.round((b - a) / 60000);
}

const mmToInches = (mm) => (typeof mm === "number" ? mm / 25.4 : null);
const cToF = (c) => (typeof c === "number" ? (c * 9) / 5 + 32 : null);

// Maps TurfTrax's WDV API Stream payload (see job #12's comment) to the
// subset of fields the client actually overlays onto Open-Meteo's current
// conditions. Deliberately excludes anything Open-Meteo already covers at
// least as well (forecast, AQI, soil moisture) and anything not confirmed
// stable across visits (the payload also carries a raw debug "trace" field
// with SQL and internal state — not returned here, only the structured
// "content" block is).
function parseTurftraxConditions(payload) {
  const c = payload.content || {};
  const readingParts = parseTurftraxLocalParts(c["weather-date"], c["weather-last-update"]);
  const ageMinutes = readingParts ? minutesBetweenLocalParts(readingParts, londonNowParts()) : null;
  return {
    ageMinutes,
    stationActivityStatus: c.stationActivityStatus ?? null,
    lastUpdateLabel: c["weather-last-update"] ?? null,
    temperatureF: cToF(c["temperature-current"]),
    humidityPct: typeof c["humidity-current"] === "number" ? c["humidity-current"] : null,
    windSpeedMph: typeof c["windspeed-current"] === "number" ? c["windspeed-current"] : null,
    windGustMph: typeof c["windgust-current"] === "number" ? c["windgust-current"] : null,
    windDirectionDeg: typeof c["winddirection-current"] === "number" ? c["winddirection-current"] : null,
    windDirectionText: c["winddirection-text"] ?? null,
    rainSinceMidnightIn: mmToInches(c["rain1-since"]),
    rain24hIn: mmToInches(c["rain1-24hr"]),
    rain7dIn: mmToInches(c["rain1-7day"]),
    trackType: c.trackType ?? null,
    goingRaceDate: c["going-race-date"] ?? null,
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

// ---------- NYRA live track conditions parser (job #9) ----------
// Source verified directly: tr-cdn.nyra.com/direct/scratches/<CODE>scratch.html
// is the same page already iframed by the client for the "Track Conditions &
// Rail" panel — plain server-rendered HTML, not JS-rendered. Before that
// day's card has posted (or on a dark day) it just says "SCRATCHES AND
// PROGRAM CHANGES ARE CURRENTLY NOT AVAILABLE" with no conditions table at
// all; this returns available:false rather than guessing at anything. Every
// real field (Track:/Turf:/Inner:/Mellon:/Widener:) is a fixed labeled table
// row — verified against both a live Saratoga raceday and a Belmont sample —
// so a plain regex walk is reliable here the same way it is for the other
// NYRA pages this file parses; deliberately not an LLM call for a page this
// structurally consistent.
function cleanCell(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseNyraTrackConditions(html) {
  if (/CURRENTLY NOT AVAILABLE/i.test(html)) {
    return { available: false };
  }

  const dateMatch = html.match(/SCRATCHES AND PROGRAM CHANGES FOR ([^<]+)</i);
  const cardDateLabel = dateMatch ? cleanCell(dateMatch[1]) : null;
  // "TUESDAY, 8/18/2026" -> "2026-08-18"
  const mdY = cardDateLabel?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const cardDate = mdY ? `${mdY[3]}-${mdY[1].padStart(2, "0")}-${mdY[2].padStart(2, "0")}` : null;

  const updatedMatch = html.match(/Last Updated:\s*([^<]+)</i);
  const lastUpdatedLabel = updatedMatch ? cleanCell(updatedMatch[1]) : null;

  // Every row is "<td><b><font>LABEL:</font></b></td><td><font>VALUE</font></td>"
  // — the colon is immediately followed by a closing tag only for the actual
  // labeled row (not for course names mentioned inline inside another row's
  // value, e.g. "Widener:&nbsp;FIRM" inside the Turf: row's own value cell,
  // where the colon is followed by "&nbsp;" instead of a tag).
  const field = (label) => {
    const labelIdx = html.search(new RegExp(`>${label}:<`, "i"));
    if (labelIdx === -1) return null;
    const afterLabel = html.slice(labelIdx);
    const valueTdMatch = afterLabel.match(/<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    return valueTdMatch ? cleanCell(valueTdMatch[1]) : null;
  };

  const dirtCondition = field("Track") || null;
  const turfRaw = field("Turf");
  const turfConditions = [];
  if (turfRaw) {
    const re = /([A-Za-z]+):\s*([A-Za-z]+)/g;
    let m;
    while ((m = re.exec(turfRaw))) turfConditions.push({ course: m[1], condition: m[2].toUpperCase() });
  }

  // Rail-out distance is reported per turf course under that course's own
  // name as a row label ("Inner: Set at 18 Ft"), not a single "Rail:" field.
  const railSettings = [];
  for (const course of ["Inner", "Mellon", "Widener"]) {
    const raw = field(course);
    if (raw && /Set at/i.test(raw)) railSettings.push({ course, label: raw });
  }

  const available = !!(dirtCondition || turfConditions.length || railSettings.length);
  return { available, cardDate, cardDateLabel, lastUpdatedLabel, dirtCondition, turfConditions, railSettings };
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
// parallel. Saratoga only — the only NYRA entries URL this app has verified
// end-to-end (Belmont/Aqueduct likely share this same rdl/race/ shape but
// that hasn't actually been checked).
const NYRA_ENTRIES_BASE = { saratoga: "https://www.nyra.com/saratoga" };

// Maps a track id to which entries scraper handles it — checked before
// either fetchNyraEntriesDay() or fetchDmtcEntriesDay() runs. Add a track
// here only once its source has actually been fetched and its markup
// verified (same rule as every other scrape in this file).
const ENTRIES_SOURCE_BY_TRACK = { saratoga: "nyra", delmar: "dmtc", monmouth: "monmouth" };

// Nav links HTML-encode their querystrings ("...&amp;race=3"), so this
// matches on "race=" alone rather than requiring a raw "&"/"?" just before it.
function maxRaceNumberFromNav(html) {
  const nums = Array.from(html.matchAll(/race=(\d+)"/g)).map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

function parseNyraRaceFragment(html, date) {
  const headerMatch = html.match(/font-heading">\s*Race\s*(\d+)\s*<\/header>/);
  if (!headerMatch) return null;
  const raceNumber = Number(headerMatch[1]);

  const mtpMatch = html.match(/data-post-time="([^"]+)"[^>]*data-mtp-variant="[^"]*"[^>]*aria-label="[^"]*">([^<]*)<\/span>/);
  let postTimeIso = mtpMatch ? mtpMatch[1] : null;
  const mtpLabel = mtpMatch ? decodeEntities(mtpMatch[2]).trim() : null;

  // Future-day entries pages don't render the live "minutes to post"
  // widget above (that only applies to today's actual race day) — instead
  // they show a plain "1:10p at Saratoga" string in the same info row as
  // distance/surface. Same info, different markup, so fall back to it.
  if (!postTimeIso && date) {
    const postTimeTextMatch = html.match(/<div class="text-zinc-800 dark:text-white ml-auto">\s*([\s\S]*?)\s*<\/div>/);
    const timeMatch = postTimeTextMatch && postTimeTextMatch[1].match(/(\d{1,2}):(\d{2})\s*([ap])/i);
    if (timeMatch) {
      let hour = Number(timeMatch[1]);
      const isPm = timeMatch[3].toLowerCase() === "p";
      if (isPm && hour !== 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
      postTimeIso = `${date}T${String(hour).padStart(2, "0")}:${timeMatch[2]}:00`;
    }
  }

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
    return { html, race: parseNyraRaceFragment(html, date) };
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

// ---------- NYRA Results (same rdl/race/ endpoint as entries above, just
// limit=results instead of limit=entries) ----------
// NYRA's own page shows the literal text "Results not available. Results
// are presented after full order of finish is official." for any race that
// hasn't gone official yet — no results table renders at all in that case.
// That's the signal used here for isFinal, not a guess based on scheduled
// post time, so a stewards' inquiry that delays "official" past post time
// is handled correctly: the table just won't exist until NYRA posts it,
// whatever the reason for the delay. Verified directly against a real
// completed card (2026-08-16) and a not-yet-run one (2026-08-20).
function parseNyraResultsFragment(html) {
  const headerMatch = html.match(/font-heading">\s*Race\s*(\d+)\s*<\/header>/);
  if (!headerMatch) return null;
  const raceNumber = Number(headerMatch[1]);

  // The finish-order table is class="w-full -mt-3" specifically (the
  // payouts table below it is class="w-full" with no -mt-3, which is how
  // the two are told apart here).
  const finishTableMatch = html.match(/<table class="w-full -mt-3">([\s\S]*?)<\/table>/);
  const finishOrder = [];
  if (finishTableMatch) {
    const tbodyMatch = finishTableMatch[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
    if (tbodyMatch) {
      const rowRe = /<tr>\s*<td[^>]*>\s*<div[^>]*>\s*(\d+)\s*<\/div>\s*<\/td>\s*<td[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*<\/a>\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<\/tr>/g;
      let m;
      let position = 0;
      while ((m = rowRe.exec(tbodyMatch[1]))) {
        position += 1;
        const [, postPosition, nameRaw, winRaw, placeRaw, showRaw] = m;
        finishOrder.push({
          finishPosition: position,
          postPosition,
          horseName: decodeEntities(nameRaw).trim(),
          winPayout: decodeEntities(winRaw).trim() || null,
          placePayout: decodeEntities(placeRaw).trim() || null,
          showPayout: decodeEntities(showRaw).trim() || null,
        });
      }
    }
  }

  const payouts = [];
  const payoutTableMatch = html.match(/<table class="w-full">([\s\S]*?)<\/table>/);
  if (payoutTableMatch) {
    const payoutRowRe = /<tr class="border-t[^"]*">\s*<td[^>]*>\s*(\$[\d.]+)\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*(\$[\d.,]+)\s*<\/td>/g;
    let pm;
    while ((pm = payoutRowRe.exec(payoutTableMatch[1]))) {
      const [, wagerAmount, wagerTypeRaw, comboRaw, payout] = pm;
      payouts.push({
        wagerAmount: decodeEntities(wagerAmount).trim(),
        wagerType: decodeEntities(wagerTypeRaw).trim(),
        winningCombo: decodeEntities(comboRaw).trim(),
        payout: decodeEntities(payout).trim(),
      });
    }
  }

  return { raceNumber, isFinal: finishOrder.length > 0, finishOrder, payouts };
}

async function fetchNyraResultsDay(track, date) {
  const base = NYRA_ENTRIES_BASE[track];
  const fetchRace = async (n) => {
    const res = await fetch(`${base}/rdl/race/?day=${date}&limit=results&race=${n}`, {
      headers: { "User-Agent": BROWSER_UA },
      cf: { cacheTtl: 90, cacheEverything: true }, // short — a race can go final mid-poll-interval
    });
    if (!res.ok) return { html: null, result: null };
    const html = await res.text();
    return { html, result: parseNyraResultsFragment(html) };
  };

  const first = await fetchRace(1);
  const raceCount = first.html ? maxRaceNumberFromNav(first.html) : 1;
  const races = first.result ? [first.result] : [];

  if (raceCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: raceCount - 1 }, (_, i) => i + 2).map((n) => fetchRace(n).catch(() => ({ result: null })))
    );
    for (const { result } of rest) if (result) races.push(result);
  }
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { date, races };
}

// ---------- Del Mar (DMTC) Entries parser ----------
// Source verified directly: unlike NYRA, dmtc.com's whole-card entries page
// (https://www.dmtc.com/racing/entries) is one plain server-rendered HTML
// page with every race inline — no fragment endpoint, no per-race requests.
// It also has no date parameter: it always shows whichever day's card DMTC
// currently has up (confirmed via its own <meta description>, which states
// the exact date in plain text), so a request for any other date just comes
// back empty — there's no way to ask this source for a different day.
// Each horse row is duplicated (a "hidden-xs"/desktop version and a
// "visible-xs" mobile version of the same data) — only the desktop version
// is parsed, and each row's silk-color <div> class increments per horse
// (silk1, silk2, ...), which anchors the row-start regex below.
// Scratches are NOT inline in the horse table (DMTC just omits them from
// it) — instead each race has a separate "SCRATCHED: Name - Reason, ..."
// line, parsed here and re-added to the horses array with scratched:true so
// the client's existing NYRA-shaped rendering (struck-through row, SCR tag)
// works unchanged. DMTC doesn't publish live tote odds anywhere on this
// page, only morning line, so currentOdds is always null for this source.
const DMTC_ENTRIES_URL = "https://www.dmtc.com/racing/entries";

function dmtcCardDate(html) {
  const m = html.match(/race entries for (\w+),\s*(\w+)\s+(\d{1,2})\w{0,2},\s*(\d{4})/i);
  if (!m) return null;
  const month = NYRA_MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[4]}-${String(month).padStart(2, "0")}-${String(parseInt(m[3], 10)).padStart(2, "0")}`;
}

// "2:00PM" + "2026-08-16" -> "2026-08-16T14:00:00", the same naive
// "no offset, track-local wall clock" shape parseNyraRaceFragment() produces
// for postTimeIso, so the client's weatherAtPostTime() works unchanged for
// either source.
function dmtcPostTimeToIso(date, label) {
  const m = label && label.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${date}T${String(h).padStart(2, "0")}:${m[2]}:00`;
}

function parseDmtcRaceChunk(chunk, date) {
  const headerMatch = chunk.match(/<div title="Race (\d+) Entries">/);
  if (!headerMatch) return null;
  const raceNumber = Number(headerMatch[1]);

  const condMatch = chunk.match(/<div class="bold text-muted-dark">([\s\S]*?)<\/div>/);
  let surface = null, distanceLabel = null, raceType = null, purse = null, postTimeLabel = null;
  if (condMatch) {
    const flat = decodeEntities(condMatch[1]).replace(/\s+/g, " ").trim();
    const parts = flat.split(/\s\/\s/).map((s) => s.trim());
    if (parts[0]) {
      const sd = parts[0].split(",").map((s) => s.trim());
      surface = sd[0] || null;
      distanceLabel = sd.slice(1).join(", ") || null;
    }
    raceType = parts[1] || null;
    const purseMatch = (parts[2] || "").match(/PURSE:\s*(.+)/i);
    purse = purseMatch ? purseMatch[1].trim() : null;
    const postMatch = (parts[3] || "").match(/POST TIME:\s*(.+)/i);
    postTimeLabel = postMatch ? postMatch[1].trim() : null;
  }

  const horses = [];
  const horseRe = /<div class="silk silk-lg silk\d+">\s*\d+\s*<\/div>[\s\S]*?<td class="text-center vertical-center">\s*(\S+)\s*<\/td>[\s\S]*?<div class="bigger"><strong>([^<]+)<\/strong><\/div>[\s\S]*?<td class="hidden-xs vertical-center">\s*([^<]*?)\s*<\/td>\s*<td class="hidden-xs vertical-center">\s*([^<]*?)\s*<\/td>\s*<td class="hidden-xs vertical-center text-center">\s*([^<]*?)\s*<\/td>\s*<td class="hidden-xs text-center vertical-center">\s*([^<]*?)\s*<\/td>\s*<td class="hidden-xs text-center vertical-center">\s*([^<]*?)\s*<\/td>/g;
  let m;
  while ((m = horseRe.exec(chunk))) {
    const [, pp, name, jockey, trainer, med, wgt, ml] = m;
    horses.push({
      postPosition: decodeEntities(pp).trim() || null,
      name: decodeEntities(name).trim(),
      jockey: decodeEntities(jockey).trim() || null,
      trainer: decodeEntities(trainer).trim() || null,
      medication: decodeEntities(med).trim() || null,
      weight: decodeEntities(wgt).trim() || null,
      mlOdds: decodeEntities(ml).trim() || null,
      scratched: false,
      currentOdds: null,
    });
  }

  const scrMatch = chunk.match(/SCRATCHED:\s*<\/strong>&nbsp;\s*([\s\S]*?)\s*<\/div>/);
  if (scrMatch) {
    const text = decodeEntities(scrMatch[1]).replace(/\s+/g, " ").trim();
    text.split(",").forEach((part) => {
      const nm = part.split(" - ")[0].trim();
      if (nm) {
        horses.push({
          postPosition: null, name: nm, jockey: null, trainer: null,
          medication: null, weight: null, mlOdds: null,
          scratched: true, currentOdds: null,
        });
      }
    });
  }

  return {
    raceNumber, postTimeIso: dmtcPostTimeToIso(date, postTimeLabel), mtpLabel: null,
    purse, raceType, distanceLabel, surface, horses,
  };
}

function parseDmtcEntries(html, date) {
  const cardDate = dmtcCardDate(html);
  if (!cardDate || cardDate !== date) return { date, races: [] }; // not today's card — see file-level note above
  const chunks = html.split(/(?=<div title="Race \d+ Entries">)/).filter((c) => /^<div title="Race \d+ Entries">/.test(c));
  const races = chunks.map((c) => parseDmtcRaceChunk(c, date)).filter(Boolean);
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { date, races };
}

async function fetchDmtcEntriesDay(date) {
  const res = await fetch(DMTC_ENTRIES_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`DMTC returned HTTP ${res.status}`);
  const html = await res.text();
  return parseDmtcEntries(html, date);
}

// ---------- DMTC Post Position stats parser (job #10) ----------
// Source verified directly: dmtc.com/handicapping/pp-stats is a plain
// server-rendered page (not JS-rendered) with one small HTML table per
// distance/surface combo — e.g. an <h4>5 Furlongs on Dirt</h4> header row
// followed by one <tr> per starting post (post/starts/wins/win%). No date
// param needed: the page with no query string always shows the CURRENT
// meet's season-to-date numbers, same "always shows what's live right now"
// behavior as DMTC's entries page (see the file-level note above it).
function parseDmtcPostPositionStats(html) {
  const idx = html.indexOf('id="main-content"');
  const body = idx === -1 ? html : html.slice(idx);

  const updatedMatch = body.match(/Last Updated:\s*([^<]+)</i);
  const lastUpdatedLabel = updatedMatch ? decodeEntities(updatedMatch[1]).trim() : null;
  const meetMatch = body.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const meetLabel = meetMatch ? decodeEntities(meetMatch[1]).trim() : null;

  const tables = [];
  const tableRe = /<table class="table table-striped table-condensed">([\s\S]*?)<\/table>/g;
  let tm;
  while ((tm = tableRe.exec(body))) {
    const block = tm[1];
    const titleMatch = block.match(/<h4[^>]*>([^<]+)<\/h4>/);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1]).trim(); // "5 Furlongs on Dirt"
    const surfaceMatch = title.match(/on (Dirt|Turf)$/i);
    if (!surfaceMatch) continue;
    const surface = surfaceMatch[1].toUpperCase();
    const distanceLabel = title.replace(/\s*on (Dirt|Turf)$/i, "").trim();

    const rows = [];
    const rowRe = /<td class="bold">(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>([\d.]+)%<\/td>/g;
    let rm;
    while ((rm = rowRe.exec(block))) {
      rows.push({
        post: Number(rm[1]),
        starts: Number(rm[2]),
        wins: Number(rm[3]),
        winPct: Number(rm[4]),
      });
    }
    if (rows.length) tables.push({ distanceLabel, surface, rows });
  }
  return { meetLabel, lastUpdatedLabel, tables };
}

// ---------- Monmouth Park Entries parser ----------
// Source verified directly: monmouthpark.com's entries page
// (https://www.monmouthpark.com/horse-racing/entries-3/) is one plain
// server-rendered page, no fragment endpoint, no date parameter — like DMTC,
// it always shows whichever card is CURRENTLY open, which is NOT usually
// today: Monmouth doesn't race every day, and this page gets its next card
// posted several days ahead of the actual race day (verified: on
// 2026-08-16, a non-racing Sunday, this page was already showing the
// 2026-08-21 card). The real card date is read off the page's own accordion
// heading ("Entries 08/21/2026"); parseMonmouthEntries() then requires it
// to equal the requested `date` (same rule as DMTC) and returns no races
// otherwise — a deliberate product choice: the Entries tab should read as
// "no races today" on a dark day, not silently preview a future card.
//
// The page has an M/L (morning line) field per horse, but as verified it is
// unpopulated for every horse on the page right now — a real gap in this
// source, not a parsing bug. mlOdds comes back null until/unless Monmouth
// starts publishing it (unconfirmed whether that happens closer to race
// day). There's also no scratch data anywhere on this page (entries this
// far out predate scratches) — scratched is always false. No surface
// (dirt/turf) field exists per race either — distance is the only course
// info this source actually gives, so surface stays null.
const MONMOUTH_ENTRIES_URL = "https://www.monmouthpark.com/horse-racing/entries-3/";

function monmouthCardDate(html) {
  const m = html.match(/accordion__title small-text">\s*Entries (\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function monmouthPostTimeToIso(cardDate, label) {
  const m = label && label.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m || !cardDate) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${cardDate}T${String(h).padStart(2, "0")}:${m[2]}:00`;
}

function monmouthField(block, label) {
  const m = block.match(new RegExp(`<span>${label}:</span>([\\s\\S]*?)</div>`));
  if (!m) return null;
  const val = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return val || null;
}

function parseMonmouthRaceChunk(chunk, cardDate) {
  const numMatch = chunk.match(/RACE\s*\n?\s*#(\d+)/);
  if (!numMatch) return null;
  const raceNumber = Number(numMatch[1]);

  const distMatch = chunk.match(/Distance:\s*([^<]+)<\/li>/);
  const typeMatch = chunk.match(/Race Type:\s*([^<]+)<\/li>/);
  const purseMatch = chunk.match(/Purse:\s*([^<]+)<\/li>/);
  const postMatch = chunk.match(/Post:\s*([^<]+?)\s*<\/li>/);
  const postTimeLabel = postMatch ? decodeEntities(postMatch[1]).replace(/\s+/g, " ").trim() : null;

  const horses = [];
  const rowChunks = chunk.split('<div class="tr">').slice(1);
  for (const rc of rowChunks) {
    const name = monmouthField(rc, "Horse");
    if (!name) continue;
    horses.push({
      postPosition: monmouthField(rc, "PP"),
      name,
      jockey: monmouthField(rc, "Jockey"),
      trainer: monmouthField(rc, "Trainer"),
      weight: monmouthField(rc, "Weight"),
      medication: monmouthField(rc, "MED"),
      ageSex: monmouthField(rc, "A/S"),
      mlOdds: monmouthField(rc, "M\\/L"),
      scratched: false,
      currentOdds: null,
    });
  }

  return {
    raceNumber, postTimeIso: monmouthPostTimeToIso(cardDate, postTimeLabel), mtpLabel: null,
    purse: purseMatch ? decodeEntities(purseMatch[1]).trim() : null,
    raceType: typeMatch ? decodeEntities(typeMatch[1]).trim() : null,
    distanceLabel: distMatch ? decodeEntities(distMatch[1]).trim() : null,
    surface: null, horses,
  };
}

// Same "date must match the currently-open card, else empty" rule as DMTC
// (see parseDmtcEntries) — the client only ever asks for today, and the
// product decision here is that a non-race-day should read as "no races",
// not silently surface a preview of some future day's card.
function parseMonmouthEntries(html, date) {
  const cardDate = monmouthCardDate(html);
  if (!cardDate || cardDate !== date) return { date, races: [] };
  const chunks = html.split('<div class="table-section">').slice(1);
  const races = chunks.map((c) => parseMonmouthRaceChunk(c, cardDate)).filter(Boolean);
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { date, races };
}

async function fetchMonmouthEntriesDay(date) {
  const res = await fetch(MONMOUTH_ENTRIES_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Monmouth returned HTTP ${res.status}`);
  const html = await res.text();
  return parseMonmouthEntries(html, date);
}

// ---------- TDN Saratoga Notebook parser ----------
// Source verified directly: unlike thisishorseracing.com's Stable Tour
// pieces (job #2 above — one trainer per article, clean per-horse markers),
// TDN's "Saratoga Notebook, presented by NYRA Bets" series is real
// journalism prose that often covers SEVERAL trainers in one article,
// sequentially — one blurb per trainer, no clean section headings. Two
// structural signals still make this parseable without real NLP, both
// checked against a real 3-trainer article before writing this: (1) each
// blurb reliably opens with a "trainer [Name]" mention; (2) horse names are
// consistently wrapped in <strong> within the article body (the only other
// <strong> usage found — the byline — sits outside the articleBody span and
// so never reaches this parser). A Notebook piece that never literally says
// "trainer [Name]" near a blurb's start won't be picked up; that's a known,
// accepted gap, not a bug.
//
// A THIRD signal turned out to matter just as much, found only after a real
// false-positive report (a user caught four horses credited to the wrong
// trainer): NOT every "Saratoga Notebook"-tagged piece is a sequential
// multi-trainer blurb. Some are single-race deep-dives (e.g. previewing one
// Saratoga stakes) that mention several different horses/trainers within a
// few paragraphs of each other — a real example had four rivals' horses
// sitting two paragraphs after a "trainer Mark Casse" mention, close enough
// that "everything until the next trainer mention" swept them all into
// Casse's section. Fix: instead of one open-ended section per trigger, each
// horse is attributed to whichever tracked trainer NAME (the "trainer
// [Name]" trigger OR any bare later mention of that same last name) is
// closest AND within 1 paragraph — ties or nothing-in-range means no
// attribution, not a guess. Verified this preserves 100% of the original
// 3-trainer article's horses (including ones several paragraphs past their
// trainer's last mention) while dropping every one of the four reported
// false positives from the deep-dive piece. It isn't perfect — a rival
// horse mentioned in the SAME breath as a trainer discussion can still slip
// through (found one such case, "Swiss Skydiver," in the same deep-dive
// piece) — but that's a much smaller, accepted residual risk next to
// crediting someone else's whole Whitney field to one barn.
//
// This returns raw per-section structure only (the trainer name as
// detected in the prose, horse names, paragraph text) — same "worker
// extracts, client interprets" split as everything else in this file. The
// client decides whether a detected name matches a trainer it's already
// tracking; this endpoint doesn't know or care about that, and (unlike job
// #2) never asks the client to track a NEW trainer it hasn't already added.
const TDN_NOTEBOOK_FEED_URL = "https://www.thoroughbreddailynews.com/tag/saratoga-notebook/feed/";
const TDN_PROXIMITY_WINDOW = 1; // paragraphs — see the tuning story above

function extractTdnArticleBody(html) {
  const start = html.indexOf('itemprop="articleBody"');
  if (start === -1) return "";
  const openEnd = html.indexOf(">", start) + 1;
  const close = html.indexOf("</span>", openEnd);
  return close === -1 ? html.slice(openEnd) : html.slice(openEnd, close);
}

function extractTdnSections(bodyHtml) {
  const paras = [];
  const trainerNames = new Set();
  for (const m of bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const inner = m[1];
    const plain = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!plain) continue;

    const horseNames = [];
    for (const sm of inner.matchAll(/<strong>([^<]{2,50})<\/strong>/g)) {
      const name = decodeEntities(sm[1]).trim();
      if (isShortName(name) && !horseNames.includes(name)) horseNames.push(name);
    }

    // No "." in the name char class on purpose (verified the hard way): it let a
    // sentence-ending period ("trainer Linda Rice. During...") glue onto the next
    // sentence's capitalized word as a false second name token ("Rice. During").
    // Trade-off: a trainer credited with a period-bearing initial ("H. Graham
    // Motion") won't capture past the initial — accepted, matches this file's
    // "good enough for a known source" bar rather than full name-parsing.
    const trainerMatch = inner.match(/\b[Tt]rainer\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})/);
    if (trainerMatch) {
      // Strips a trailing possessive ("trainer Cherie DeVaux's assistant...")
      // — verified against a real article where this happened. The 's isn't
      // part of the name and would otherwise break the client's last-name
      // match against its tracked list ("devaux's" != "devaux").
      trainerNames.add(trainerMatch[1].trim().replace(/['’]s$/, ""));
    }
    paras.push({ plain, horseNames });
  }

  const names = [...trainerNames];
  // Every paragraph mentioning a trainer's LAST name — not just the original
  // "trainer [Name]" trigger paragraph — so a later bare re-mention ("Rice
  // said...", "Casse nervous?") extends how far that trainer's horses can
  // still be found, the way the original design's open-ended section did.
  const mentionsByTrainer = {};
  for (const name of names) {
    const lastName = name.split(/\s+/).pop();
    mentionsByTrainer[name] = paras.map((_, i) => i).filter((i) => new RegExp(`\\b${escapeRegExpTdn(lastName)}\\b`).test(paras[i].plain));
  }

  const byTrainer = {}; // name -> { horseNames: [], paraIdx: Set }
  for (let i = 0; i < paras.length; i++) {
    if (!paras[i].horseNames.length) continue;
    let best = null, bestDist = Infinity, tie = false;
    for (const name of names) {
      const dist = Math.min(...mentionsByTrainer[name].map((mi) => Math.abs(mi - i)), Infinity);
      if (dist > TDN_PROXIMITY_WINDOW) continue;
      if (dist < bestDist) { bestDist = dist; best = name; tie = false; }
      else if (dist === bestDist && name !== best) { tie = true; }
    }
    if (!best || tie) continue; // out of range, or two trainers equally close — no guess
    if (!byTrainer[best]) byTrainer[best] = { horseNames: [], paraIdx: new Set() };
    for (const h of paras[i].horseNames) if (!byTrainer[best].horseNames.includes(h)) byTrainer[best].horseNames.push(h);
    byTrainer[best].paraIdx.add(i);
  }

  return Object.entries(byTrainer).map(([trainerName, v]) => ({
    trainerName,
    horseNames: v.horseNames,
    text: [...v.paraIdx].sort((a, b) => a - b).map((i) => paras[i].plain).join(" ").slice(0, 1500),
  }));
}

function escapeRegExpTdn(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchTdnNotebook() {
  const feedRes = await fetch(TDN_NOTEBOOK_FEED_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!feedRes.ok) throw new Error(`TDN feed returned HTTP ${feedRes.status}`);
  const feedXml = await feedRes.text();
  const items = parseFeedItems(feedXml).slice(0, MAX_ARTICLES_PER_RUN);

  const articles = [];
  for (const item of items) {
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

    const html = await articleRes.text();
    const sections = extractTdnSections(extractTdnArticleBody(html));
    if (!sections.length) continue;
    articles.push({ guid: item.guid || item.link, title: item.title, link: item.link, pubDate: item.pubDate, sections });
  }

  return { source: TDN_NOTEBOOK_FEED_URL, fetchedAt: new Date().toISOString(), articles };
}
