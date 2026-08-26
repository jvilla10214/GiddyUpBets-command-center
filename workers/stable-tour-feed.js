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
//    fetchMonmouthEntriesDay() for Monmouth, fetchSportingLifeEntriesDay()
//    (see its own comment below) for York plus 8 more international tracks
//    added at once (Ascot, Epsom Downs, Newmarket, Curragh, Longchamp, Sha
//    Tin, Happy Valley, Meydan) — one Sporting Life meeting-lookup pipeline
//    already covers all of them, verified per track (exact course-name
//    string, not just a guessed match) rather than assumed from York
//    working. Three of the eight (Sha Tin, Happy Valley, Meydan) are
//    off-season as of this writing and will just read "no races" until
//    their meets resume — same graceful behavior as any other dark day,
//    not a broken integration. All sources require the requested `date` to
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
//    Also parses three more fields this page has. turfRaceCourse (the
//    page's "Turf Races: Mellon: 1,5,8  Inner: 6,10" row, mapping a race
//    number to which turf course it actually runs on — rail-out distance
//    is set per course, not per card, so this is what lets a specific
//    race's note cite the RIGHT course's rail setting) and miscChanges
//    (the page's own MISCELLANEOUS CHANGES table — equipment/gelding/etc.,
//    via the shared extractNyraChangeRows() helper) are both surfaced
//    client-side as Saratoga's own per-race "Changes" note (same UI job
//    #6's DMTC entries source already has for Del Mar). jockeyChanges (the
//    page's JOCKEY CHANGES table, same helper) is surfaced differently —
//    applied INTO the entries table itself, replacing the stale jockey
//    name on that horse's own row, since a rider swap corrects a fact
//    already shown per-horse rather than adding a new one. Deliberately
//    does NOT parse this page's SCRATCHES table — that already comes
//    through the entries page's own SCR marker, so parsing it again here
//    would just be a second, redundant read of the same fact.
//    York, Ascot, Newmarket, and Epsom Downs also answer through this same
//    endpoint, but via a different upstream: their going condition comes
//    from TurfTrax's WDV API Stream (job #12's data source, verified for
//    each of these four directly the same way — their own going-report
//    pages embed this exact stream via iframe, and a bare request without
//    the matching Referer is rejected with "Unlicensed Direct Access",
//    same as job #12). TURFTRAX_GOING_STREAM_URL_BY_TRACK/TURFTRAX_GOING_
//    REFERER_BY_TRACK below select this path instead of NYRA_SCRATCHES_
//    CODE_BY_TRACK's, and
//    parseTurftraxGoingReport() maps its "going-report"/"going-race-date"/
//    "going-report-date" fields onto the same {available, cardDate,
//    turfConditions, ...} shape parseNyraTrackConditions() returns (plus a
//    "provider" field so the client can label the source correctly) —
//    everything downstream (KV persistence, the date-rollover fallback)
//    is shared, unchanged code. No rail/GoingStick parsing here: York's
//    rail text is a multi-day paragraph, not a short "Set at N Ft" value
//    the client's rail tile can hold, so that detail is left to the
//    client's existing link-out card instead (pointed at TurfTrax's own
//    public visualiser page) rather than force-fit into this endpoint.
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
//    side to exactly "Severe Thunderstorm Warning", "Tornado Warning", and
//    "Flash Flood Warning" (not Watches, not Advisories, not any other
//    alert type) — Flash Flood Warning added alongside the original two
//    since it's directly relevant to whether a track can run at all, same
//    bar as the other two (an active, in-progress WARNING, not a lower-
//    confidence Watch/Advisory). Free, keyless, official government
//    source. This is the one job in this file that a browser could never
//    do directly even though the API itself is CORS-open — NWS documents a
//    descriptive User-Agent as required, and fetch() is spec-forbidden
//    from setting its own User-Agent header, so this has to go through a
//    server-side context. See NWS_USER_AGENT above.
//    Called once per US track (client-side, see index.html's
//    refreshSevereWeatherAlerts()) — every US track's own coordinates, not
//    just whichever one is currently active, so a Belmont tornado warning
//    still surfaces while looking at Saratoga's dashboard. International
//    tracks aren't queried at all — NWS has no coverage outside the US.
//    The route itself still treats an out-of-coverage point as a normal,
//    non-error "no alerts" response (200, empty array) rather than the
//    502 every other failure here gets — NWS answers a non-US point with
//    its own 400 "Parameter point is invalid: out of bounds", which isn't
//    a fetch failure at all, just "nothing to report for this location."
//    No current caller can actually hit this (client-side is already
//    US-only, above), but the route shouldn't mislabel a coverage
//    boundary as an error if something ever does.
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
// 13. Race results (GET /results?track=<id>&date=YYYY-MM-DD) — official
//    order of finish + payouts once a race has gone final. Was Saratoga-only
//    (NYRA's rdl/race/?limit=results fragment, same endpoint shape as job
//    #6's entries) until this job's own doc entry got added; now also
//    covers Del Mar via fetchDmtcResultsDay(), dispatched by
//    RESULTS_SOURCE_BY_TRACK (a separate map from job #6's
//    ENTRIES_SOURCE_BY_TRACK — a track's entries and results sources aren't
//    guaranteed to land in the same commit). DMTC's results page takes the
//    date directly in its URL (/racing/results/YYYY-MM-DD) rather than
//    always reflecting "whichever day is current" the way its entries page
//    does, so this fetches the exact requested date. isFinal is the
//    table's-presence-is-the-signal rule from parseNyraResultsFragment(),
//    not a guess off scheduled post time — DMTC's own page only renders a
//    race's panel once it has results to show, same effect. DMTC only
//    tables the top 3 finishers (win/place/show); the rest of the field
//    comes back as a flat alsoRan name list, which NYRA's shape has no
//    equivalent for — carried as its own field rather than forced into fake
//    finishOrder rows. Read-only, no storage, short cache (a race can go
//    final mid-poll-interval). Now also covers all 9 Sporting Life tracks
//    via fetchSportingLifeResultsDay() — a separate two-step lookup through
//    Sporting Life's /racing/results/ endpoints (not /racing/racecards/,
//    which only ever serves "today" — see that function's own comment).
//    isFinal there is race_stage being RESULT or WEIGHEDIN, this source's
//    own equivalent of "does a finish table exist."
//
// 14. Del Mar changes/scratches notes (GET /changes?track=delmar&date=
//    YYYY-MM-DD) — DMTC's own page for Equibase's "Changes & Scratches"
//    feed: free-text per-race notes (temp rail distance, gelding reports,
//    equipment/jockey changes, and occasionally scratches, all in one
//    unstructured sentence with no consistent sub-format) — genuinely
//    different from job #6's entries scratches (which DMTC's entries page
//    already surfaces structurally, "Name - Reason", with a real reason
//    each time) or job #9's dirt/turf/rail conditions. This job doesn't try
//    to classify or split each race's note further, just returns whatever
//    text DMTC published for that race — the client displays it as-is.
//    No date param on DMTC's side (same "always shows today's currently-
//    open card" rule as job #6's DMTC entries source), so a request for any
//    other date reads back empty. Read-only, no storage. Del Mar only —
//    CHANGES_SOURCE_BY_TRACK, same verify-before-adding rule as every other
//    track map in this file.
//
// 15. Race Day Archive (GET/POST /raceday, GET /raceday/dates) — persists
//    each day's entries+results (jobs #6/#13, whichever the client already
//    fetched live) so the client can show a past date without needing that
//    day's source page to still exist/still answer for it. One KV entry per
//    track+date (racedayKvKey(), same single-blob-per-day scheme as job #9's
//    trackConditionsKvKey — a whole race card is a much bigger payload than
//    a weatherlog/biaslog row, so this deliberately isn't a growing array
//    the way those two are). The client upserts opportunistically (fire-
//    and-forget, after its own normal entries/results poll) — POST here is
//    open, no passphrase, same reasoning as /weatherlog: every field is
//    scraped data already fetched, not free text a visitor could vandalize.
//    /raceday/dates lists which dates a track actually has a saved snapshot
//    for (via STABLE_KV.list(), newest first, capped at 60) so the client
//    can build a browsable date list without fetching every day's full
//    payload just to populate it.
//
// 16. Tracked-horse entry alert emails (Cron Trigger -> scheduled(), plus a
//    manual GET /debug-run-scheduled for on-demand testing without waiting
//    for the schedule) — a once-daily, race-day-only digest, not a
//    continuous "email the moment I notice you" watcher: the Cron Trigger
//    itself fires once a day around 8am Eastern (see the Deploy note below
//    for the exact UTC expression and its DST caveat), and each run only
//    checks TODAY's card (entryAlertTodayDate(), America/New_York) — for
//    every track in ALERT_TRACKS (currently Saratoga and Del Mar; a
//    deliberate subset of job #6's broader ENTRIES_SOURCE_BY_TRACK, which
//    also covers Monmouth and several international/UK tracks the Entries
//    tab supports for manual browsing but that alerts don't need to fire
//    on — confirmed real ask 2026-08-26), dispatched to the same
//    per-source fetcher that route already uses. A horse entered five days
//    out for a Saturday stakes race
//    doesn't email until Saturday morning. For every non-scratched horse
//    whose trainer's last name matches a tracked Stable Tour trainer
//    (readState(), same list job #1 manages) AND that already has at least
//    one matching stable note (notesForHorse(), a direct port of the
//    client's findHorseStableNotes() matching rules, reusing this file's
//    own lastNameKey() for the same forgiving last-name-only trainer match)
//    — a tracked horse with zero notes on file doesn't get included at all,
//    deliberately, since the whole point is surfacing notes at entry time.
//    Every matching horse for a track gets bundled into ONE digest email per
//    track per day (buildEntryDigestEmail()/sendEntryDigestEmail()) —
//    grouped by race number, each horse showing trainer/jockey/post plus
//    every matching note (both manual and auto-imported) — not a separate
//    Resend send per horse the way this originally shipped; that was too
//    noisy in practice (confirmed real complaint 2026-08-26). raceNotifyKvKey()
//    still dedupes per horse+race so the same horse never appears in a
//    digest twice, TTL'd at 30 days so the keys don't accumulate forever;
//    those dedup keys are only written after the digest send actually
//    succeeds, so a failed Resend call doesn't silently mark horses as
//    already-notified. A no-notes horse is deliberately left un-dedup'd so
//    a note added earlier that same race day, before the day's cron run,
//    still gets caught. One digest per track, never combined — a day with
//    both a matching Saratoga horse and a matching Del Mar horse sends two
//    separate emails. ALERT_TRACKS is Saratoga + Del Mar only for now — the
//    user's explicit target list also includes Belmont, Keeneland,
//    Churchill, and Santa Anita, added here as each becomes ready rather
//    than all at once (confirmed real ask 2026-08-26). Belmont specifically
//    can't go in yet even though NYRA_ENTRIES_BASE would let it: while its
//    meet is dark, nyra.com/belmont/rdl/race/ silently serves SARATOGA's
//    live card mislabeled as Belmont instead of an empty response (verified
//    directly, same horses/race names side-by-side) — adding it now would
//    double-count every Saratoga horse as also entered at Belmont. Re-add
//    once that meet reopens (Sept 18, 2026) and its real card is verified
//    fresh. Keeneland/Churchill/Santa Anita aren't in ALERT_TRACKS (or
//    anywhere else in this file) yet at all — none of them have an entries
//    scraper built, which is real future work (find each track's live
//    entries page, verify its markup), not a one-line addition. Every run
//    (real cron or
//    manual) records its own outcome via recordEntryAlertsRun(), readable
//    at GET /debug-last-run — the way to confirm the Cron Trigger is
//    actually firing on its own, since "0 emails" alone is ambiguous (it's
//    the expected result on most days once nothing new needs sending, not
//    evidence the schedule itself ran).
//
// 17. Horse Racing Nation news (GET /hrn-news) — same idea as job #7's TDN
//    parser (per-article, per-trainer sections with the horse names
//    mentioned), but for real trainer QUOTES specifically, not just any
//    factual trainer mention — see fetchHrnNews()'s own comment for why
//    that distinction matters here and how multi-horse articles get
//    resolved via an embedded field table when one exists. Read-only, no
//    storage, same reasoning as job #7 — the client checks a detected
//    trainer against its own tracked list and files notes; this endpoint
//    never adds a new trainer on its own.
// 18. SmartPony partner quotes (GET /smartpony-quotes) — pulls trainer
//    quotes from a partner site's own Supabase-backed trainer_quotes table
//    (not scraped HTML — a real authenticated API read), already split into
//    one quote per horse/trainer, so there's no proximity-matching to do
//    the way jobs #7/#17 need. Authenticates fresh on every call via
//    Supabase's standard email/password grant (see fetchSmartPonyQuotes()'s
//    own comment for why re-authenticating beats persisting a session
//    token) using SMARTPONY_EMAIL/SMARTPONY_PASSWORD secrets — a real
//    partner login, not a scraped-content credential, so treat those two
//    secrets with the same care as any other account password. Pulls all
//    of SmartPony's own review states (needs_review, auto_matched,
//    verified) — user's explicit call for coverage over only importing
//    their fully human-reviewed queue. Same "client resolves against its
//    own tracked list" reasoning as every other auto-import job here.
//    trainer_name_raw isn't always actually the trainer — confirmed real
//    cases of a horse's jockey or owner being quoted and treated as if
//    they were the trainer. Cross-references SmartPony's own race_entries
//    table (their past-performance data, keyed by matched_horse_id) to
//    find who's actually training that horse; when the quoted person
//    isn't them, the note files under the real trainer with the actual
//    speaker's name kept in the note text instead. Also passes through
//    SmartPony's own sentiment tag per quote for display.
// 19. Daily Racing Form news (GET /drf-news) — same overall shape as job
//    #17's HRN parser (per-article, quote-gated sections; client resolves
//    against its own tracked list, never adds a new trainer), pointed at
//    DRF's news sitemap instead of a listing page. DRF is fully free/
//    unauthenticated (confirmed via each article's own JSON-LD) but never
//    marks up a horse's name in prose the way TDN/HRN do, so horse
//    identification here comes from each article's <meta name="keywords">
//    tag instead of paragraph-proximity or an entries table — see
//    fetchDrfNews()'s own comment for the full reasoning and its two known
//    gaps (DRF_KEYWORD_TRACK_NAMES and DRF_RACE_NAME_SUFFIXES are both
//    necessarily incomplete, so an untracked track or race name
//    occasionally reads as a horse).
// Deploy: paste into the dashboard's Workers editor -> Deploy. Requires a KV
// namespace bound as STABLE_KV (Worker settings -> Bindings -> KV Namespace)
// for jobs #1, #3, #5, #9, #15, and #16 to work — jobs #2, #4, #6, #7, #8,
// #10, #11, #12, #13, #14, #17, and #18 (fetch-and-parse only, no storage)
// work without it. Job #8 additionally requires a PIRATE_WEATHER_API_KEY
// secret (Worker settings -> Variables and Secrets -> Add, type "Secret") —
// get a free key at pirateweather.net. Job #16 additionally requires a
// RESEND_API_KEY secret (same Variables and Secrets screen — get a free key
// at resend.com) and a Cron Trigger (Worker settings -> Triggers -> Cron
// Triggers -> Add Cron Trigger, "0 12 * * *" — once daily, 8am Eastern
// while EDT/daylight time is in effect (roughly mid-March to early
// November). Eastern falls back to EST (UTC-5) the rest of the year, which
// shifts that same "0 12 * * *" tick to 7am local — change it to "0 13 * *
// *" then, and back again in spring, since there's no wrangler.toml here to
// express DST-aware scheduling in code) — this has to be added/changed by
// hand in the dashboard. Job #18 additionally requires SMARTPONY_EMAIL and
// SMARTPONY_PASSWORD secrets (same Variables and Secrets screen) — the
// partner login credentials for smartpony.ai.
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
// Job #9's TurfTrax path (York) — separate maps from TURFTRAX_STREAM_URL/
// TURFTRAX_REFERER above since those are Ascot's own weather-sensor feed
// (job #12, a different content shape); same one-entry-per-verified-track
// rule as every other map in this file.
// Ascot/Newmarket both verified directly the same way York was (their own
// going-report pages embed this exact stream). Epsom Downs' internal track
// id is "epsomdowns" but TurfTrax's own URL slug for it is just "epsom" —
// confirmed directly (a request against ".../stream/epsomdowns.html" 404s,
// ".../stream/epsom.html" doesn't) — so the map's key is our id, the value
// is TurfTrax's real slug, same as everywhere else this file translates
// between our ids and an upstream's own naming.
const TURFTRAX_GOING_STREAM_URL_BY_TRACK = {
  york: "https://its.turftrax.co.uk/visualiser/stream/york.html",
  ascot: "https://its.turftrax.co.uk/visualiser/stream/ascot.html",
  newmarket: "https://its.turftrax.co.uk/visualiser/stream/newmarket.html",
  epsomdowns: "https://its.turftrax.co.uk/visualiser/stream/epsom.html",
};
const TURFTRAX_GOING_REFERER_BY_TRACK = {
  york: "https://its.turftrax.co.uk/visualiser/york/",
  ascot: "https://its.turftrax.co.uk/visualiser/ascot/",
  newmarket: "https://its.turftrax.co.uk/visualiser/newmarket/",
  epsomdowns: "https://its.turftrax.co.uk/visualiser/epsom/",
};
const TURFTRAX_GOING_COURSE_LABEL_BY_TRACK = { york: "York", ascot: "Ascot", newmarket: "Newmarket", epsomdowns: "Epsom Downs" };
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
// Job #16 — entry-alert email recipients/sender. Not secrets (an email
// address isn't sensitive the way an API key is), so these are plain
// constants here rather than env bindings — edit and redeploy to change
// them. An array (Resend's API accepts `to` as one) even though there's
// currently one recipient, so adding another later is a one-line edit.
// RESEND_FROM_EMAIL defaults to Resend's own onboarding sender, which only
// works for low-volume/testing use — swap it for a verified sending
// domain's address once one exists (see the Deploy note above).
//
// Back down to one recipient — confirmed real that Resend's shared
// onboarding@resend.dev sender 403s on any recipient besides the account's
// own verified address until a real domain is verified on Resend. Rather
// than wait on that, the user set up Gmail filters on jvilla10214@gmail.com
// forwarding entry-alert mail (From: onboarding@resend.dev) on to
// mark@giddyupbets.com and cdilo191@gmail.com — so fan-out happens on
// Gmail's side instead of Resend's. If a verified sending domain gets set
// up later, this can go back to listing all three directly.
const NOTIFY_EMAILS = ["jvilla10214@gmail.com"];
const RESEND_FROM_EMAIL = "GiddyUpBets Alerts <onboarding@resend.dev>";

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
  // Job #16's actual Cron Trigger entry point — see /debug-run-scheduled for
  // the on-demand equivalent used to test this without waiting on the
  // schedule.
  async scheduled(event, env, ctx) {
    // Confirmed real bug (2026-08-26): this was `event.waitUntil`, which
    // doesn't exist in the module-worker syntax this file uses — waitUntil
    // lives on `ctx` (the ExecutionContext), not the ScheduledController.
    // Every real Cron Trigger invocation threw "event.waitUntil is not a
    // function" immediately, which is exactly why /debug-last-run never
    // showed a "scheduled" source entry despite the trigger firing on
    // schedule every morning — confirmed via the Cloudflare dashboard's own
    // error logs (Metrics -> Errors) showing the TypeError at 08:00 EDT
    // daily, deployment version with 1 error/day. Recreating the Cron
    // Trigger itself never could have fixed this — the trigger was working,
    // the code calling it was wrong.
    ctx.waitUntil(
      runEntryAlerts(env, "scheduled").catch((err) => console.error("Entry alerts: scheduled run failed", err.message))
    );
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
      // No passphrase gate — this Worker's URL isn't public, only the small
      // team using this site has it, same trust level /biaslog and
      // /weatherlog writes already run at (never gated at all). The
      // passphrase was never real security to begin with (see the Deploy
      // note up top); it was just adding friction for legitimate teammates,
      // confirmed real when a note failed to save for a team member who
      // hadn't separately configured it in their own browser's Setup panel.
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return json({ error: "Missing name" }, 400);
      // Provenance tag for the roster UI — who/what added this trainer.
      // Defaults to "manual" so any older caller that doesn't send it (or a
      // future one that forgets to) still gets a sensible value rather than
      // undefined.
      const source = (body.source || "manual").trim();
      const state = await readState(env);
      const exists = state.trainers.some(t => t.toLowerCase() === name.toLowerCase());
      if (!exists) {
        state.trainers.push(name);
        state.trainerMeta[name] = { source, addedAt: new Date().toISOString() };
      }
      // Always re-sort and re-save, even on a duplicate — lets re-posting an
      // already-added name (harmless no-op otherwise) double as a one-time
      // way to re-sort the whole existing list after this ordering changed.
      state.trainers.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)) || a.localeCompare(b));
      await env.STABLE_KV.put("trainers", JSON.stringify(state.trainers));
      if (!exists) await env.STABLE_KV.put("trainerMeta", JSON.stringify(state.trainerMeta));
      return json({ trainers: state.trainers, trainerMeta: state.trainerMeta }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/trainers/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const names = Array.isArray(body.names) ? body.names.map(n => (n || "").trim()).filter(Boolean) : [];
      if (!names.length) return json({ error: "Missing names" }, 400);
      const source = (body.source || "manual").trim();
      const state = await readState(env);
      let addedAny = false;
      // One KV write for the whole batch instead of one per name — KV write
      // quota is a hard daily cap (free tier: 1,000/day, account-wide), and
      // a 100-name bulk-add used to cost 100+ writes on its own.
      for (const name of names) {
        const exists = state.trainers.some(t => t.toLowerCase() === name.toLowerCase());
        if (!exists) {
          state.trainers.push(name);
          state.trainerMeta[name] = { source, addedAt: new Date().toISOString() };
          addedAny = true;
        }
      }
      state.trainers.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)) || a.localeCompare(b));
      await env.STABLE_KV.put("trainers", JSON.stringify(state.trainers));
      if (addedAny) await env.STABLE_KV.put("trainerMeta", JSON.stringify(state.trainerMeta));
      return json({ trainers: state.trainers, trainerMeta: state.trainerMeta }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/trainers" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const name = body.name;
      const state = await readState(env);
      const trainers = state.trainers.filter(t => t !== name);
      const notes = state.notes.filter(n => n.trainer !== name); // cascade — no orphaned notes for a removed trainer
      delete state.trainerMeta[name];
      await env.STABLE_KV.put("trainers", JSON.stringify(trainers));
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      await env.STABLE_KV.put("trainerMeta", JSON.stringify(state.trainerMeta));
      return json({ trainers, notes, trainerMeta: state.trainerMeta }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      // Trainer is optional for a manually-added note (not for /notes/bulk,
      // which is auto-import only and always resolves a real trainer first)
      // — confirmed real need: a tip about a horse that hasn't run yet can
      // arrive before its trainer is even known, or the horse changes barns
      // before it does run, and forcing a guess at save time just means the
      // note stops matching once the guess turns out wrong. A trainer-less
      // note instead matches purely on horse name in notesForHorse() below,
      // valid regardless of which barn the horse ends up in.
      if (!body.horse || !body.note) return json({ error: "Missing required fields" }, 400);
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
        trainer: body.trainer || "",
        horse: body.horse,
        note: body.note,
        date: body.date || "",
        source: body.source || "",
        link: body.link || "",
        autoImported: !!body.autoImported,
        sentiment: body.sentiment || null, // optional — currently only SmartPony (job #18) supplies this
        capturedAt: new Date().toISOString(),
      };
      state.notes.push(note);
      await env.STABLE_KV.put("notes", JSON.stringify(state.notes));
      return json({ note }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes/bulk" && request.method === "POST") {
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
          sentiment: item.sentiment || null, // optional — currently only SmartPony (job #18) supplies this
          capturedAt: new Date().toISOString(),
        };
        state.notes.push(note);
        results.push({ note });
      }
      await env.STABLE_KV.put("notes", JSON.stringify(state.notes)); // one write for the whole batch
      return json({ results }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes" && request.method === "DELETE") {
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

    if (url.pathname === "/hrn-news" && request.method === "GET") {
      let result;
      try {
        result = await fetchHrnNews();
      } catch (err) {
        return json({ error: `HRN news fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=900" });
    }

    if (url.pathname === "/drf-news" && request.method === "GET") {
      let result;
      try {
        result = await fetchDrfNews();
      } catch (err) {
        return json({ error: `DRF news fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=900" });
    }

    if (url.pathname === "/smartpony-quotes" && request.method === "GET") {
      let quotes;
      try {
        quotes = await fetchSmartPonyQuotes(env);
      } catch (err) {
        return json({ error: `SmartPony fetch failed: ${err.message}` }, 502);
      }
      return json({ quotes }, 200, { "Cache-Control": "public, max-age=900" });
    }

    // One-time comprehensive audit — checks EVERY currently tracked
    // trainer's notes against SmartPony's own race_entries data (by horse
    // name, not by quote), not just newly-imported quotes. Built after
    // repeatedly finding pre-existing mis-attributed notes (jockeys,
    // owners, assistants, reporters, duplicate name variants) one at a
    // time via user reports — this checks the whole backlog in one pass.
    // Read-only: reports mismatches, changes nothing itself.
    if (url.pathname === "/smartpony-audit" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      try {
        const report = await auditNotesAgainstSmartPony(env);
        return json(report, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ error: `SmartPony audit failed: ${err.message}` }, 502);
      }
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
      const turfTraxUrl = TURFTRAX_GOING_STREAM_URL_BY_TRACK[track];
      if (!code && !turfTraxUrl) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);

      let parsed = { available: false };
      try {
        if (turfTraxUrl) {
          const res = await fetch(turfTraxUrl, {
            headers: { "User-Agent": BROWSER_UA, "Referer": TURFTRAX_GOING_REFERER_BY_TRACK[track], "Accept": "application/json" },
            cf: { cacheTtl: 300, cacheEverything: true },
          });
          if (res.ok) {
            const raw = await res.json();
            if (raw.status === 0 && raw.payload?.content) {
              parsed = parseTurftraxGoingReport(raw.payload, TURFTRAX_GOING_COURSE_LABEL_BY_TRACK[track] || track);
            }
          }
        } else {
          const res = await fetch(`https://tr-cdn.nyra.com/direct/scratches/${code}scratch.html`, {
            headers: { "User-Agent": BROWSER_UA },
            cf: { cacheTtl: 300, cacheEverything: true }, // this source's own cache-control is only 30s, but sub-5-minute freshness isn't needed
          });
          if (res.ok) parsed = parseNyraTrackConditions(await res.text());
        }
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
        else if (source === "sportinglife") result = await fetchSportingLifeEntriesDay(track, date);
        else result = await fetchMonmouthEntriesDay(date);
      } catch (err) {
        return json({ error: `Entries fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=120" });
    }

    if (url.pathname === "/results" && request.method === "GET") {
      const track = url.searchParams.get("track") || "";
      const date = url.searchParams.get("date") || "";
      const resultsSource = RESULTS_SOURCE_BY_TRACK[track];
      if (!resultsSource) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);
      let result;
      try {
        result = resultsSource === "dmtc" ? await fetchDmtcResultsDay(date)
          : resultsSource === "sportinglife" ? await fetchSportingLifeResultsDay(track, date)
          : await fetchNyraResultsDay(track, date);
      } catch (err) {
        return json({ error: `Results fetch failed: ${err.message}` }, 502);
      }
      // Short cache — a race can go from not-yet-final to final at any
      // moment during a card, unlike entries/odds which only drift slowly.
      return json(result, 200, { "Cache-Control": "public, max-age=90" });
    }

    if (url.pathname === "/changes" && request.method === "GET") {
      const track = url.searchParams.get("track") || "";
      const date = url.searchParams.get("date") || "";
      if (!CHANGES_SOURCE_BY_TRACK[track]) return json({ error: "Not supported for this track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);
      let result;
      try {
        result = await fetchDmtcChangesDay(date);
      } catch (err) {
        return json({ error: `Changes fetch failed: ${err.message}` }, 502);
      }
      return json(result, 200, { "Cache-Control": "public, max-age=120" });
    }

    if (url.pathname === "/raceday" && request.method === "GET") {
      const track = (url.searchParams.get("track") || "").trim();
      const date = url.searchParams.get("date") || "";
      if (!track) return json({ error: "Missing track" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing or invalid date (expected YYYY-MM-DD)" }, 400);
      const raw = await env.STABLE_KV.get(racedayKvKey(track, date));
      if (!raw) return json({ available: false, track, date }, 200, { "Cache-Control": "no-store" });
      return json({ available: true, ...JSON.parse(raw) }, 200, { "Cache-Control": "no-store" });
    }

    // Open write, no passphrase — same reasoning as /weatherlog: every field
    // here is scraped entries/results data the client already fetched and
    // is just archiving, not free text a visitor could vandalize with junk.
    // Upserts (overwrites) the one KV entry for that track+date — see
    // racedayKvKey()'s own comment on why this is a single-blob-per-day
    // scheme, not a growing array like weatherlog/biaslog.
    if (url.pathname === "/raceday" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date || "";
      if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing track or invalid date" }, 400);
      const record = {
        track, date,
        entries: Array.isArray(body.entries) ? body.entries : [],
        results: Array.isArray(body.results) ? body.results : [],
        capturedAt: new Date().toISOString(),
      };
      await env.STABLE_KV.put(racedayKvKey(track, date), JSON.stringify(record));
      return json({ available: true, ...record }, 200, { "Cache-Control": "no-store" });
    }

    // Lists which dates actually have a saved snapshot for this track, newest
    // first, without fetching every day's full entries+results payload just
    // to build a date picker. list() returns keys in lexicographic order,
    // which is also chronological here since the date suffix is fixed-width
    // YYYY-MM-DD — reversed below for newest-first. Capped at 60 (the same
    // ballpark as a typical track's meet length) since this is meant to
    // populate a browsable list, not serve as a full-history export.
    if (url.pathname === "/raceday/dates" && request.method === "GET") {
      const track = (url.searchParams.get("track") || "").trim();
      if (!track) return json({ error: "Missing track" }, 400);
      const prefix = racedayKvKey(track, "0000-00-00").replace("0000-00-00", "");
      const listed = await env.STABLE_KV.list({ prefix });
      const dates = listed.keys
        .map((k) => k.name.slice(prefix.length))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()
        .slice(0, 60);
      return json({ track, dates }, 200, { "Cache-Control": "no-store" });
    }

    // Manual trigger for job #16's runEntryAlerts(), gated the same way as
    // every other write route — this sends real email, so it isn't left
    // open. Exists because there's no way to fire a real Cron Trigger
    // on-demand for testing, and doubles as a permanent "run it right now"
    // convenience afterward (same idea as the Daily Log's own "+ Log
    // Today's Snapshot Now" manual-trigger button).
    if (url.pathname === "/debug-run-scheduled" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      let result;
      try {
        result = await runEntryAlerts(env);
      } catch (err) {
        return json({ error: `Entry alerts run failed: ${err.message}` }, 500);
      }
      return json(result, 200, { "Cache-Control": "no-store" });
    }

    // Sends a real email through the Resend pipeline right now, independent
    // of runEntryAlerts()'s own matching/dedup logic — a way to confirm
    // RESEND_API_KEY, RESEND_FROM_EMAIL, and NOTIFY_EMAILS are all correct
    // without needing an actual tracked-trainer entry to exist that day
    // (runEntryAlerts() only sends when it finds one, so on a dark day it
    // can't verify delivery at all).
    // Defaults to just NOTIFY_EMAILS[0] (the Resend account's own verified
    // address) rather than the full list — confirmed real that Resend's
    // shared onboarding@resend.dev sender 403s on any recipient besides the
    // account owner until a real domain is verified, so testing the other
    // two addresses this way isn't possible yet regardless of what this
    // route sends to. An explicit ?to= overrides this once that's sorted.
    if (url.pathname === "/debug-send-test-email" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const to = url.searchParams.get("to") ? [url.searchParams.get("to")] : [NOTIFY_EMAILS[0]];
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to,
            subject: "GiddyUpBets entry alerts — test email",
            html: `<p>This is a test of the entry-alert email pipeline. If you're reading this, delivery is working.</p>`,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return json({ error: `Resend HTTP ${res.status}: ${body.slice(0, 300)}` }, 502);
        }
        const body = await res.json().catch(() => ({}));
        return json({ sentTo: to, resendId: body.id || null }, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ error: `Test email failed: ${err.message}` }, 500);
      }
    }

    // Read-only — reports the last runEntryAlerts() run (real cron or
    // manual, see recordEntryAlertsRun()) without triggering a new one.
    // The actual way to confirm the Cron Trigger is firing on its own: 0
    // emails sent is expected once nothing new has entered since the last
    // run, but a "source": "scheduled" entry with a recent "ranAt" is real
    // proof the schedule itself is invoking the worker.
    if (url.pathname === "/debug-last-run" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const raw = await env.STABLE_KV.get("entryalerts:lastrun");
      return json(raw ? JSON.parse(raw) : { ranAt: null }, 200, { "Cache-Control": "no-store" });
    }

    // Wipes every job #16 dedup record (see raceNotifyKvKey()) — a reset
    // button for when the matching/gating rules change underneath already-
    // set keys (e.g. the note-gating change: horses emailed under the old
    // "send regardless of notes" rule already have a dedup key, which would
    // otherwise block a legitimate future email once a note actually gets
    // added for them). Paginated since STABLE_KV.list() caps at 1000 keys
    // per call. Same passphrase gate as every other route that mutates
    // shared state.
    if (url.pathname === "/debug-clear-race-notify" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      let cursor;
      let cleared = 0;
      do {
        const listed = await env.STABLE_KV.list({ prefix: "racenotify:", cursor });
        await Promise.all(listed.keys.map((k) => env.STABLE_KV.delete(k.name)));
        cleared += listed.keys.length;
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
      return json({ cleared }, 200, { "Cache-Control": "no-store" });
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
      if (res.status === 400) {
        // NWS's own signal for "this point isn't in our coverage area" —
        // {"title":"Invalid Parameter","detail":"Parameter \"point\" is
        // invalid: out of bounds"} — not a fetch failure, just nothing to
        // report here. Body is read defensively (a non-JSON 400 falls
        // through to the generic 502 below instead of throwing).
        let body = null;
        try { body = await res.json(); } catch (err) { /* fall through */ }
        if (body && /out of bounds/i.test(body.detail || "")) {
          return json({ alerts: [] }, 200, { "Cache-Control": "public, max-age=3600" });
        }
      }
      if (!res.ok) return json({ error: `NWS returned HTTP ${res.status}` }, 502);
      const data = await res.json();
      const alerts = (data.features || [])
        .map((f) => f.properties)
        .filter((p) => p?.event === "Severe Thunderstorm Warning" || p?.event === "Tornado Warning" || p?.event === "Flash Flood Warning")
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

// Strips combining diacritical marks and normalizes curly/smart apostrophes
// to a plain one before any name comparison in this file — see index.html's
// own copy of this function for the two confirmed real failures (a
// SmartPony quote for "Miguel Clément" silently missing tracked "Miguel
// Clement", and "Phil D'Amato" vs "Phil D’Amato" producing two separate
// tracked trainers for the same person) this fixes. Purely widening, never
// a source of a new false match.
// Removes apostrophes entirely (not just curly -> straight) rather than
// merely normalizing them — confirmed real that SmartPony's own
// race_entries.trainer field sometimes drops the apostrophe altogether
// ("DAMATO" vs our tracked "D'Amato"), a data inconsistency on their end
// this app has no control over. Comparison-key use only — never applied to
// a name that gets stored or displayed, just to the keys used to decide
// whether two spellings refer to the same person.
function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['‘’ʼʻ]/g, "");
}

// Trainers sort by last name — the last whitespace-separated token, which
// holds even for hyphenated last names ("Ramirez-Rodriguez" stays one
// token) and names with an unstripped leading initial ("W. Bret Calhoun"
// -> "Calhoun"). Strips a trailing generational suffix first (reusing
// hrnStripSuffix()) — confirmed real that tracked "Al Stall Jr." /
// "Saffie Joseph Jr." were reading "jr." as their own last name, since a
// bare last-whitespace-token split has no idea "Jr." isn't the surname,
// breaking every comparison against them.
function lastNameKey(fullName) {
  const parts = hrnStripSuffix(stripDiacritics(fullName.trim())).split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

// Direct port of index.html's TRAINER_FIRST_NAME_ALIASES / resolveTrackedTrainer().
// Needed here for the same reason: lastNameKey() alone can't tell apart two
// tracked trainers sharing a surname (confirmed real case: TDN's Saratoga
// Notebook calls him "Bill Mott", the tracked list has "William Mott", and
// a different tracked "Riley Mott" also exists).
const TRAINER_FIRST_NAME_ALIASES = {
  bill: "william", billy: "william", will: "william",
  bob: "robert", bobby: "robert", rob: "robert", robbie: "robert",
  dick: "richard", rich: "richard", richie: "richard",
  jim: "james", jimmy: "james",
  mike: "michael", mickey: "michael",
  tom: "thomas", tommy: "thomas",
  joe: "joseph", joey: "joseph",
  dan: "daniel", danny: "daniel",
  chris: "christopher",
  steve: "steven", stevie: "steven",
  ken: "kenneth", kenny: "kenneth",
  ted: "edward", eddie: "edward", ed: "edward",
  al: "albert", alex: "alexander",
  pat: "patrick",
  ron: "ronald", ronnie: "ronald",
  tony: "anthony",
  frank: "francis",
  larry: "lawrence",
  gene: "eugene",
  whit: "whitworth",
  shug: "claude", // Claude "Shug" McGaughey III — confirmed real duplicate (tracked separately as both names before this)
  phil: "philip", // Phil D'Amato — confirmed real: SmartPony's own "Philip Damato" spelling wasn't recognized as the same person, letting it keep re-splitting into a duplicate tracked entry
};
// Normalizes ONE name token — see index.html's normalizeNameToken() for why
// this checks every token of a tracked name, not just its own first token
// (handles "W. Bret Calhoun" tracked, source says "Bret Calhoun").
function normalizeNameToken(token) {
  const t = stripDiacritics(token).toLowerCase().replace(/\.$/, "");
  return TRAINER_FIRST_NAME_ALIASES[t] || t;
}
function firstNameKey(fullName) {
  return normalizeNameToken(fullName.trim().split(/\s+/)[0]);
}
// See index.html's resolveTrackedTrainer() for the full reasoning,
// including the confirmed real case (untracked British trainer "Clive Cox"
// silently matched to tracked US trainer "Brad Cox") that motivated
// checking first-name compatibility even when only one tracked trainer
// shares the surname, not just when there's more than one to pick between.
function resolveTrackedTrainer(sourceName, trackedList) {
  if (!sourceName) return null;
  const wantLast = lastNameKey(sourceName);
  const candidates = trackedList.filter((t) => lastNameKey(t) === wantLast);
  if (!candidates.length) return null;
  const parts = sourceName.trim().split(/\s+/);
  if (parts.length < 2) return candidates.length === 1 ? candidates[0] : null;
  const wantFirst = firstNameKey(sourceName);
  const firstNameMatches = candidates.filter((t) =>
    stripDiacritics(t).trim().split(/\s+/).some((tok) => normalizeNameToken(tok) === wantFirst));
  return firstNameMatches.length === 1 ? firstNameMatches[0] : null;
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

// One KV entry per track per exact day (same shape/reasoning as
// trackConditionsKvKey above, not weatherlog/biaslog's whole-array-per-
// track scheme) — a day's entries+results is a much bigger payload than a
// weather-log row, and there's no reason to read-modify-write an entire
// history array just to update today's snapshot.
function racedayKvKey(track, date) {
  const safeTrack = track.replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "invalid";
  return `raceday:${safeTrack}:${safeDate}`;
}

// Job #16's dedup record — one KV entry per horse per race, so a horse that
// stays entered across several cron runs (or gets rechecked on a later date
// as its card firms up) only ever triggers one email. TTL'd (see
// runEntryAlerts()) rather than kept forever, since once a date is long
// past there's no reason to keep remembering it was already notified.
function raceNotifyKvKey(track, date, raceNumber, horseName) {
  const safeTrack = track.replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "invalid";
  const safeHorse = (horseName || "").trim().toLowerCase().replace(/[^a-z0-9]/gi, "").slice(0, 60);
  return `racenotify:${safeTrack}:${safeDate}:${raceNumber}:${safeHorse}`;
}

async function readBiasLog(env, track) {
  const raw = await env.STABLE_KV.get(biasLogKvKey(track));
  const parsed = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [];
}

async function readState(env) {
  const [trainersRaw, notesRaw, trainerMetaRaw] = await Promise.all([
    env.STABLE_KV.get("trainers"),
    env.STABLE_KV.get("notes"),
    env.STABLE_KV.get("trainerMeta"),
  ]);
  return {
    trainers: trainersRaw ? JSON.parse(trainersRaw) : [],
    notes: notesRaw ? JSON.parse(notesRaw) : [],
    // name -> { source, addedAt } — how/where each tracked trainer was
    // added (manual add, or which auto-import source). Only ever set at
    // add time, never overwritten by a later re-add of the same name, so
    // it reflects genuine provenance rather than most-recent-touch.
    trainerMeta: trainerMetaRaw ? JSON.parse(trainerMetaRaw) : {},
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

  // Which turf course each numbered race actually runs on ("Turf Races:
  // Mellon: 1,5,8  Inner: 6,10") — rail-out distance is set per course, not
  // per card, so this is what lets the client attach the RIGHT course's
  // rail setting to a specific race instead of just listing both. Same
  // "label: value, value  label: value" shape the Turf: row above already
  // has, just with comma-separated race numbers instead of a single word.
  const turfRaceCourse = {};
  const turfRacesRaw = field("Turf Races");
  if (turfRacesRaw) {
    const re = /([A-Za-z]+):\s*([\d,\s]+)/g;
    let m;
    while ((m = re.exec(turfRacesRaw))) {
      const course = m[1];
      m[2].split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => { turfRaceCourse[n] = course; });
    }
  }

  // MISCELLANEOUS CHANGES table (equipment/gelding/etc. — race/program#/
  // horse/change, same 4-column shape as SCRATCHES and JOCKEY CHANGES on
  // this page). Scratches are NOT parsed from here — they already come
  // through the entries page's own SCR marker (see parseNyraRaceFragment()).
  const miscChanges = extractNyraChangeRows(html, "MISCELLANEOUS CHANGES");

  // JOCKEY CHANGES table — same 4-column shape, "change" here is the new
  // rider's name. Unlike miscChanges (shown as its own note strip),
  // this one is applied INTO the entries table itself, replacing the
  // stale jockey name on that horse's own row — see the client's
  // saratogaJockeyChange() for why: a rider swap is a correction to a
  // fact already shown per-horse, not a separate note, so it reads
  // better fixed at the source than bolted on alongside it.
  const jockeyChanges = extractNyraChangeRows(html, "JOCKEY CHANGES");

  const available = !!(dirtCondition || turfConditions.length || railSettings.length);
  return {
    available, provider: "nyra", cardDate, cardDateLabel, lastUpdatedLabel,
    dirtCondition, turfConditions, railSettings, turfRaceCourse, miscChanges, jockeyChanges,
  };
}

// Shared by parseNyraTrackConditions() for any of this page's 4-column
// "Race / Program # / Horse / Changes" tables (SCRATCHES has a 5th "Notes"
// column NYRA's own scratches table needs, which is why that one isn't
// routed through here — see parseNyraTrackConditions()'s own comment on
// why scratches aren't parsed from this page at all). A blank Race cell
// means "same race as the row above" (NYRA collapses repeated values the
// same way its SCRATCHES table does), so this carries the last seen race
// number forward rather than treating a blank as "no race".
function extractNyraChangeRows(html, sectionTitle) {
  const headerIdx = html.search(new RegExp(`>${sectionTitle}<`, "i"));
  if (headerIdx === -1) return [];
  const afterHeader = html.slice(headerIdx);
  const tableEndIdx = afterHeader.search(/<\/TABLE>/i);
  const chunk = tableEndIdx === -1 ? afterHeader : afterHeader.slice(0, tableEndIdx);

  const rowMatches = Array.from(chunk.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi));
  const rows = [];
  let lastRaceNumber = null;
  // Skip the first row only: chunk starts mid-way through the colored
  // section-title bar's own <TR> (headerIdx lands on the title TEXT, which
  // sits inside that row's <TD><Font><B>, not at the row's opening <TR>
  // tag), so the title bar's row never forms a complete <TR>...</TR> match
  // here at all — index 0 is already the column header row (Race/Program
  // #/Horse/Changes), and real data starts at index 1.
  for (let i = 1; i < rowMatches.length; i++) {
    const cells = Array.from(rowMatches[i][1].matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((c) => cleanCell(c[1]));
    if (cells.length < 4) continue;
    const [raceCell, programNumber, horseName, change] = cells;
    if (raceCell) lastRaceNumber = raceCell;
    if (!lastRaceNumber || !horseName || !change) continue;
    rows.push({ raceNumber: Number(lastRaceNumber), programNumber: programNumber || null, horseName, change });
  }
  return rows;
}

// Maps TurfTrax's WDV API Stream "content" block (same stream shape job
// #12 already parses for Ascot's weather sensor, but this reads its going-
// report fields instead) onto the same shape parseNyraTrackConditions()
// above returns, so the client's existing turf-tile rendering needs zero
// changes to consume either source. Deliberately doesn't parse rail-report/
// stick-report — see job #9's comment for why those are left to the
// client's link-out card instead. "Good to Soft\r\nWhole course terra
// spiked since last meeting" -> condition is just the first line; the rest
// is course-staff commentary this shape has nowhere structured to put.
// Some courses report a compound reading on that first line too (Newmarket,
// verified directly: "Good to Firm, Good (in places)" — different parts of
// the course going differently) — only the primary clause before the first
// comma is taken as the tile's single condition value, same reasoning as
// dropping the trailing commentary: there's no structured place to put the
// qualifier, and a shorter clean BHA term is what the tile's small space
// and the color-class lookup both expect.
function parseTurftraxGoingReport(payload, courseLabel) {
  const c = payload.content || {};
  const goingLines = (c["going-report"] || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const condition = goingLines[0] ? goingLines[0].split(",")[0].trim().toUpperCase() : null;
  if (!condition) return { available: false, provider: "turftrax" };

  // "Thursday, 20th August, 2026" -> "2026-08-20"
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const dateMatch = (c["going-race-date"] || "").match(/(\d{1,2})\w*\s+([a-z]+),?\s+(\d{4})/i);
  const cardDate = dateMatch && MONTHS[dateMatch[2].toLowerCase()]
    ? `${dateMatch[3]}-${String(MONTHS[dateMatch[2].toLowerCase()]).padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`
    : null;

  // "Thursday, 20th August, 2026 at 8:45 am" -> "8:45 am"
  const updatedMatch = (c["going-report-date"] || "").match(/at\s+([\d:]+\s*[ap]m)/i);
  const lastUpdatedLabel = updatedMatch ? updatedMatch[1] : null;

  return {
    available: true,
    provider: "turftrax",
    cardDate,
    cardDateLabel: c["going-race-date"] || null,
    lastUpdatedLabel,
    dirtCondition: null,
    turfConditions: [{ course: courseLabel, condition }],
    railSettings: [],
  };
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
// parallel. Saratoga is fully verified end-to-end. Belmont was briefly
// wired in on the same URL shape (nyra.com/belmont/rdl/race/...) for job
// #16's entry alerts on the theory that a dark meet would just 200 with no
// parseable race — WRONG, confirmed directly: while Belmont's meet is dark,
// nyra.com/belmont/rdl/race/ doesn't 200-with-nothing, it silently serves
// SARATOGA's actual live card (same race names, same horses, verified
// side-by-side) instead of an empty/no-meet response. That's not a safe
// no-op, it's duplicate processing under the wrong track's name — job #16
// was double-counting every Saratoga horse as if it were also entered at
// Belmont. Reverted; re-add only after fetching and verifying a REAL
// Belmont race card once that meet reopens (Sept 18, 2026), same rule as
// every other track source in this file, no exceptions this time.
const NYRA_ENTRIES_BASE = { saratoga: "https://www.nyra.com/saratoga" };

// Maps a track id to which entries scraper handles it — checked before
// either fetchNyraEntriesDay() or fetchDmtcEntriesDay() runs. Add a track
// here only once its source has actually been fetched and its markup
// verified (same rule as every other scrape in this file) — see
// NYRA_ENTRIES_BASE's own comment on why belmont briefly being a declared
// exception to that rule was a real bug, not a harmless shortcut.
const ENTRIES_SOURCE_BY_TRACK = {
  saratoga: "nyra", delmar: "dmtc", monmouth: "monmouth",
  york: "sportinglife", ascot: "sportinglife", epsomdowns: "sportinglife", newmarket: "sportinglife",
  curragh: "sportinglife", longchamp: "sportinglife",
  shatin: "sportinglife", happyvalley: "sportinglife", meydan: "sportinglife",
};

// Tracks job #16's entry alerts actually scans — a deliberate subset of
// ENTRIES_SOURCE_BY_TRACK above (that map stays as-is for the Entries tab,
// which is fine showing every track it supports for manual browsing).
// Confirmed real ask 2026-08-26: alerts should stay focused on the US
// tracks that matter here, not fire on every international/UK track the
// Entries tab happens to support. Belmont deliberately isn't in this list
// yet — see NYRA_ENTRIES_BASE's own comment on why it can't be safely
// added while its meet is dark (silently serves Saratoga's card mislabeled
// as Belmont, not a safe no-op); re-add once that meet reopens Sept 18,
// 2026 and its real markup is verified fresh. Keeneland, Churchill, and
// Santa Anita aren't here either because none of them have an entries
// scraper built anywhere in this file yet — that's real future work
// (finding each track's live entries page and verifying its markup, same
// as every other source here), not a one-line addition.
const ALERT_TRACKS = ["saratoga", "delmar"];

// Same idea as ENTRIES_SOURCE_BY_TRACK, for the /results route — separate
// map (not reused from ENTRIES_SOURCE_BY_TRACK) because a track can have
// entries wired up before its results page has actually been verified, or
// vice versa; the two shouldn't silently move in lockstep.
const RESULTS_SOURCE_BY_TRACK = {
  saratoga: "nyra", delmar: "dmtc",
  york: "sportinglife", ascot: "sportinglife", epsomdowns: "sportinglife", newmarket: "sportinglife",
  curragh: "sportinglife", longchamp: "sportinglife",
  shatin: "sportinglife", happyvalley: "sportinglife", meydan: "sportinglife",
};

// Same idea again, for the /changes route (DMTC's free-text race-notes
// feed — see parseDmtcChanges()'s own file-level comment). No NYRA
// equivalent exists yet, so this only has Del Mar for now.
const CHANGES_SOURCE_BY_TRACK = { delmar: "dmtc" };

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

  // A named race (stakes, and only stakes — verified directly: a Maiden
  // Special Weight/Allowance/Claiming race has this exact same header
  // element present but empty) gets its proper name here, e.g. "Mahony
  // Stakes (G3)" — otherwise raceType above is stuck at the bare category
  // word "Stakes" with no way to tell one from another.
  const nameMatch = html.match(/<header class="font-semibold text-lg lg:text-xl text-black dark:text-white mb-2">\s*([^<]*?)\s*<\/header>/);
  const raceName = nameMatch ? (decodeEntities(nameMatch[1]).trim() || null) : null;

  const distMatch = html.match(/title="([^"]+)">([^<]+)<\/div>\s*<div class="text-zinc-800 dark:text-white">\s*([\s\S]*?)\s*<\/div>/);
  const distanceLabel = distMatch ? decodeEntities(distMatch[2]).trim() : null;
  const surface = distMatch ? decodeEntities(distMatch[3]).trim() : null;

  // The "Owners" strip at the bottom of the fragment keys owner names by
  // post position (the same number shown on each horse's saddle-N block),
  // not by horse name — verified directly against a real 7-horse race
  // where the 7 numbered owners lined up 1:1 with the 7 saddle numbers in
  // the same document order. Scoped to end at the next section label (same
  // "text-sm uppercase tracking-wider mb-1" class both "Owners" and
  // "Breeders" use) rather than hardcoding ">Breeders<" specifically — a
  // fragment variant that omits/reorders that section would otherwise let
  // this fall through to end-of-document and pick up unrelated
  // "<strong>N</strong> - text" shaped content from elsewhere on the page.
  const owners = {};
  const ownersStart = html.indexOf(">Owners<");
  if (ownersStart !== -1) {
    const ownersEnd = html.indexOf('class="text-sm uppercase tracking-wider mb-1"', ownersStart + 8);
    const ownersSection = ownersEnd === -1 ? html.slice(ownersStart) : html.slice(ownersStart, ownersEnd);
    for (const om of ownersSection.matchAll(/<strong>([^<]+)<\/strong>\s*-\s*([\s\S]*?)<\/div>/g)) {
      const pp = decodeEntities(om[1]).trim();
      const name = decodeEntities(om[2]).replace(/\s+/g, " ").trim();
      if (pp && name) owners[pp] = name;
    }
  }

  const horses = [];
  const horseRe = /<div class="order-3 flex-1 leading-none"><div class="font-semibold text-lg lg:text-2xl -mt-1 mb-1 leading-tight blend-links"><a href="[^"]*"[^>]*>\s*([^<]+?)\s*<\/a><\/div><div class="text-zinc-800 dark:text-white">([^<]*)<\/div><div class="text-zinc-800 dark:text-white mt-1 text-xs lg:text-sm">([^<]*)<\/div><\/div><div class="order-1[^"]*"><div class="[^"]*">\s*([^<]*?)\s*<\/div><\/div><div class="order-5[^"]*"><div class="[^"]*" title="Current Odds">([^<]*)<\/div><div class="[^"]*" title="Morning Line Odds">\s*ML\s*([^<]*)<\/div>/g;
  let m;
  while ((m = horseRe.exec(html))) {
    const [, nameRaw, jockeyTrainerRaw, weightRaw, postRaw, currentOddsRaw, mlOddsRaw] = m;
    const [jockeyRaw, trainerRaw] = jockeyTrainerRaw.split("&bull;");
    const [weightRawPart, medicationRaw, ageSexRaw] = weightRaw.split("&bull;");
    const currentOdds = decodeEntities(currentOddsRaw).trim();
    const scratched = currentOdds.toUpperCase() === "SCR";
    const postPosition = decodeEntities(postRaw).trim() || null;
    horses.push({
      postPosition,
      name: decodeEntities(nameRaw).trim(),
      jockey: jockeyRaw ? decodeEntities(jockeyRaw).trim() : null,
      trainer: trainerRaw ? decodeEntities(trainerRaw).trim() : null,
      owner: postPosition ? (owners[postPosition] || null) : null,
      weight: weightRawPart ? decodeEntities(weightRawPart).trim() : null,
      medication: medicationRaw ? decodeEntities(medicationRaw).trim() : null,
      ageSex: ageSexRaw ? decodeEntities(ageSexRaw).trim() : null,
      scratched,
      currentOdds: scratched ? null : (currentOdds || null),
      mlOdds: decodeEntities(mlOddsRaw).trim() || null,
    });
  }

  return { raceNumber, postTimeIso, mtpLabel, purse, raceType, raceName, distanceLabel, surface, horses };
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
// Source verified directly: dmtc.com's whole-card entries page is one plain
// server-rendered HTML page with every race inline — no fragment endpoint,
// no per-race requests.
// CORRECTED 2026-08-26 — confirmed real bug in the original version of this
// comment: it claimed the entries page "has no date parameter," fetching
// only the undated https://www.dmtc.com/racing/entries (always whichever
// day is currently open) and discarding any request for a different date
// as empty. That was wrong — DMTC's own page has working next/previous-day
// links to a real dated path, /racing/entries/YYYY-MM-DD, confirmed
// directly to return that exact day's real card (verified 3 days out,
// including a Saturday with a full 10-race card) — the bug meant every
// future-date request silently came back "no races" even when DMTC had
// already posted real entries for it, exactly like NYRA's Saratoga does.
// Fixed by building the URL per-date instead of always hitting the base
// path; everything else about this parser (markup shape, silk-row regex,
// scratch handling) was already correct and needed no changes.
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
const DMTC_ENTRIES_URL_BASE = "https://www.dmtc.com/racing/entries";

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
  // Fetches the requested date's own page directly (see DMTC_ENTRIES_URL_BASE's
  // comment for why this used to always hit the undated base path instead).
  // parseDmtcEntries() still cross-checks the returned page's own embedded
  // date against `date` and returns no races on a mismatch — kept as a
  // defensive check, not because it's expected to fire now, in case DMTC's
  // dated URLs ever redirect to a fallback day instead of 404ing.
  const res = await fetch(`${DMTC_ENTRIES_URL_BASE}/${date}`, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`DMTC returned HTTP ${res.status}`);
  const html = await res.text();
  return parseDmtcEntries(html, date);
}

// ---------- Del Mar (DMTC) Results parser ----------
// Source verified directly: unlike the entries page, dmtc.com/racing/results
// DOES take a date in the URL (/racing/results/YYYY-MM-DD) and serves that
// exact day rather than always whichever card is currently open, so this
// fetches the specific requested date instead of the "fetch once, verify,
// discard if wrong day" pattern parseDmtcEntries() needs. A day with no
// results yet (race not run, or a dark day) renders no per-race panels at
// all — same "table's presence IS the isFinal signal" rule
// parseNyraResultsFragment() uses, not a guess based on scheduled post time.
// Each race panel is plain, unique-enough markup (<div title="Race N
// Results">) to split on directly, same as the entries page's own
// per-race chunks. Only the top 3 finishers get a table row (DMTC's own
// UI choice) — the rest of the field is a flat "ALSO RAN" name list with no
// per-horse finish position, and NYRA's shape has no equivalent field for
// that, so it's carried as its own alsoRan array rather than forced into
// fake finishOrder entries. SCRATCHED here (unlike the entries page's own
// "Name - Reason" format) is just a bare name list — this is the SAME
// physical scratch as what the entries page already shows inline via SCR
// tags, just DMTC's results page repeating it without a reason, so it's
// carried through as-is rather than being reconciled against entries data.
const DMTC_RESULTS_URL_BASE = "https://www.dmtc.com/racing/results";

function dmtcResultsCardDate(html) {
  // <meta name="description" content="Del Mar race results for Thursday,
  // August 20th, 2026. ...">
  const m = html.match(/race results for (\w+),\s*(\w+)\s+(\d{1,2})\w{0,2},\s*(\d{4})/i);
  if (!m) return null;
  const month = NYRA_MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[4]}-${String(month).padStart(2, "0")}-${String(parseInt(m[3], 10)).padStart(2, "0")}`;
}

function parseDmtcResultsRaceChunk(chunk) {
  const headerMatch = chunk.match(/<div title="Race (\d+) Results">/);
  if (!headerMatch) return null;
  const raceNumber = Number(headerMatch[1]);

  const condMatch = chunk.match(/<div class="bold text-muted-dark">([\s\S]*?)<\/div>/);
  let surface = null, distanceLabel = null, raceType = null, purse = null;
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
  }

  const finishOrder = [];
  // Post position captured directly off the silk div's own class (e.g.
  // "silk7"), not its padded text content — group 1 below.
  const rowRe = /<div class="silk silk silk(\d+)">\s*\d+\s*<\/div>[\s\S]*?<div class="bigger"><strong>([^<]+)<\/strong><\/div>[\s\S]*?<td class="hidden-xs vertical-center">\s*([^<]*?)\s*<\/td>\s*<td class="hidden-xs vertical-center">\s*([^<]*?)\s*<\/td>\s*<td class="vertical-center text-right">\s*<div class="bigger">([^<]*)<\/div>\s*<\/td>\s*<td class="vertical-center text-right">\s*<div class="bigger">([^<]*)<\/div>\s*<\/td>\s*<td class="vertical-center text-right">\s*<div class="bigger">([^<]*)<\/div>\s*<\/td>/g;
  let m;
  let position = 0;
  while ((m = rowRe.exec(chunk))) {
    position += 1;
    const [, postPosition, nameRaw, jockeyRaw, trainerRaw, winRaw, placeRaw, showRaw] = m;
    finishOrder.push({
      finishPosition: position,
      postPosition: postPosition || null,
      horseName: decodeEntities(nameRaw).trim(),
      jockey: decodeEntities(jockeyRaw).trim() || null,
      trainer: decodeEntities(trainerRaw).trim() || null,
      winPayout: decodeEntities(winRaw).trim() || null,
      placePayout: decodeEntities(placeRaw).trim() || null,
      showPayout: decodeEntities(showRaw).trim() || null,
    });
  }

  const alsoRan = [];
  const alsoRanMatch = chunk.match(/ALSO RAN:\s*<\/strong>&nbsp;\s*([\s\S]*?)\s*<\/div>/);
  if (alsoRanMatch) {
    decodeEntities(alsoRanMatch[1]).replace(/\s+/g, " ").trim().split(",").forEach((s) => {
      const name = s.trim();
      if (name) alsoRan.push(name);
    });
  }

  const scratched = [];
  const scrMatch = chunk.match(/SCRATCHED:\s*<\/strong>&nbsp;\s*([\s\S]*?)\s*<\/div>/);
  if (scrMatch) {
    decodeEntities(scrMatch[1]).replace(/\s+/g, " ").trim().split(",").forEach((s) => {
      const name = s.trim();
      if (name) scratched.push(name);
    });
  }

  const payouts = [];
  const payoffsMatch = chunk.match(/PAYOFFS:\s*<\/strong>\s*([\s\S]*?)\s*<\/div>/);
  if (payoffsMatch) {
    const text = decodeEntities(payoffsMatch[1]).replace(/\s+/g, " ").trim();
    const payoutRe = /\$([\d.]+)\s+([A-Za-z][A-Za-z ]*?)\s+paid\s+(\$[\d,.]+)\s+\(([^)]+)\)/g;
    let pom;
    while ((pom = payoutRe.exec(text))) {
      const [, wagerAmount, wagerTypeRaw, payout, comboRaw] = pom;
      payouts.push({
        wagerAmount: `$${wagerAmount}`,
        wagerType: wagerTypeRaw.trim(),
        winningCombo: comboRaw.trim(),
        payout,
      });
    }
  }

  return {
    raceNumber, surface, distanceLabel, raceType, purse,
    isFinal: finishOrder.length > 0, finishOrder, alsoRan, scratched, payouts,
  };
}

function parseDmtcResults(html, date) {
  const cardDate = dmtcResultsCardDate(html);
  if (!cardDate || cardDate !== date) return { date, races: [] }; // wrong day (dark, or DMTC redirected) — nothing to show
  const chunks = html.split(/(?=<div title="Race \d+ Results">)/).filter((c) => /^<div title="Race \d+ Results">/.test(c));
  const races = chunks.map(parseDmtcResultsRaceChunk).filter(Boolean);
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { date, races };
}

async function fetchDmtcResultsDay(date) {
  const res = await fetch(`${DMTC_RESULTS_URL_BASE}/${date}`, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 90, cacheEverything: true }, // short — a race can go final mid-poll-interval, same as NYRA results
  });
  if (!res.ok) throw new Error(`DMTC returned HTTP ${res.status}`);
  const html = await res.text();
  return parseDmtcResults(html, date);
}

// ---------- Del Mar (DMTC) Changes/Scratches parser ----------
// Source verified directly: dmtc.com/racing/changes is DMTC's own page for
// Equibase's "Changes & Scratches" feed — plain free-text notes per race
// (temp rail distance, gelding reports, equipment/jockey changes, and
// occasionally scratches) rather than the structured entries/results
// tables above. No dated URL variant found here (unlike the entries page,
// which DOES have one — see DMTC_ENTRIES_URL_BASE's own note — this page
// wasn't re-checked for the same next/previous-day links, so treat "always
// shows today's card" as this page's own unverified-further limitation,
// not something carried over from entries). Each race's
// note is carried as one opaque string — this page mixes several unrelated
// note types in the same freeform sentence with no consistent sub-format to
// parse further, so this deliberately doesn't try to classify or split them;
// the client just displays whatever text DMTC published for that race.
const DMTC_CHANGES_URL = "https://www.dmtc.com/racing/changes";

function dmtcChangesCardDate(html) {
  // <meta name="description" content="Late jockey changes and scratches at
  // Del Mar for Friday, August 21st, 2026.">
  const m = html.match(/for (\w+),\s*(\w+)\s+(\d{1,2})\w{0,2},\s*(\d{4})/i);
  if (!m) return null;
  const month = NYRA_MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[4]}-${String(month).padStart(2, "0")}-${String(parseInt(m[3], 10)).padStart(2, "0")}`;
}

function parseDmtcChanges(html, date) {
  const cardDate = dmtcChangesCardDate(html);
  if (!cardDate || cardDate !== date) return { date, postedLabel: null, notes: [] };

  const postedMatch = html.match(/posted at ([^<]+)</);
  const postedLabel = postedMatch ? decodeEntities(postedMatch[1]).trim() : null;

  const notes = [];
  const noteRe = /<h3 class="panel-title">Race (\d+)<\/h3><\/div>\s*<div class="panel-body">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = noteRe.exec(html))) {
    const raceNumber = Number(m[1]);
    const note = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (note) notes.push({ raceNumber, note });
  }
  notes.sort((a, b) => a.raceNumber - b.raceNumber);
  return { date, postedLabel, notes };
}

async function fetchDmtcChangesDay(date) {
  const res = await fetch(DMTC_CHANGES_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`DMTC returned HTTP ${res.status}`);
  const html = await res.text();
  return parseDmtcChanges(html, date);
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

// ---------- Sporting Life entries parser (York) ----------
// Verified directly: Sporting Life's racecard pages are server-rendered
// Next.js pages — the full page's data (race times, purses, every runner's
// name/jockey/trainer/weight/odds) ships as a single JSON blob in a
// <script id="__NEXT_DATA__"> tag, confirmed present with a plain fetch, no
// browser/JS execution needed. robots.txt doesn't restrict these paths, and
// unlike Racing Post/At The Races, Sporting Life isn't itself a betting
// operator — Sky Sports-owned racing/sports media, the closest UK
// equivalent to how the US sources here are each the track/circuit's own
// direct-from-the-source page rather than a bookmaker's.
//
// Two-step lookup, both plain JSON, no HTML tag scraping:
//  1. GET /racing/racecards/<date> lists every UK/Ireland/US meeting
//     running that day with each course's own numeric "meeting ID" — used
//     to find the requested track's meeting ID for that date.
//  2. GET /racing/fast-cards/<meetingId>/<date>/<course-slug> returns the
//     WHOLE day's card in one request — every race, every runner — rather
//     than needing one request per race the way NYRA's own site does. The
//     course-slug path segment is decorative (verified: an intentionally
//     wrong slug still 200s), only the meeting ID is actually load-bearing.
//
// Future dates only resolve once Sporting Life has actually published that
// day's declarations (typically the day before racing) — until then their
// own site silently serves today's meetings list instead of 404ing.
// Guarded the same way the York TurfTrax going-report work handles an
// equivalent "site rolled to a different day than what was asked for"
// case: the requested date is compared against the date actually found on
// the matching meeting, and a mismatch is treated as "not published yet"
// (empty races), never as that day's real card under the wrong label.
// Course name is the load-bearing half of this pair — it's matched
// verbatim against Sporting Life's own `course.name` field, so it has to
// be exact (verified directly per track, not guessed: "ParisLongchamp" is
// one word/no space, "Epsom Downs"/"Sha Tin"/"Happy Valley" do have
// spaces). Slug is decorative (see the comment above) so these are just
// reasonable lowercase-hyphenated guesses, unverified and low-risk if
// wrong.
const SPORTINGLIFE_COURSE_NAME_BY_TRACK = {
  york: "York", ascot: "Ascot", epsomdowns: "Epsom Downs", newmarket: "Newmarket",
  curragh: "Curragh", longchamp: "ParisLongchamp",
  shatin: "Sha Tin", happyvalley: "Happy Valley", meydan: "Meydan",
};
const SPORTINGLIFE_COURSE_SLUG_BY_TRACK = {
  york: "york", ascot: "ascot", epsomdowns: "epsom-downs", newmarket: "newmarket",
  curragh: "curragh", longchamp: "paris-longchamp",
  shatin: "sha-tin", happyvalley: "happy-valley", meydan: "meydan",
};
async function sportingLifeFetchJson(path) {
  const res = await fetch(`https://www.sportinglife.com${path}`, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Sporting Life returned HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Sporting Life page didn't contain the expected data script");
  return JSON.parse(m[1]);
}

// Sums every listed finishing position's prize money — the closest
// available proxy for a "total purse" figure (matching how NYRA's own
// purse field is shown), though it may run slightly under the full
// advertised purse if a race also carries unlisted prize-money supplements
// not broken out by position.
function sportingLifeFormatPurse(prizes) {
  const list = prizes?.prize;
  if (!Array.isArray(list) || !list.length) return null;
  const total = list.reduce((sum, p) => {
    const n = parseFloat(p.prize);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  return total ? `£${Math.round(total).toLocaleString("en-GB")}` : null;
}

// UK racing has no "morning line" equivalent to pair with a live current-
// price the way US pari-mutuel racing does — mlOdds is left null rather
// than duplicating current_odds into both columns (see the plan this was
// built from). "9-9" (stone-lbs) weight format is passed through as-is,
// the standard way British racing media already presents it, not
// converted to lbs-only.
function sportingLifeMapRace(raceEntry, date, surface){
  const rs = raceEntry.race_summary || {};
  const horses = (raceEntry.rides || []).map((ride) => {
    const isRunner = ride.ride_status === "RUNNER";
    return {
      postPosition: ride.draw_number != null ? String(ride.draw_number) : null,
      name: ride.horse?.name || null,
      // A withdrawn ride's jockey.name is literally the string "Non Runner"
      // in Sporting Life's own data (verified directly against real
      // scratches), not null/omitted — suppressed here the same way
      // currentOdds already is below, rather than showing that placeholder
      // as if it were a real jockey name next to the SCR tag.
      jockey: isRunner ? (ride.jockey?.name || null) : null,
      trainer: ride.trainer?.name || null,
      weight: ride.handicap || null,
      medication: null,
      ageSex: ride.horse?.age != null ? `${ride.horse.age}yo` : null,
      scratched: !isRunner,
      currentOdds: isRunner ? (ride.betting?.current_odds || null) : null,
      mlOdds: null,
    };
  });
  // Sporting Life's own `rides` array isn't in post-position order (nor
  // odds order, nor anything obviously meaningful — verified directly:
  // draws came back as 1,2,7,6,3,9,8,4,5 for a real race) — every other
  // source's own entries page already lists horses by post position, so
  // this sorts to match instead of showing Sporting Life's raw order.
  horses.sort((a, b) => {
    const pa = a.postPosition != null ? Number(a.postPosition) : Infinity;
    const pb = b.postPosition != null ? Number(b.postPosition) : Infinity;
    return pa - pb;
  });
  return {
    postTimeIso: rs.time ? `${date}T${rs.time}` : null,
    mtpLabel: null,
    purse: sportingLifeFormatPurse(raceEntry.prizes),
    raceType: rs.race_class ? `Class ${rs.race_class}` : null,
    distanceLabel: rs.distance || null,
    surface,
    horses,
  };
}

async function fetchSportingLifeEntriesDay(track, date) {
  const courseName = SPORTINGLIFE_COURSE_NAME_BY_TRACK[track];
  const courseSlug = SPORTINGLIFE_COURSE_SLUG_BY_TRACK[track];
  if (!courseName) throw new Error("Not supported for this track");

  const listing = await sportingLifeFetchJson(`/racing/racecards/${date}`);
  const meetings = listing?.props?.pageProps?.meetings || [];
  const meeting = meetings.find((m) => m.meeting_summary?.course?.name === courseName);
  if (!meeting || meeting.meeting_summary.date !== date) {
    // Either this course isn't running that day, or (for a future date)
    // Sporting Life hasn't published it yet — both are a genuine "nothing
    // to show", not an error.
    return { date, races: [] };
  }

  const meetingId = meeting.meeting_summary.meeting_reference.id;
  const surface = meeting.meeting_summary.surface_summary || null;

  const card = await sportingLifeFetchJson(`/racing/fast-cards/${meetingId}/${date}/${courseSlug}`);
  const races = card?.props?.pageProps?.meeting?.races || [];
  const mapped = races
    .map((r) => sportingLifeMapRace(r, date, surface))
    .sort((a, b) => (a.postTimeIso || "").localeCompare(b.postTimeIso || ""))
    .map((r, i) => ({ raceNumber: i + 1, ...r }));

  return { date, races: mapped };
}

// ---------- Sporting Life results parser ----------
// Same 9 tracks as fetchSportingLifeEntriesDay() above, verified directly
// against real completed cards (York, 2026-08-22). Two-step lookup again,
// but through the *results* endpoints, not racecards — /racing/racecards/
// <date> silently redirects to today's card for any other date (verified:
// a past-date request 307s to the bare /racing/racecards path), so past
// dates need /racing/results/<date> instead, which serves real historical
// listings. That listing gives each race's id/time/race_stage but no
// finish order or payouts — those need one more fetch per race, at
// /racing/results/<date>/<any-course-slug>/<raceId>/<any-name-slug> (both
// slugs are decorative, exactly like fast-cards' course-slug — verified
// directly: a request with deliberately wrong slugs for both still 200s).
// Only fetched for races that have actually run (see
// SPORTINGLIFE_FINAL_STAGES) — no point spending a request per race on a
// card that hasn't run yet, since it'd come back with an empty result
// anyway.
//
// race_stage values seen on a real live day's meetings (Deauville/Woodbine,
// 2026-08-23): DORMANT and GOINGDOWN before a race runs, then RESULT
// (result posted) and WEIGHEDIN (formally official) once it has — both of
// those last two are treated as final here, same as how NYRA's own
// isFinal is "does a finish table exist" rather than a guess off scheduled
// post time.
const SPORTINGLIFE_FINAL_STAGES = new Set(["RESULT", "WEIGHEDIN"]);

// UK tote payouts come back as bare "10.5 GBP"/"2.9 GBP,3.0 GBP,2.1 GBP"
// strings, not pre-formatted currency — this both parses and formats them
// to match the £-prefixed style used everywhere else results are shown.
function sportingLifePoundAmount(raw) {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? `£${n.toFixed(2)}` : null;
}

// UK racing has no US-style separate win/place/show tiers — a tote place
// dividend applies to however many places actually paid (number_of_placed_
// rides, usually 2-4 depending on field size), not a fixed top-3. Mapped
// onto this app's existing finishOrder shape as best fits: the winner's own
// tote_win becomes winPayout, and each placed finisher (by position, not
// just top 3) gets its own placePayout off the comma-separated place_win
// list — showPayout is left null throughout since that specific three-way
// US split has no real UK equivalent.
function sportingLifeMapResultRace(raceDetail, raceNumber){
  const placeValues = (raceDetail.place_win || "").split(",").map((s) => s.trim()).filter(Boolean);
  const finishOrder = (raceDetail.rides || [])
    // A non-runner carries finish_position: 0, not null — checking
    // ride_status (same "RUNNER" check fetchSportingLifeEntriesDay's own
    // isRunner uses) is what actually excludes them; a bare != null check
    // let them sort to the front of the field as fake "0th place" finishers.
    .filter((r) => r.ride_status === "RUNNER" && r.finish_position != null)
    .sort((a, b) => a.finish_position - b.finish_position)
    .map((r) => ({
      finishPosition: r.finish_position,
      postPosition: r.draw_number != null ? String(r.draw_number) : null,
      horseName: r.horse?.name || null,
      winPayout: r.finish_position === 1 ? sportingLifePoundAmount(raceDetail.tote_win) : null,
      placePayout: sportingLifePoundAmount(placeValues[r.finish_position - 1]),
      showPayout: null,
    }));
  const payouts = [];
  const addPayout = (wagerType, raw) => {
    const amount = sportingLifePoundAmount(raw);
    if (amount) payouts.push({ wagerAmount: null, wagerType, winningCombo: null, payout: amount });
  };
  addPayout("Exacta", raceDetail.exacta_win);
  addPayout("Trifecta", raceDetail.trifecta);
  addPayout("Tricast", raceDetail.tricast);
  addPayout("Straight Forecast", raceDetail.straight_forecast);
  return { raceNumber, isFinal: finishOrder.length > 0, finishOrder, payouts };
}

async function fetchSportingLifeResultsDay(track, date) {
  const courseName = SPORTINGLIFE_COURSE_NAME_BY_TRACK[track];
  if (!courseName) throw new Error("Not supported for this track");

  const listing = await sportingLifeFetchJson(`/racing/results/${date}`);
  const meetings = listing?.props?.pageProps?.meetings || [];
  const meeting = meetings.find((m) => m.meeting_summary?.course?.name === courseName);
  if (!meeting || meeting.meeting_summary.date !== date) {
    return { date, races: [] }; // course didn't run this day — a real "nothing to show", not an error
  }

  // Same post-time sort + 1-based renumbering as fetchSportingLifeEntriesDay
  // — the two are fetched from different Sporting Life endpoints but cover
  // the identical physical card, so numbering them the same way is what
  // lets the client match an entries race to its result by raceNumber.
  const races = (meeting.races || [])
    .slice()
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
    .map((r, i) => ({ ...r, raceNumber: i + 1 }));

  const results = await Promise.all(races.map(async (r) => {
    const notYetRun = { raceNumber: r.raceNumber, isFinal: false, finishOrder: [], payouts: [] };
    if (!SPORTINGLIFE_FINAL_STAGES.has(r.race_stage)) return notYetRun;
    const raceId = r.race_summary_reference?.id;
    if (!raceId) return notYetRun;
    try {
      const detail = await sportingLifeFetchJson(`/racing/results/${date}/x/${raceId}/x`);
      const raceDetail = detail?.props?.pageProps?.race;
      return raceDetail ? sportingLifeMapResultRace(raceDetail, r.raceNumber) : notYetRun;
    } catch (err) {
      return notYetRun; // one race's detail fetch failing shouldn't fail the whole day
    }
  }));

  return { date, races: results };
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

// ---------- Job #16: tracked-horse entry alert emails ----------

// America/New_York "today," same Intl.DateTimeFormat-parts approach as
// londonNowParts() above (job #12) — Saratoga and Belmont are both this one
// timezone, so no per-track lookup is needed the way the client's
// activeTrack.timezone is.
function nyNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Only today's card — race-day alerts, not a lookahead. See
// runEntryAlerts()'s own comment for why this replaced a 7-day window.
function entryAlertTodayDate() {
  const { year, month, day } = nyNowParts();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Direct port of index.html's findHorseStableNotes() — trainer match reuses
// this file's own lastNameKey() (same forgiving last-name-only comparison,
// for the same reason: Entries' trainer field comes from NYRA's own scraped
// text, not guaranteed to string-match a tracked trainer's free-typed name
// exactly). Horse name match stays exact (case/whitespace-insensitive only).
//
// A note saved with no trainer (manual "trainer not known/might change" —
// see /notes POST) always matches by horse name alone, regardless of what
// horse.trainer says — that's the whole point of leaving it blank, so the
// note stays valid even if the horse switches barns before it runs. Those
// bypass the same-surname disambiguation entirely since there's no trainer
// to disambiguate against.
function notesForHorse(notes, trainer, horseName) {
  if (!horseName) return [];
  const wantHorse = horseName.trim().toLowerCase();
  const horseMatches = notes.filter((n) => n.horse && n.horse.trim().toLowerCase() === wantHorse);
  const untracked = horseMatches.filter((n) => !n.trainer);
  let matchedTracked = [];
  if (trainer) {
    const wantTrainer = lastNameKey(trainer);
    const candidates = horseMatches.filter((n) => n.trainer && lastNameKey(n.trainer) === wantTrainer);
    const distinctTrainers = [...new Set(candidates.map((n) => n.trainer))];
    if (distinctTrainers.length > 1) {
      // This exact horse name has notes filed under more than one
      // same-surname trainer — narrow to whichever one the day's entry row
      // actually agrees with (see resolveTrackedTrainer() above) instead of
      // emailing another trainer's notes for this horse.
      const resolved = resolveTrackedTrainer(trainer, distinctTrainers);
      matchedTracked = resolved ? candidates.filter((n) => n.trainer === resolved) : [];
    } else {
      matchedTracked = candidates;
    }
  }
  return [...untracked, ...matchedTracked]
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.capturedAt || "").localeCompare(a.capturedAt || ""));
}

// "1:51 PM" from NYRA's raw post-time string — same logic as
// formatPostTimeLabel() in index.html, ported here since the worker has no
// access to client-side functions.
function formatPostTimeLabelServer(iso) {
  const m = iso && iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]} ${ampm}`;
}

function escapeHtmlForEmail(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const NYRA_TRACK_LABEL = { saratoga: "Saratoga", belmont: "Belmont" };

// Display names for every track runEntryAlerts() now scans (all of
// ENTRIES_SOURCE_BY_TRACK, not just NYRA's) — the digest email's subject
// and header need a clean label the same way the client's track dropdown
// does, and this file otherwise only has NYRA_TRACK_LABEL, which doesn't
// cover Del Mar/Monmouth/the Sporting Life tracks.
const ENTRIES_TRACK_LABEL = {
  saratoga: "Saratoga", delmar: "Del Mar", monmouth: "Monmouth",
  york: "York", ascot: "Ascot", epsomdowns: "Epsom Downs", newmarket: "Newmarket",
  curragh: "Curragh", longchamp: "Longchamp",
  shatin: "Sha Tin", happyvalley: "Happy Valley", meydan: "Meydan",
};

function entryDigestNotesHtml(notes) {
  // Unchanged from the old per-horse email — shows both manual and
  // auto-imported notes side by side, same "(manual)" vs "(source name)"
  // label either way.
  return notes.map((n) => `<li><strong>${escapeHtmlForEmail(n.date || "—")}</strong> (${escapeHtmlForEmail(n.autoImported ? (n.source || "auto-imported") : "manual")}): ${escapeHtmlForEmail(n.note)}</li>`).join("");
}

// One combined digest per track per day instead of a separate email per
// horse (confirmed real change requested 2026-08-26 — the old version, one
// Resend send per matched horse, was too noisy). Same per-horse fields as
// before (Trainer/Jockey, Stable Notes with both manual and auto-imported
// notes), just grouped under a Race N heading instead of repeated in every
// subject line. raceGroups is already sorted by race number:
// [{ race, horses: [{ horse, notes }] }].
function buildEntryDigestEmail(trackLabel, date, raceGroups) {
  const horseCount = raceGroups.reduce((sum, g) => sum + g.horses.length, 0);
  const subject = `GiddyUpQuotes — ${trackLabel} — ${horseCount} horse${horseCount === 1 ? "" : "s"} today (${date})`;
  const racesHtml = raceGroups.map(({ race, horses }) => {
    const postTime = formatPostTimeLabelServer(race.postTimeIso) || race.mtpLabel || "—";
    const conditionsBits = [race.purse, race.raceType].filter(Boolean).join(" ");
    const distBits = [race.distanceLabel, race.surface].filter(Boolean).join(" · ");
    const horsesHtml = horses.map(({ horse, notes }) => `
      <h4>${escapeHtmlForEmail(horse.name || "Horse")}</h4>
      <p><strong>Trainer:</strong> ${escapeHtmlForEmail(horse.trainer || "—")} &nbsp; <strong>Jockey:</strong> ${escapeHtmlForEmail(horse.jockey || "—")}${horse.postPosition ? ` &nbsp; <strong>Post:</strong> ${escapeHtmlForEmail(String(horse.postPosition))}` : ""}</p>
      <p><strong>Stable Notes:</strong></p>
      <ul>${entryDigestNotesHtml(notes)}</ul>
    `).join("");
    return `
      <h3>Race ${race.raceNumber} — post time ${escapeHtmlForEmail(postTime)}${conditionsBits ? ` — ${escapeHtmlForEmail(conditionsBits)}` : ""}${distBits ? ` — ${escapeHtmlForEmail(distBits)}` : ""}</h3>
      ${horsesHtml}
    `;
  }).join("");
  const html = `
    <h2>GiddyUpQuotes — ${escapeHtmlForEmail(trackLabel)}</h2>
    <p>${date} &nbsp;&middot;&nbsp; <strong>${horseCount} tracked horse${horseCount === 1 ? "" : "s"}</strong> entered today with stable notes on file.</p>
    ${racesHtml}
  `;
  return { subject, html };
}

async function sendEntryDigestEmail(env, trackLabel, date, raceGroups) {
  const { subject, html } = buildEntryDigestEmail(trackLabel, date, raceGroups);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: NOTIFY_EMAILS, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
}

// The actual job: scans every track in ENTRIES_SOURCE_BY_TRACK for
// entryAlertTodayDate(), and for every non-scratched horse whose trainer is
// tracked, bundles it (at most once per horse+race — see raceNotifyKvKey())
// into that track's single daily digest email, grouped by race, with each
// horse's when/where/conditions plus every matching stable note. Called from
// both the real Cron Trigger (scheduled(), below) and the manual
// /debug-run-scheduled route, so this is the one place the actual logic
// lives.
// "scheduled" vs "manual" (the real Cron Trigger vs /debug-run-scheduled)
// is only for telling the two apart in /debug-last-run's own record — it
// doesn't change what this actually does.
// Race-day-only digest — NOT "email the moment a tracked horse with a note
// gets entered." A horse entered five days out for a Saturday stakes race
// doesn't appear in a digest until Saturday morning; the whole point is one
// digest per track on the day its horses actually run, not a batch the
// moment a horse is first discovered somewhere in a lookahead window. That
// timing comes entirely from the Cron Trigger firing once daily around 8am
// Eastern (see the Deploy note's DST caveat) — this function itself doesn't
// gate on the hour, it just checks whatever "today" is whenever it's
// called, real cron or manual alike.
async function runEntryAlerts(env, source = "manual") {
  // Whole body wrapped in one try/catch so a mid-run crash still leaves a
  // record behind — confirmed real gap: before this, an exception anywhere
  // in the per-horse loop would skip the final recordEntryAlertsRun() call
  // entirely, making a genuine bug indistinguishable from "the Cron Trigger
  // never fired at all" when read back from /debug-last-run, which is
  // exactly the ambiguity that made a real scheduling problem hard to tell
  // apart from a code bug.
  let checked = 0;
  let sent = 0;
  try {
    const state = await readState(env);
    // Horse names (lowercased) with at least one trainer-less note — these
    // need checking even when horse.trainer isn't a tracked trainer at all,
    // since a trainer-less note is deliberately not pinned to any trainer
    // (see /notes POST) and must still catch the horse regardless of who
    // ends up training it.
    const untrackedHorseNames = new Set(
      state.notes.filter((n) => !n.trainer && n.horse).map((n) => n.horse.trim().toLowerCase())
    );
    if (!state.trainers.length && !untrackedHorseNames.size) {
      const empty = { checked: 0, sent: 0 };
      await recordEntryAlertsRun(env, source, empty);
      return empty; // nothing to match against
    }
    const trackedLastNames = new Set(state.trainers.map(lastNameKey));
    const date = entryAlertTodayDate();
    // Scans ALERT_TRACKS (a deliberate subset of ENTRIES_SOURCE_BY_TRACK —
    // see that constant's own comment on why), dispatched to the same
    // per-source fetcher the /entries route uses so this never drifts out
    // of sync with which parser a track actually needs.
    for (const track of ALERT_TRACKS) {
      const sourceType = ENTRIES_SOURCE_BY_TRACK[track];
      let result;
      try {
        if (sourceType === "nyra") result = await fetchNyraEntriesDay(track, date);
        else if (sourceType === "dmtc") result = await fetchDmtcEntriesDay(date);
        else if (sourceType === "sportinglife") result = await fetchSportingLifeEntriesDay(track, date);
        else result = await fetchMonmouthEntriesDay(date);
      } catch (err) {
        console.error(`Entry alerts: ${track} ${date} fetch failed`, err.message);
        continue;
      }
      // Collect every matched horse first, grouped by race, then send ONE
      // digest email for this track covering the whole card — not one
      // Resend call per horse. Dedup keys are still per-horse-per-race
      // (raceNotifyKvKey), checked here before a horse is added to the
      // digest, but only actually written after the digest send succeeds —
      // so a failed send doesn't silently mark horses as already-notified.
      const raceGroups = [];
      for (const race of result.races || []) {
        const matchedHorses = [];
        for (const horse of race.horses || []) {
          checked++;
          if (horse.scratched) continue;
          const trainerTracked = horse.trainer && trackedLastNames.has(lastNameKey(horse.trainer));
          const hasUntrackedNote = untrackedHorseNames.has((horse.name || "").trim().toLowerCase());
          if (!trainerTracked && !hasUntrackedNote) continue;
          // Only worth including if there's actually a note to show — not
          // dedup-marked when skipped for this reason (see below), so a
          // note added earlier that same race day before the 8am window
          // still gets caught at the next scheduled run.
          const notes = notesForHorse(state.notes, horse.trainer, horse.name);
          if (!notes.length) continue;
          const key = raceNotifyKvKey(track, date, race.raceNumber, horse.name);
          const already = await env.STABLE_KV.get(key);
          if (already) continue;
          matchedHorses.push({ horse, notes, key });
        }
        if (matchedHorses.length) raceGroups.push({ race, horses: matchedHorses });
      }
      if (!raceGroups.length) continue;
      const trackLabel = ENTRIES_TRACK_LABEL[track] || track;
      try {
        await sendEntryDigestEmail(env, trackLabel, date, raceGroups);
        for (const { horses } of raceGroups) {
          for (const { key } of horses) {
            await env.STABLE_KV.put(key, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 30 });
          }
        }
        sent += raceGroups.reduce((sum, g) => sum + g.horses.length, 0);
      } catch (err) {
        console.error(`Entry alerts: digest send failed for ${track} ${date}`, err.message);
      }
    }
    const summary = { checked, sent };
    await recordEntryAlertsRun(env, source, summary);
    return summary;
  } catch (err) {
    await recordEntryAlertsRun(env, source, { checked, sent, error: err.message });
    throw err;
  }
}

// Written on every run (real cron or manual alike) so /debug-last-run can
// answer "is the Cron Trigger actually firing on its own" with real
// evidence instead of guessing from "did I get an email" — 0 emails sent is
// completely expected once nothing new has entered since the last run, so
// silence alone doesn't tell you whether the schedule itself is working.
async function recordEntryAlertsRun(env, source, summary) {
  try {
    await env.STABLE_KV.put("entryalerts:lastrun", JSON.stringify({ ranAt: new Date().toISOString(), source, ...summary }));
  } catch (err) {
    // best-effort — don't fail the actual run over a bookkeeping write
  }
}

// ---------- Horse Racing Nation news parser ----------
// Source verified directly, same diligence as every other scrape in this
// file. Of three candidate sites checked (BloodHorse, Paulick Report,
// Horse Racing Nation), only this one is actually reachable — BloodHorse
// sits behind an Incapsula bot wall (every page, including /feed/, serves a
// JS challenge shell to a plain fetch) and Paulick Report 403s a plain
// fetch site-wide; horseracingnation.com returns real HTML. No RSS feed
// exists here (/feed/ 404s), so "new article" discovery polls the site's
// own /news listing page instead (HRN_NEWS_LIST_URL), same page a human
// would browse — same MAX_ARTICLES_PER_RUN cap job #7 already uses.
//
// This is deliberately narrower than job #7's TDN parser: the ask was
// specifically trainer QUOTES about horses, not just any factual "trained
// by X" mention — verified directly that HRN publishes plenty of the
// latter with zero quotes (a "Sunday works" breeze-time report names a
// trainer in almost every paragraph and never quotes anyone). So the
// trigger here is a real quoted string attributed by name — `"..." Name
// said` — not a bare mention; a workout-report article correctly yields
// zero sections.
//
// Horse identification prefers a structural source over prose guessing: a
// stakes-preview article usually embeds its own field table (Horse/Sire +
// Trainer/Jockey columns) right after the write-up — extractHrnEntriesTable()
// reads real (trainer -> horse) pairs straight off that table, which is
// what makes multi-horse articles work (verified against a real 4-trainer
// Waya Stakes preview: only the article's own lead horse gets an inline
// <a href=".../horse/...">, so a SECOND trainer's horse deeper in the piece
// is invisible to prose-only matching — the table has it regardless).
// extractHrnSections() falls back to the same paragraph-proximity approach
// job #7 uses (horse link within TDN_PROXIMITY_WINDOW... this file's own
// HRN_PROXIMITY_WINDOW paragraphs of a trainer mention) only when no table
// exists or a quoted trainer isn't in it — e.g. a recap/feature article
// with no field table to lean on.
const HRN_NEWS_LIST_URL = "https://www.horseracingnation.com/news";
const HRN_BASE = "https://www.horseracingnation.com";
const HRN_PROXIMITY_WINDOW = 1;

function hrnStripSuffix(name) {
  return name.replace(/,?\s*(Jr\.?|Sr\.?|II|III|IV)\s*$/i, "").trim();
}

// Splits the article page into its prose (for quote extraction) and its
// embedded field table if one exists (for reliable trainer->horse pairs).
// Both boundaries verified directly against a real article: the prose
// lives in <div class="article-body ...">, and a "race-results" marker
// reliably introduces the entries table immediately after it, ending at
// that table's own </table> — confirmed only one such table per article
// (a stakes preview covers one race). Articles with no table (recaps,
// workout reports) just get an empty entriesTable, handled by the caller's
// fallback path.
function extractHrnArticleBody(html) {
  const marker = 'class="article-body';
  const start = html.indexOf(marker);
  if (start === -1) return { prose: "", entriesTable: "" };
  const openEnd = html.indexOf(">", start) + 1;
  const tableIdx = html.indexOf("race-results", openEnd);
  const prose = html.slice(openEnd, tableIdx === -1 ? openEnd + 20000 : tableIdx);
  let entriesTable = "";
  if (tableIdx !== -1) {
    const tableEnd = html.indexOf("</table>", tableIdx);
    entriesTable = tableEnd === -1 ? "" : html.slice(tableIdx, tableEnd);
  }
  return { prose, entriesTable };
}

function extractHrnEntriesTable(tableHtml) {
  const map = {}; // trainerLastName -> [{ fullName, horses: [horseNames] }, ...]
  for (const rowMatch of tableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    // The Horse/Sire cell links both the runner AND its sire (also a
    // /horse/ URL) — class="horse-name" scopes to just the runner, not the
    // sire link that follows it in the same cell.
    const horseCell = cells.find((c) => /class="horse-name/.test(c));
    if (!horseCell) continue;
    const horseMatch = horseCell.match(/class="horse-name[^"]*"[\s\S]*?<a href="https:\/\/www\.horseracingnation\.com\/horse\/[^"]+">([^<]+)<\/a>/);
    if (!horseMatch) continue;
    const horseName = decodeEntities(horseMatch[1]).trim();
    // Trainer/Jockey cell: two /person/ links, trainer always listed
    // first — verified against the real column header ("Trainer / Jockey").
    const personLinks = [...row.matchAll(/<a href="https:\/\/www\.horseracingnation\.com\/person\/[^"]+">([^<]+)<\/a>/g)];
    if (!personLinks.length) continue;
    // A trainer's formal registered name here can carry a suffix ("Claude
    // McGaughey III") the prose never uses (it says "Shug McGaughey" /
    // "McGaughey said") — stripped the same way normalizeTrainerName()
    // already does client-side, otherwise the last CSV token is "III", not
    // the surname, and the whole lookup silently misses.
    const fullName = hrnStripSuffix(decodeEntities(personLinks[0][1]).trim());
    const lastName = fullName.split(/\s+/).pop();
    // Keep an array per surname, not a single slot — two different tracked
    // trainers can share a surname (e.g. "Riley Mott" and "William Mott"),
    // and a single race's field can genuinely include both. Collapsing
    // them into one slot would silently merge one trainer's horses under
    // the other's name — exactly the mis-attribution this full-name
    // tracking exists to prevent, just reintroduced one layer up.
    if (!map[lastName]) map[lastName] = [];
    let entry = map[lastName].find((e) => e.fullName === fullName);
    if (!entry) { entry = { fullName, horses: [] }; map[lastName].push(entry); }
    if (!entry.horses.includes(horseName)) entry.horses.push(horseName);
  }
  return map;
}

function extractHrnSections(bodyHtml, entriesTableHtml) {
  const paras = [];
  for (const m of bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const inner = m[1];
    const plain = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!plain) continue;
    const horseNames = [];
    for (const sm of inner.matchAll(/<a href="https:\/\/www\.horseracingnation\.com\/horse\/[^"]+">(?:<strong>)?([^<]{2,50}?)(?:<\/strong>)?<\/a>/g)) {
      const name = decodeEntities(sm[1]).trim();
      if (name && !horseNames.includes(name)) horseNames.push(name);
    }
    paras.push({ plain, horseNames });
  }

  // The actual "this is a real quote" signal — verified this is what tells
  // a quote-bearing preview apart from a pure workout-report article (which
  // has plenty of "trained by X" and zero of this).
  const quotedLastNames = new Set();
  for (const p of paras) {
    for (const qm of p.plain.matchAll(/"[^"]{8,400}"\s+([A-Z][A-Za-z'’-]+)\s+said\b/g)) quotedLastNames.add(qm[1]);
  }
  if (!quotedLastNames.size) return [];

  const entriesMap = entriesTableHtml ? extractHrnEntriesTable(entriesTableHtml) : {};

  const mentionsByTrainer = {};
  for (const lastName of quotedLastNames) {
    mentionsByTrainer[lastName] = paras.map((_, i) => i).filter((i) => new RegExp(`\\b${escapeRegExpTdn(lastName)}\\b`).test(paras[i].plain));
  }
  // Prose-only fallback horse lookup, same shape as job #7's own algorithm
  // — used only for a quoted trainer the entries table doesn't cover.
  const horsesByTrainerFromProse = {};
  for (let i = 0; i < paras.length; i++) {
    if (!paras[i].horseNames.length) continue;
    let best = null, bestDist = Infinity, tie = false;
    for (const lastName of quotedLastNames) {
      const dist = Math.min(...mentionsByTrainer[lastName].map((mi) => Math.abs(mi - i)), Infinity);
      if (dist > HRN_PROXIMITY_WINDOW) continue;
      if (dist < bestDist) { bestDist = dist; best = lastName; tie = false; }
      else if (dist === bestDist && lastName !== best) { tie = true; }
    }
    if (!best || tie) continue;
    if (!horsesByTrainerFromProse[best]) horsesByTrainerFromProse[best] = [];
    for (const h of paras[i].horseNames) if (!horsesByTrainerFromProse[best].includes(h)) horsesByTrainerFromProse[best].push(h);
  }

  // Every paragraph within range of ANY mention of this surname (not gated
  // on that paragraph itself naming a horse) — HRN's actual quote
  // paragraphs almost never re-link the horse by name (they use "she"/
  // "her" instead, verified against a real example), so gating the TEXT on
  // horseNames presence the way job #7 does would silently drop the quote
  // itself even once the horse is correctly identified above.
  const textForLastName = (lastName) => {
    const paraIdxSet = new Set();
    for (const mi of mentionsByTrainer[lastName]) {
      for (let d = -HRN_PROXIMITY_WINDOW; d <= HRN_PROXIMITY_WINDOW; d++) {
        const idx = mi + d;
        if (idx >= 0 && idx < paras.length) paraIdxSet.add(idx);
      }
    }
    const sortedIdx = [...paraIdxSet].sort((a, b) => a - b);
    return sortedIdx.map((i) => paras[i].plain).join(" ").slice(0, 1500);
  };

  return [...quotedLastNames].flatMap((lastName) => {
    const tableEntries = entriesMap[lastName];
    if (tableEntries?.length) {
      // One section per distinct full-name candidate the entries table has
      // for this surname, not one merged section — see the comment on
      // extractHrnEntriesTable()'s map shape for why. The prose-proximity
      // text is still surname-scoped (paragraphs mentioning "Mott" don't
      // say which Mott), so it can end up identical across two same-surname
      // sections — an acceptable trade next to filing the wrong trainer's
      // horses under the wrong name entirely.
      const text = textForLastName(lastName);
      return tableEntries.map((entry) => ({ trainerName: entry.fullName, horseNames: entry.horses, text }));
    }
    const horseNames = horsesByTrainerFromProse[lastName] || [];
    if (!horseNames.length) return []; // no identifiable horse — no guessing which one
    return [{ trainerName: lastName, horseNames, text: textForLastName(lastName) }];
  });
}

async function fetchHrnNews() {
  const listRes = await fetch(HRN_NEWS_LIST_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!listRes.ok) throw new Error(`HRN news list returned HTTP ${listRes.status}`);
  const listHtml = await listRes.text();

  const items = [];
  const seenLinks = new Set();
  for (const m of listHtml.matchAll(/<article class="row news-story[^"]*"[\s\S]*?<h3[^>]*>\s*<a href="([^"]+)">\s*([\s\S]*?)\s*<\/a>/g)) {
    const link = HRN_BASE + m[1];
    if (seenLinks.has(link)) continue;
    seenLinks.add(link);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    items.push({ link, title });
  }

  const articles = [];
  for (const item of items.slice(0, MAX_ARTICLES_PER_RUN)) {
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
    const { prose, entriesTable } = extractHrnArticleBody(html);
    const sections = extractHrnSections(prose, entriesTable);
    if (!sections.length) continue;
    const pubDateMatch = html.match(/<time[^>]*datetime="([^"]+)"/);
    articles.push({
      guid: item.link, title: item.title, link: item.link,
      pubDate: pubDateMatch ? pubDateMatch[1] : null,
      sections,
    });
  }

  return { source: HRN_NEWS_LIST_URL, fetchedAt: new Date().toISOString(), articles };
}

// ---------- Daily Racing Form (DRF) news parser (job #19) ----------
// Confirmed real find 2026-08-26: DRF's site is fully scrapable (no bot
// wall, no login/paywall — every article checked has
// "isAccessibleForFree": true in its own JSON-LD) and genuinely carries
// direct trainer quotes, but ONLY in post-win recap and feature articles —
// their race-preview pieces (the majority of what /news/ publishes) are
// DRF-staff third-person handicapping analysis with zero quoted speech,
// verified against several real examples. Same "a real quote, not just a
// mention" gate as job #17's HRN parser handles that distinction
// automatically — a preview article legitimately yields zero sections.
//
// Article discovery uses DRF's own Google-News-style sitemap
// (DRF_SITEMAP_NEWS_URL) rather than a listing page or /rss.xml — that
// feed exists but mixes in betting-affiliate/promo content and doesn't
// cover the quote-bearing news articles at all, confirmed by inspecting it
// directly. The news sitemap is a rolling ~48-hour window of every article
// DRF publishes, newest first, with title/link/publish-date all in clean
// XML, no HTML parsing needed for discovery.
//
// Horse identification is DRF's one real weak point next to TDN/HRN: DRF
// never hyperlinks or otherwise marks up a horse's name in article prose
// (confirmed directly — the only in-body <a> tags are nav/footer track
// links), so the paragraph-proximity/table techniques jobs #7 and #17 use
// don't apply here. Instead this leans on a structural signal DRF does
// reliably provide: every article's own <meta name="keywords"> tag, a
// plain comma-separated list mixing the track, the trainer(s), and the
// horse(s) the piece is about (verified against several real articles,
// e.g. "Colonial,Lindsay Schultz,Pink Ruby,Baby Vino"). Horse candidates
// are whatever's left in that list after removing the quoted trainer's own
// name, anything matching DRF_KEYWORD_TRACK_NAMES, and anything whose last
// word matches DRF_RACE_NAME_SUFFIXES (DRF tags a race's own name
// separately from its track — a Colonial Turf Dash piece tags "Colonial"
// AND "Turf Dash" as two different keywords, and without that second
// filter "Turf Dash" reads as a second horse, confirmed directly). Both
// lists are maintained but necessarily incomplete, same "verify what you
// can, document the gap" spirit as every other source here rather than
// pretending this is airtight. A track or race name DRF tags that isn't in
// either list will incorrectly read as a horse; a human glancing at the
// resulting note (same as any other auto-import) is the actual backstop.
const DRF_SITEMAP_NEWS_URL = "https://www.drf.com/sitemap-news.xml";

const DRF_KEYWORD_TRACK_NAMES = new Set([
  "saratoga", "belmont", "belmont park", "aqueduct", "del mar", "santa anita", "santa anita park",
  "los alamitos", "golden gate", "golden gate fields", "churchill downs", "churchill", "keeneland",
  "ellis park", "turfway park", "kentucky downs", "gulfstream", "gulfstream park", "tampa bay downs",
  "fair grounds", "delta downs", "louisiana downs", "evangeline downs", "oaklawn", "oaklawn park",
  "monmouth", "monmouth park", "meadowlands", "parx", "parx racing", "penn national", "presque isle",
  "presque isle downs", "colonial", "colonial downs", "charles town", "mountaineer", "laurel",
  "laurel park", "pimlico", "woodbine", "woodbine mohawk park", "fort erie", "assiniboia downs",
  "hastings racecourse", "finger lakes", "canterbury", "canterbury park", "prairie meadows",
  "remington", "remington park", "will rogers downs", "lone star", "lone star park", "sam houston",
  "retama park", "century downs", "century mile", "emerald downs", "turf paradise", "arizona downs",
  "ruidoso downs", "sunland park", "zia park", "fairmount park", "fairmount", "indiana grand",
  "horseshoe indianapolis", "belterra park", "thistledown", "mahoning valley", "northfield park",
  "scioto downs", "hawthorne", "hawthorne race course", "arlington", "yonkers", "red mile",
  "york", "ascot", "epsom downs", "epsom", "newmarket", "curragh", "the curragh", "longchamp",
  "sha tin", "happy valley", "meydan",
]);

// Confirmed real gap in testing: DRF's keyword tags don't cleanly separate
// "the track" from "the race" — a piece on the Colonial Turf Dash tags
// both "Colonial" AND "Turf Dash" as their own separate keywords, and
// without this, "Turf Dash" would read as a second horse. Filtering any
// keyword whose LAST word is a common stakes-race suffix catches that
// (and Derby/Oaks/Cup/Handicap/etc. the same way) at the acceptable cost
// of a real horse coincidentally named e.g. "Grand Slam Dash" also getting
// excluded — same documented-tradeoff spirit as DRF_KEYWORD_TRACK_NAMES
// above, not a claim this is airtight.
const DRF_RACE_NAME_SUFFIXES = new Set([
  "stakes", "derby", "oaks", "cup", "handicap", "dash", "mile", "sprint", "futurity",
  "debutante", "invitational", "championship", "challenge", "classic", "juvenile",
]);

function drfKeywordIsTrackOrRace(keywordLower) {
  if (DRF_KEYWORD_TRACK_NAMES.has(keywordLower)) return true;
  const words = keywordLower.split(/\s+/);
  return DRF_RACE_NAME_SUFFIXES.has(words[words.length - 1]);
}

function extractDrfKeywords(html) {
  const m = html.match(/<meta name="keywords" content="([^"]*)"/);
  if (!m) return [];
  return decodeEntities(m[1]).split(",").map((s) => s.trim()).filter(Boolean);
}

// Same "a real quote, not just a mention" gate as extractHrnSections() —
// DRF's articles use actual curly quote characters in the page source (not
// escaped entities, confirmed directly), so this matches either those or
// plain ASCII quotes just in case.
function extractDrfSections(html, keywords) {
  const paras = [];
  for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const plain = decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (plain) paras.push(plain);
  }
  const fullText = paras.join(" ");

  const quotedLastNames = new Set();
  for (const qm of fullText.matchAll(/[“"][^”"]{8,400}[”"]\s+([A-Z][A-Za-z'’-]+)\s+said\b/g)) {
    quotedLastNames.add(qm[1]);
  }
  if (!quotedLastNames.size) return [];

  const keywordsLower = keywords.map((k) => k.toLowerCase());
  return [...quotedLastNames].map((lastName) => {
    const horseNames = keywords.filter((k, i) => {
      const kl = keywordsLower[i];
      if (drfKeywordIsTrackOrRace(kl)) return false;
      if (kl.split(/\s+/).pop() === lastName.toLowerCase()) return false; // the quoted trainer's own name
      return true;
    });
    if (!horseNames.length) return null; // no identifiable horse — no guessing which one
    // Proximity-scoped text, same idea as HRN's textForLastName() — the
    // paragraph(s) actually mentioning this trainer's surname, not the
    // whole article (a DRF piece can cover more than one trainer/horse).
    const relevantParas = paras.filter((p) => new RegExp(`\\b${escapeRegExpTdn(lastName)}\\b`).test(p));
    const text = (relevantParas.length ? relevantParas : paras).join(" ").slice(0, 1500);
    return { trainerName: lastName, horseNames, text };
  }).filter(Boolean);
}

async function fetchDrfNews() {
  const sitemapRes = await fetch(DRF_SITEMAP_NEWS_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!sitemapRes.ok) throw new Error(`DRF news sitemap returned HTTP ${sitemapRes.status}`);
  const sitemapXml = await sitemapRes.text();

  const items = [];
  for (const m of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const link = block.match(/<loc>(.*?)<\/loc>/)?.[1];
    const title = block.match(/<news:title>(.*?)<\/news:title>/)?.[1];
    const pubDate = block.match(/<news:publication_date>(.*?)<\/news:publication_date>/)?.[1];
    if (link) items.push({ link, title: title ? decodeEntities(title).trim() : null, pubDate: pubDate || null });
  }

  const articles = [];
  for (const item of items.slice(0, MAX_ARTICLES_PER_RUN)) {
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
    const keywords = extractDrfKeywords(html);
    const sections = extractDrfSections(html, keywords);
    if (!sections.length) continue;
    articles.push({ guid: item.link, title: item.title, link: item.link, pubDate: item.pubDate, sections });
  }

  return { source: DRF_SITEMAP_NEWS_URL, fetchedAt: new Date().toISOString(), articles };
}

// ---------- SmartPony partner quotes (job #18) ----------
// SmartPony (smartpony.ai) is a partner site — a friend's AI handicapping
// project, separately also building its own trainer-quote pipeline from
// news articles. Rather than duplicate that scraping work, this reads
// their already-extracted quotes straight from their database via a real
// authenticated API call (Supabase's standard REST interface), not by
// scraping their HTML. Confirmed directly (their site's own public JS
// bundle, not anything behind the login — reading a site's own client-side
// code is not the same as accessing gated data) that this is a stock
// Supabase app: project ref jtyraplxburkdacqialz, a `trainer_quotes` table
// with columns including trainer_name_raw/trainer_name, mentioned_horse_name,
// quote_text, status, created_at, and raw_article_id (joined to
// raw_articles for url/title/source/published_at). The anon key below is
// SmartPony's own public client key (meant to be public — Supabase's actual
// access control is row-level security enforced server-side, not secrecy
// of this key), not a credential of ours.
const SMARTPONY_SUPABASE_URL = "https://jtyraplxburkdacqialz.supabase.co";
const SMARTPONY_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eXJhcGx4YnVya2RhY3FpYWx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg3MTczODMsImV4cCI6MjA2NDI5MzM4M30.Xw88xiCO96cisTGiMYLU8yE8bjAHUvlNtC-YuLPvgWE";

// Logs in fresh on every call rather than persisting/refreshing a session
// token in KV — a Supabase password-grant login is one lightweight REST
// call, this job only runs on the same schedule/manual-trigger cadence as
// every other import in this file (nowhere near a rate-limit concern), and
// re-authenticating every time avoids the added failure modes of storing a
// refresh token across runs (expiry, revocation, races between two
// concurrent runs). Throws with SmartPony's own error detail on failure —
// most commonly, the SMARTPONY_EMAIL/SMARTPONY_PASSWORD secrets aren't set
// yet, or the password changed on their end.
async function smartponyLogin(env) {
  if (!env.SMARTPONY_EMAIL || !env.SMARTPONY_PASSWORD) {
    throw new Error("SMARTPONY_EMAIL/SMARTPONY_PASSWORD secrets not set");
  }
  const res = await fetch(`${SMARTPONY_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SMARTPONY_ANON_KEY },
    body: JSON.stringify({ email: env.SMARTPONY_EMAIL, password: env.SMARTPONY_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description || body.msg || `SmartPony login returned HTTP ${res.status}`);
  }
  return body.access_token;
}

// SmartPony's own race_entries rows store person names "LASTNAME FIRST[
// MIDDLE]" (all caps) — reformats to "First [Middle] Lastname" so it's
// comparable against this file's own "First Last" convention (and so
// resolveTrackedTrainer()'s nickname aliasing, e.g. Steve/Steven, still
// applies on the client).
function titleCaseName(s) {
  return s.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
// Continuation particles for multi-word surnames (Spanish/Portuguese/
// French/Dutch naming conventions, common among jockeys and trainers) —
// confirmed real: taking only the FIRST token as the surname mangled
// "DE PAZ HORACIO" (jockey Horacio De Paz) into "Paz Horacio De", a
// recurring false-positive in the SmartPony audit.
const SURNAME_PARTICLES = new Set(["de", "del", "dela", "la", "van", "von", "der", "di", "du", "dos", "das", "el"]);
function reformatLastFirstName(raw) {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return titleCaseName(raw);
  // Surname starts as just the first token, then grows by one more token
  // for every particle encountered — "DE PAZ HORACIO" grows past "De" into
  // "De Paz" before stopping, leaving "Horacio" as the given name. Always
  // leaves at least one trailing token for the given name, even if that
  // means under-extending a compound surname on a malformed/nameless input.
  let splitAt = 1;
  while (splitAt < parts.length - 1 && SURNAME_PARTICLES.has(parts[splitAt - 1].toLowerCase())) {
    splitAt++;
  }
  const surname = parts.slice(0, splitAt);
  const given = parts.slice(splitAt);
  return titleCaseName([...given, ...surname].join(" "));
}

// Shared by fetchSmartPonyQuotes() and auditNotesAgainstSmartPony() — both
// need "given a set of horse names, find their SmartPony horse_id" and
// "given a set of horse_ids, find each one's most recent race_entries row."
// SmartPony stores horse_name in ALL CAPS — batched exact-match lookup (not
// one query per horse, of which there can be hundreds). PostgREST's in.()
// list syntax needs each value double-quoted since horse names contain
// spaces; the whole list is percent-encoded as one unit and decoded back to
// literal syntax server-side, same as any other query string value.
const SMARTPONY_LOOKUP_BATCH = 40;
async function lookupHorseIdsByName(accessToken, horseNames) {
  const nameToHorseId = {};
  for (let i = 0; i < horseNames.length; i += SMARTPONY_LOOKUP_BATCH) {
    const batch = horseNames.slice(i, i + SMARTPONY_LOOKUP_BATCH);
    const inList = batch.map((n) => `"${n.toUpperCase().replace(/"/g, '\\"')}"`).join(",");
    const res = await fetch(
      `${SMARTPONY_SUPABASE_URL}/rest/v1/horses?horse_name=in.(${encodeURIComponent(inList)})&select=id,horse_name`,
      { headers: { apikey: SMARTPONY_ANON_KEY, Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) continue; // best-effort — skip a bad batch rather than failing the whole lookup
    const rows = await res.json();
    for (const row of rows) {
      const match = batch.find((n) => n.toUpperCase() === row.horse_name);
      if (match) nameToHorseId[match] = row.id;
    }
  }
  return nameToHorseId;
}
async function lookupRaceEntriesByHorseId(accessToken, horseIds) {
  const entryByHorseId = {};
  for (let i = 0; i < horseIds.length; i += SMARTPONY_LOOKUP_BATCH) {
    const batch = horseIds.slice(i, i + SMARTPONY_LOOKUP_BATCH);
    const res = await fetch(
      `${SMARTPONY_SUPABASE_URL}/rest/v1/race_entries?horse_id=in.(${batch.join(",")})&select=horse_id,trainer,jockey,owner,created_at&order=created_at.desc`,
      { headers: { apikey: SMARTPONY_ANON_KEY, Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) continue;
    const rows = await res.json();
    for (const e of rows) {
      if (!entryByHorseId[e.horse_id]) entryByHorseId[e.horse_id] = e; // newest first — first hit per horse wins
    }
  }
  return entryByHorseId;
}

async function fetchSmartPonyQuotes(env) {
  const accessToken = await smartponyLogin(env);
  const state = await readState(env); // trainers list — see the tracked-spelling snap below
  // All three of SmartPony's own review states (needs_review, auto_matched,
  // verified) — originally scoped to verified-only, but that missed most
  // of what's actually on their site (confirmed real: several Chad Brown
  // quotes visible on smartpony.ai never made it through since they were
  // still needs_review/auto_matched). User's explicit call: broader
  // coverage matters more here than only importing SmartPony's own final
  // human-reviewed queue — this file's usual "don't guess" standard is
  // about horse/trainer identification, which SmartPony has already done
  // for us, not about their internal review-workflow status.
  const query = "select=id,quote_text,trainer_name_raw,trainer_name,mentioned_horse_name,sentiment,created_at,matched_horse_id,raw_articles(url,title,source,published_at)"
    + "&status=in.(needs_review,auto_matched,verified)&order=created_at.desc&limit=500";
  const res = await fetch(`${SMARTPONY_SUPABASE_URL}/rest/v1/trainer_quotes?${query}`, {
    headers: { apikey: SMARTPONY_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    cf: { cacheTtl: 300, cacheEverything: false }, // per-user auth header — never a shared cache key
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `SmartPony quotes fetch returned HTTP ${res.status}`);
  }
  const rows = await res.json();

  // Cross-references against SmartPony's own race_entries table (real
  // trainer/jockey/owner per horse, from their own past-performance data —
  // not just whoever got quoted) — added after confirming real
  // mis-attribution: trainer_name_raw sometimes names the JOCKEY or OWNER
  // instead of the trainer (confirmed real: a "Jose Ortiz" quote — actually
  // Counting Stars' jockey — and a "Terry Finley" quote — actually
  // Powerline's owner — both got treated as if they were the trainer's own
  // name before this fix, adding real people who aren't trainers at all to
  // the tracked-trainer list). One bulk lookup for every horse referenced
  // in this batch, not one query per quote — KV/API-call discipline this
  // file follows everywhere else too.
  //
  // matched_horse_id is SmartPony's own pre-computed match and is sometimes
  // null even when the horse genuinely exists in their horses table —
  // confirmed real via a later full-backlog audit (auditNotesAgainstSmartPony,
  // which looks horses up by name instead) finding real mis-attributions
  // that this cross-reference had missed. So: use matched_horse_id where
  // present, and fall back to the same name-based lookup the audit uses for
  // every row that's missing one — maximizes how many quotes get verified
  // against a real trainer before ever reaching the client's auto-add path,
  // rather than relying solely on SmartPony's own match quality.
  const namedHorseNames = [...new Set(
    rows.filter((r) => !r.matched_horse_id).map((r) => (r.mentioned_horse_name || "").trim()).filter(Boolean)
  )];
  const nameToHorseId = namedHorseNames.length ? await lookupHorseIdsByName(accessToken, namedHorseNames) : {};
  const horseIds = [...new Set([
    ...rows.map((r) => r.matched_horse_id).filter(Boolean),
    ...Object.values(nameToHorseId),
  ])];
  const entryByHorseId = horseIds.length ? await lookupRaceEntriesByHorseId(accessToken, horseIds) : {};

  const quotes = [];
  for (const row of rows) {
    const horseName = (row.mentioned_horse_name || "").trim();
    const text = (row.quote_text || "").trim();
    if (!horseName || !text) continue; // no identifiable horse — no guessing which one, same rule every other import job here follows
    let trainerName = (row.trainer_name_raw || row.trainer_name || "").trim();
    if (!trainerName) continue;
    let noteText = text;

    const horseId = row.matched_horse_id || nameToHorseId[horseName];
    const entry = horseId ? entryByHorseId[horseId] : null;
    if (entry?.trainer) {
      const realTrainer = reformatLastFirstName(entry.trainer);
      if (lastNameKey(trainerName) !== lastNameKey(realTrainer)) {
        // Whoever's quoted isn't the trainer on record for this horse —
        // most often the jockey or owner. Files under the real trainer
        // regardless (that's who this note belongs to), but keeps the
        // actual speaker's name in the note text so that context isn't
        // lost — a jockey's read on a horse is different information than
        // the trainer's own, worth knowing it wasn't the trainer talking.
        noteText = `${trainerName}: ${text}`;
        trainerName = realTrainer;
      }
    }
    // Snap to an already-tracked trainer's exact spelling whenever one
    // matches — confirmed real: SmartPony's own two fields disagree with
    // each other on spelling (their quote attribution vs. their
    // race_entries table sometimes drop an apostrophe differently), so
    // trusting either blindly lets the same real trainer spawn a new
    // near-duplicate tracked entry every time a slightly different spelling
    // comes through (e.g. "Philip Damato" repeatedly re-appearing alongside
    // the already-tracked "Phil D'Amato"). The tracked roster itself is the
    // more stable source of truth once a trainer's already been added
    // correctly, so it wins over both of SmartPony's own fields here.
    const tracked = resolveTrackedTrainer(trainerName, state.trainers);
    if (tracked) trainerName = tracked;

    const article = row.raw_articles || {};
    quotes.push({
      quoteId: row.id,
      trainerName,
      horseName,
      text: noteText,
      sentiment: row.sentiment || null,
      date: article.published_at ? article.published_at.slice(0, 10) : (row.created_at ? row.created_at.slice(0, 10) : null),
      source: article.title || article.source || "SmartPony",
      link: article.url || null,
    });
  }
  return quotes;
}

// A window of YYYY-MM-DD date strings starting today (NY time), `days`
// more after it — same lookahead NYRA's own entries posting horizon
// covers. Used to cross-check notes against LIVE current entries, which
// take precedence over SmartPony's own race_entries table when both are
// available — confirmed real: they disagreed for Glen Airy (SmartPony's
// race_entries said Michael Maker, NYRA's own live card said Linda Rice),
// and NYRA's own current posting is the more trustworthy "who trains this
// right now" signal.
function nyDateWindow(days) {
  const { year, month, day } = nyNowParts();
  const start = new Date(Date.UTC(year, month - 1, day));
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

// Scans NYRA_ENTRIES_BASE's tracks over the next 7 days for real, live
// entries, building horseName (lowercased) -> {trainer, track, date} —
// first hit per horse wins, i.e. the soonest-posted entry. Bounded by the
// same tracks/window runEntryAlerts() already checks daily, so this stays
// a small, predictable number of fetches even though it's live data, not
// a KV read.
async function lookupNyraEntriesTrainerByHorse() {
  const dates = nyDateWindow(6);
  const byHorse = {};
  for (const track of Object.keys(NYRA_ENTRIES_BASE)) {
    for (const date of dates) {
      let result;
      try {
        result = await fetchNyraEntriesDay(track, date);
      } catch (err) {
        continue; // best-effort — a bad fetch for one day/track shouldn't kill the whole audit
      }
      for (const race of result.races || []) {
        for (const horse of race.horses || []) {
          if (horse.scratched || !horse.trainer || !horse.name) continue;
          const key = horse.name.trim().toLowerCase();
          if (!byHorse[key]) byHorse[key] = { trainer: horse.trainer, track, date };
        }
      }
    }
  }
  return byHorse;
}

// Checks EVERY currently tracked trainer's notes against real trainer data
// — NYRA's own live entries first (see lookupNyraEntriesTrainerByHorse()
// above for why that wins when available), falling back to SmartPony's
// race_entries data (broader historical coverage, but sometimes stale or
// wrong) for a horse with no current NYRA entry. Keyed by horse NAME — not
// by quote id, so this covers the whole existing note backlog (including
// notes from TDN/HRN/News Wire/thisishorseracing.com, not just
// SmartPony-sourced ones), unlike fetchSmartPonyQuotes()'s own race_entries
// check which only ever applies to a fresh SmartPony quote at import time.
// Built after repeatedly finding pre-existing mis-attributed notes one at a
// time via user reports (jockeys, owners, assistants, a reporter, duplicate
// name variants) — this checks it all in one pass instead. Read-only:
// reports mismatches, changes nothing itself.
async function auditNotesAgainstSmartPony(env) {
  const accessToken = await smartponyLogin(env);
  const state = await readState(env);
  const notes = state.notes;

  const horseNames = [...new Set(notes.map((n) => (n.horse || "").trim()).filter(Boolean))];
  const nameToHorseId = await lookupHorseIdsByName(accessToken, horseNames);
  const horseIds = [...new Set(Object.values(nameToHorseId))];
  const entryByHorseId = await lookupRaceEntriesByHorseId(accessToken, horseIds);
  const nyraByHorse = await lookupNyraEntriesTrainerByHorse();

  const mismatches = [];
  let checked = 0;
  for (const n of notes) {
    if (!n.trainer) continue; // deliberately trainer-less (see /notes POST) — not a mismatch, nothing to compare
    const nyraHit = nyraByHorse[(n.horse || "").trim().toLowerCase()];

    let realTrainer, realJockey, realOwner, checkedAgainst;
    if (nyraHit?.trainer) {
      realTrainer = nyraHit.trainer;
      realJockey = null;
      realOwner = null;
      checkedAgainst = "nyra-entries";
    } else {
      const horseId = nameToHorseId[(n.horse || "").trim()];
      if (!horseId) continue; // not found in either source — nothing to check against
      const entry = entryByHorseId[horseId];
      if (!entry?.trainer) continue;
      realTrainer = reformatLastFirstName(entry.trainer);
      realJockey = entry.jockey ? reformatLastFirstName(entry.jockey) : null;
      realOwner = entry.owner || null;
      checkedAgainst = "smartpony";
    }
    checked++;
    if (lastNameKey(n.trainer || "") !== lastNameKey(realTrainer)) {
      mismatches.push({
        noteId: n.id,
        horse: n.horse,
        currentTrainer: n.trainer,
        realTrainer,
        realJockey,
        realOwner,
        checkedAgainst,
        source: n.source || null,
        noteSnippet: (n.note || "").slice(0, 120),
      });
    }
  }

  return {
    totalNotes: notes.length,
    distinctHorses: horseNames.length,
    horsesFoundInSmartPony: Object.keys(nameToHorseId).length,
    horsesFoundInNyraEntries: Object.keys(nyraByHorse).length,
    checked,
    mismatchCount: mismatches.length,
    mismatches,
  };
}
