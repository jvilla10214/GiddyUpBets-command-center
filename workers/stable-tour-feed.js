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
// 11. Severe weather alerts (GET /nws-alerts?lat=<lat>&lon=<lon> or
//    ?zone=<countyUGC>) — proxies api.weather.gov's active-alerts endpoint,
//    filtered server-side to exactly "Severe Thunderstorm Warning",
//    "Tornado Warning", and "Flash Flood Warning" (not Watches, not
//    Advisories, not any other alert type) — Flash Flood Warning added
//    alongside the original two since it's directly relevant to whether a
//    track can run at all, same bar as the other two (an active, in-
//    progress WARNING, not a lower-confidence Watch/Advisory). `zone` (an
//    NWS county UGC code) takes precedence over lat/lon when both are
//    given — confirmed real gap: point-based lookup only ever catches an
//    alert whose polygon happens to cover that ONE coordinate, missing a
//    warning scoped to a different part of the same county (Saratoga only
//    for now — see its countyZone in TRACKS). Free, keyless, official
//    government source. This is the one job in this file that a browser
//    could never do directly even though the API itself is CORS-open — NWS
//    documents a descriptive User-Agent as required, and fetch() is spec-
//    forbidden from setting its own User-Agent header, so this has to go
//    through a
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
//    payload just to populate it. Since the client only saves opportunis-
//    tically (nobody has to be watching for results to go final), a day
//    nobody had open keeps an entries-only snapshot forever — so
//    backfillRaceDayResults() re-checks the trailing 10 days' archived
//    snapshots on every scheduled() firing (piggybacking job #16's Cron
//    Trigger, no new one needed) and fills in results wherever they're
//    missing. Manual equivalent: GET /debug-backfill-raceday-results.
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
//    track per day (buildStyledEntryDigestEmail()/sendEntryDigestEmail()) —
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
//    separate emails. ALERT_TRACKS started as Saratoga + Del Mar only — the
//    user's explicit target list also included Belmont, Keeneland,
//    Churchill, and Santa Anita, added as each became ready rather than all
//    at once (confirmed real ask 2026-08-26). Belmont is in
//    ENTRIES_SOURCE_BY_TRACK/RESULTS_SOURCE_BY_TRACK (2026-09-04), gated by
//    NYRA_TRACK_MEET_WINDOWS so nyra.com/belmont/rdl/race/ can no longer
//    silently serve SARATOGA's live card mislabeled as Belmont while dark
//    (confirmed happening live on 2026-09-04, before this gate existed) —
//    but that gate only prevents wrong data, it isn't the same as fetching
//    and verifying a REAL live Belmont card, which still hasn't happened
//    (meet opens Sept 18, 2026) — Belmont stays OUT of ALERT_TRACKS until
//    then. Keeneland/Churchill/Santa Anita, plus Oaklawn/Gulfstream/
//    Colonial Downs/Kentucky Downs/Ellis Park/Fair Grounds, went straight
//    into ALERT_TRACKS the same day instead (2026-09-04) — they're all on
//    SmartPony now (see SMARTPONY_TRACK_CODE), a real relational
//    database filtered by exact track+date, not a scrape that could
//    silently substitute the wrong card, so Belmont's specific staged-wait
//    reasoning doesn't apply to them. Every run
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
//    THREE merged, deduped, round-robined DRF listings instead of a plain
//    listing page: the news sitemap, /news/all-news page 1 (added
//    2026-08-27 to widen coverage past the sitemap's own ~48-hour window),
//    and the Saratoga track hub page (added same day, specifically for
//    deep Saratoga-only coverage — 70+ articles spanning the whole meet in
//    one fetch, by far the richest of the three). DRF is fully free/
//    unauthenticated (confirmed via each article's own JSON-LD) but never
//    marks up a horse's name in prose the way TDN/HRN do, so horse
//    identification here comes from each article's <meta name="keywords">
//    tag instead of paragraph-proximity or an entries table — see
//    extractDrfSections()'s own comments for the full reasoning, including
//    a real per-paragraph speaker-attribution fix and a global horse-
//    ownership map added 2026-08-27 after scanning the Saratoga source's
//    full backlog surfaced several genuine multi-person misattributions
//    (a rival horse praised by name read as the quoted trainer's own; a
//    trainer's quote mentioning a jockey by name credited the jockey
//    instead). Two known remaining gaps: DRF_KEYWORD_TRACK_NAMES and
//    DRF_RACE_NAME_SUFFIXES/DRF_BARE_RACE_NAMES are all necessarily
//    incomplete, so an untracked track or race name occasionally still
//    reads as a horse.
// 20. NYRA News (GET /nyra-news) — NYRA's own Saratoga press releases
//    (nyra.com/saratoga/news/), first-party rather than third-party
//    coverage like #7/#17/#19. Plain static HTML, no auth, no robots.txt
//    restriction. The real wrinkle: a single "Stakes Advance" preview
//    routinely profiles 3+ horses, each introduced as "OWNER's HORSE NAME
//    [post N, Jockey]" in prose with no inline horse link and no <meta
//    keywords> tag to lean on (unlike HRN/DRF) — extractNyraBracketHorse()
//    reads that bracket convention structurally, falling back to
//    extractNyraTitleHorse() (the headline's own leading words) only for
//    the article's lead horse before its own bracket appears later in the
//    piece. stripNyraPossessivePrefix() handles both "'s "/"’s " and the
//    bare plural "' "/"’ " an owner name can end in; stripNyraBreedingDescriptor()
//    then strips a breeding descriptor ("Kentucky homebred", "New
//    York-bred") that can sit between the owner and the actual horse.
// 21. Stable Tour note dedupe (Cron Trigger -> scheduled(), plus manual GET
//    /debug-dedupe-notes) — deletes exact-duplicate notes (same trainer,
//    same horse, byte-identical text after whitespace normalization),
//    keeping the earliest by capturedAt. Piggybacks the existing job #16
//    Cron Trigger, no new trigger needed. Deliberately narrow: a live audit
//    (2026-09-03) found 227 true duplicates from articles getting
//    re-imported a few days apart, but ALSO found that "same trainer+horse
//    +source link" is NOT a safe duplicate signal — every one of 39 such
//    groups whose text differed turned out to be two genuinely different
//    quotes from the same article (e.g. trainer and jockey both quoted
//    about the same horse), which this intentionally leaves alone.
// 22. Race Recaps (POST /raceday/recap) — attaches free-text race-recap
//    prose to one race of an already-archived race day (the Race Recaps
//    page's own "+ Add/Edit Recap" button), and maintains a horse->recap
//    reverse index (keyed off that race's real finish order, not the
//    morning entries list) so job #16's entry-alert email can surface a
//    horse's full recorded race recap whenever it's entered again — a
//    trigger independent of tracked-trainer status or regular notes; a
//    horse can appear in the digest purely because it has a recap on file.
// 23. Race Recap Doc re-sync (POST /raceday/recap/resync) — re-pulls ONE
//    date's recaps straight from the shared Google Doc the user writes them
//    in by hand, so an edit made there after the original import doesn't
//    require a manual re-backfill. Scoped to exactly the requested date; see
//    resyncRaceRecapsFromDoc()'s own comment for the parsing details and its
//    "never clears on empty match" safety rule. Also pulls that date's
//    whole-card "Full Card Recap:" writeup (record.fullCardRecap, manual
//    set/clear at POST /raceday/fullcard) in the same read-modify-write.
// Deploy: paste into the dashboard's Workers editor -> Deploy. Requires a KV
// namespace bound as STABLE_KV (Worker settings -> Bindings -> KV Namespace)
// for jobs #1, #3, #5, #9, #15, #16, #21, and #22 to work — jobs #2, #4, #6, #7, #8,
// #10, #11, #12, #13, #14, #17, #18, and #20 (fetch-and-parse only, no
// storage) work without it. Job #8 additionally requires a PIRATE_WEATHER_API_KEY
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
// DRF specifically gets a higher cap (job #19) since it now merges THREE
// listing sources (the news sitemap, /news/all-news page 1, and the
// Saratoga track hub page — see each URL constant's own comment),
// round-robined one-from-each rather than concatenated. Raised from 24 to
// 36 (= 12 full rounds of 3) when the Saratoga source was added — it alone
// can have 70+ articles spanning the whole meet, easily the largest of the
// three, so it needs real headroom to make progress across runs. Still
// well within a Worker's subrequest budget (36 articles + 3 listing
// fetches).
const DRF_MAX_ARTICLES_PER_RUN = 36;
// NYRA News (job #20) also gets its own higher cap, same reasoning as DRF
// above — confirmed real gap: on a single busy stakes day (e.g. Travers
// day) NYRA can publish 6+ press releases, easily blowing past the shared
// 8-item cap between one 6-hour poll and the next and permanently skipping
// real post-race recaps (including the Travers winner itself, confirmed
// missing 2026-08-30) since nothing re-checks articles that fall off the
// bottom of a fetch once a newer batch pushes them out of the top N.
const NYRA_NEWS_MAX_ARTICLES_PER_RUN = 20;
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
    ctx.waitUntil(
      backfillRaceDayResults(env).catch((err) => console.error("Race day results backfill failed", err.message))
    );
    ctx.waitUntil(
      dedupeStableTourNotes(env).catch((err) => console.error("Stable Tour note dedupe failed", err.message))
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

    // Cheap "did anything change" check — one small KV read instead of the
    // full trainers+notes+trainerMeta blob. Polled every 5 minutes (and on
    // every tab refocus) by the client's refreshStableDataIfIdle(); a
    // mismatch is what triggers the real GET /data fetch + re-render, so
    // the overwhelming majority of polls (nothing changed since last time)
    // cost a few bytes instead of the full dataset.
    if (url.pathname === "/data/version" && request.method === "GET") {
      const version = (await env.STABLE_KV.get("dataVersion")) || "0";
      return json({ version }, 200, { "Cache-Control": "no-store" });
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
      const state = await readTrainersAndMeta(env);
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
      await bumpDataVersion(env);
      return json({ trainers: state.trainers, trainerMeta: state.trainerMeta }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/trainers/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const names = Array.isArray(body.names) ? body.names.map(n => (n || "").trim()).filter(Boolean) : [];
      if (!names.length) return json({ error: "Missing names" }, 400);
      const source = (body.source || "manual").trim();
      const state = await readTrainersAndMeta(env);
      let addedAny = false;
      // One KV write for the whole batch instead of one per name — KV write
      // quota is a hard daily cap (free tier: 1,000/day, account-wide), and
      // a 100-name bulk-add used to cost 100+ writes on its own.
      // Confirmed real contributor to that same cap: this used to write
      // `trainers` UNCONDITIONALLY even when every name in the batch already
      // existed (the overwhelmingly common case once a job's caught up) —
      // five auto-import jobs each calling this on every page load AND every
      // 6 hours adds up fast when every single one of those calls is a
      // guaranteed write regardless of whether anything actually changed.
      for (const name of names) {
        const exists = state.trainers.some(t => t.toLowerCase() === name.toLowerCase());
        if (!exists) {
          state.trainers.push(name);
          state.trainerMeta[name] = { source, addedAt: new Date().toISOString() };
          addedAny = true;
        }
      }
      if (addedAny) {
        state.trainers.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)) || a.localeCompare(b));
        await env.STABLE_KV.put("trainers", JSON.stringify(state.trainers));
        await env.STABLE_KV.put("trainerMeta", JSON.stringify(state.trainerMeta));
        await bumpDataVersion(env);
      }
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
      await bumpDataVersion(env);
      return json({ trainers, notes, trainerMeta: state.trainerMeta }, 200, { "Cache-Control": "no-store" });
    }

    // Same cascade as /trainers DELETE above, one KV write for the whole
    // batch instead of one per name — added specifically to undo the
    // SmartPony auto-add flood (see autoImportSmartPonyQuotes()'s own
    // comment) in one call instead of hundreds, but kept general since any
    // future bulk trainer cleanup needs exactly this same primitive.
    if (url.pathname === "/trainers/bulk-delete" && request.method === "POST") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const names = new Set(Array.isArray(body.names) ? body.names : []);
      if (!names.size) return json({ error: "Missing names" }, 400);
      const state = await readState(env);
      const trainers = state.trainers.filter(t => !names.has(t));
      const notes = state.notes.filter(n => !names.has(n.trainer));
      for (const name of names) delete state.trainerMeta[name];
      await env.STABLE_KV.put("trainers", JSON.stringify(trainers));
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      await env.STABLE_KV.put("trainerMeta", JSON.stringify(state.trainerMeta));
      await bumpDataVersion(env);
      return json({
        removedTrainers: state.trainers.length - trainers.length,
        removedNotes: state.notes.length - notes.length,
        trainers,
      }, 200, { "Cache-Control": "no-store" });
    }

    // Merges two tracked-trainer entries that are really the same person
    // under a different spelling — confirmed real and recurring: SmartPony's
    // own trainer_name_raw/trainer_name fields sometimes spell a first name
    // differently (a nickname, an extra middle initial) than this app's
    // already-tracked spelling, and resolveTrackedTrainer()'s strict
    // same-first-name-token match correctly refuses to guess they're the
    // same person — which is the right call for MATCHING an incoming quote,
    // but leaves a genuine duplicate sitting in the tracked list once
    // SmartPony's own auto-add path creates one (e.g. "Whit Beckman" next to
    // a freshly-added "D Whitworth Beckman"). Reassigns every note from
    // `from` to `to`, then removes `from` entirely — a person decision this
    // app deliberately never makes on its own, hence its own dedicated route
    // rather than folding it into the auto-import path.
    if (url.pathname === "/trainers/merge" && request.method === "POST") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const from = (body.from || "").trim();
      const to = (body.to || "").trim();
      if (!from || !to || from === to) return json({ error: "Need distinct from/to names" }, 400);
      const state = await readState(env);
      if (!state.trainers.includes(from)) return json({ error: `Trainer not found: ${from}` }, 404);
      if (!state.trainers.includes(to)) return json({ error: `Trainer not found: ${to}` }, 404);
      let reassigned = 0;
      for (const n of state.notes) {
        if (n.trainer === from) {
          n.trainer = to;
          reassigned++;
        }
      }
      const trainers = state.trainers.filter(t => t !== from);
      delete state.trainerMeta[from];
      await env.STABLE_KV.put("trainers", JSON.stringify(trainers));
      await env.STABLE_KV.put("notes", JSON.stringify(state.notes));
      await env.STABLE_KV.put("trainerMeta", JSON.stringify(state.trainerMeta));
      await bumpDataVersion(env);
      return json({ reassigned, trainers }, 200, { "Cache-Control": "no-store" });
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
      const notes = await readNotes(env);
      // Multiple devices independently auto-importing the same article would
      // otherwise each file a duplicate note — dedupe on (trainer, horse,
      // link) when a link is present, which auto-imported notes always have.
      if (body.link) {
        const dup = notes.find(n => n.trainer === body.trainer && n.horse === body.horse && normalizeLinkForDedup(n.link) === normalizeLinkForDedup(body.link));
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
        // Which auto-import pipeline actually pulled this note in, separate
        // from `link`'s own domain — confirmed real need: SmartPony's feed
        // often carries the ORIGINAL article's own link/title (e.g. a real
        // drf.com URL), so the site badge correctly says "drf.com" but
        // nothing showed that SmartPony's own aggregation was what actually
        // surfaced it. Only SmartPony (job #18) sets this today.
        importedVia: body.importedVia || null,
        capturedAt: new Date().toISOString(),
      };
      notes.push(note);
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      await bumpDataVersion(env);
      return json({ note }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const items = Array.isArray(body.notes) ? body.notes : [];
      if (!items.length) return json({ error: "Missing notes" }, 400);
      const notes = await readNotes(env);
      const results = [];
      // Confirmed real contributor to the account-wide 1,000-write/day KV
      // cap: this used to write `notes` UNCONDITIONALLY even when every item
      // in the batch turned out to already exist — which, once a job is
      // caught up, is the normal outcome on most polls. Five auto-import
      // jobs each hitting this on every page load AND every 6 hours means
      // that used to be a guaranteed write per job per poll regardless of
      // whether anything new actually showed up. Only writes if at least one
      // note in the batch was genuinely new.
      let addedAny = false;
      for (const item of items) {
        if (!item.trainer || !item.horse || !item.note) continue;
        if (item.link) {
          const dup = notes.find(n => n.trainer === item.trainer && n.horse === item.horse && normalizeLinkForDedup(n.link) === normalizeLinkForDedup(item.link));
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
          importedVia: item.importedVia || null, // see /notes POST's own comment above
          capturedAt: new Date().toISOString(),
        };
        notes.push(note);
        results.push({ note });
        addedAny = true;
      }
      if (addedAny) {
        await env.STABLE_KV.put("notes", JSON.stringify(notes)); // one write for the whole batch
        await bumpDataVersion(env);
      }
      return json({ results }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/notes" && request.method === "DELETE") {
      const body = await request.json().catch(() => ({}));
      const notes = (await readNotes(env)).filter(n => n.id !== body.id);
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      await bumpDataVersion(env);
      return json({ notes }, 200, { "Cache-Control": "no-store" });
    }

    // Lets a wrong horse/trainer/quote get corrected in place instead of a
    // delete-and-recreate round trip — confirmed real need: every auto-
    // import source here is best-effort text extraction (DRF/TDN/HRN/
    // SmartPony), and a misattribution slipping through is a "fix this one
    // note" problem, not a "rebuild the whole pipeline" one. Same no-gate
    // trust level as every other /notes route. `link` was added alongside
    // the original three client-editable fields to fix a batch of manually-
    // pushed notes that carried a broken drf.com/sar_... URL (a scratch-file
    // slug that leaked into the link field) instead of the real
    // drf.com/news/... path — everything else (source, date, autoImported,
    // sentiment, importedVia, capturedAt) still stays as originally captured.
    if (url.pathname === "/notes" && request.method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      if (!body.id) return json({ error: "Missing id" }, 400);
      const notes = await readNotes(env);
      const note = notes.find(n => n.id === body.id);
      if (!note) return json({ error: "Note not found" }, 404);
      if (typeof body.trainer === "string") note.trainer = body.trainer.trim();
      if (typeof body.horse === "string") note.horse = body.horse.trim();
      if (typeof body.note === "string") note.note = body.note.trim();
      if (typeof body.link === "string") note.link = body.link.trim();
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      await bumpDataVersion(env);
      return json({ note }, 200, { "Cache-Control": "no-store" });
    }

    // One-time (and safe to re-run) cleanup for notes that are really the
    // same quote filed twice — confirmed real and split into two distinct
    // causes: (1) the SAME article re-fetched with a "#disqus_thread"
    // anchor or different URL-path casing used to dodge the old exact-
    // string link dedup (now fixed above via normalizeLinkForDedup, so this
    // shouldn't recur going forward, but the copies it already created
    // needed cleaning up) — those are pure re-import noise with nothing
    // extra to say, so the newer copy is just deleted; (2) the identical
    // quote text genuinely reported by a SECOND, different source (e.g. a
    // stable-tour PDF digest and a separate HRN recap both quoting a
    // trainer verbatim) — real, distinct coverage worth keeping a record
    // of, so instead of deleting it the second source is folded into the
    // kept note's new `extraSources` array (rendered client-side as a
    // "+N sources" badge) rather than thrown away. Groups on (trainer,
    // horse, exact note text) and keeps the EARLIEST-captured note in each
    // group as the one survivors merge into.
    if (url.pathname === "/debug-merge-duplicate-notes" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const allNotes = await readNotes(env);
      const groups = new Map();
      for (const n of allNotes) {
        const key = `${n.trainer}|${n.horse}|${(n.note || "").trim()}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(n);
      }
      const toDelete = new Set();
      let mergedWithExtraSource = 0;
      let deletedPureDupes = 0;
      for (const rows of groups.values()) {
        if (rows.length < 2) continue;
        rows.sort((a, b) => (a.capturedAt || "").localeCompare(b.capturedAt || ""));
        const primary = rows[0];
        const seenLinks = new Set([normalizeLinkForDedup(primary.link)]);
        for (const dupe of rows.slice(1)) {
          const normLink = normalizeLinkForDedup(dupe.link);
          if (!seenLinks.has(normLink) && (dupe.source || dupe.link)) {
            if (!primary.extraSources) primary.extraSources = [];
            primary.extraSources.push({ source: dupe.source || "", link: dupe.link || "" });
            seenLinks.add(normLink);
            mergedWithExtraSource++;
          } else {
            deletedPureDupes++;
          }
          toDelete.add(dupe.id);
        }
      }
      const notes = allNotes.filter(n => !toDelete.has(n.id));
      await env.STABLE_KV.put("notes", JSON.stringify(notes));
      if (toDelete.size) await bumpDataVersion(env);
      return json({
        groupsWithDuplicates: [...groups.values()].filter(r => r.length > 1).length,
        deletedPureDupes,
        mergedWithExtraSource,
        totalRemoved: toDelete.size,
      }, 200, { "Cache-Control": "no-store" });
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

    if (url.pathname === "/nyra-news" && request.method === "GET") {
      let result;
      try {
        result = await fetchNyraNews();
      } catch (err) {
        return json({ error: `NYRA News fetch failed: ${err.message}` }, 502);
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
        // rolling over to the next day's card — see job #9's comment. Only
        // written when the value actually changed since last time — this
        // route is polled every 10 minutes per open tab (nominally a GET),
        // and writing unconditionally here was a large, easy-to-miss drain
        // on the daily KV write quota for no benefit most of the time.
        try {
          const key = trackConditionsKvKey(track, parsed.cardDate);
          const serialized = JSON.stringify(parsed);
          const existing = await env.STABLE_KV.get(key);
          if (existing !== serialized) {
            await env.STABLE_KV.put(key, serialized);
          }
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
        else if (source === "smartpony") result = await fetchSmartPonyEntriesDay(track, date);
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
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const results = Array.isArray(body.results) ? body.results : [];
      const key = racedayKvKey(track, date);
      // Called from two independent 5-minute polling loops (post-entries-load
      // and post-results-poll — see index.html's saveRaceDaySnapshot()), so
      // writing unconditionally here meant re-archiving an identical snapshot
      // hundreds of times a day. Only write when entries/results actually
      // changed — capturedAt is excluded from that comparison since it
      // changes on every call and would otherwise defeat the check.
      const existingRaw = await env.STABLE_KV.get(key);
      const existing = existingRaw ? JSON.parse(existingRaw) : null;
      const unchanged = existing
        && JSON.stringify(existing.entries) === JSON.stringify(entries)
        && JSON.stringify(existing.results) === JSON.stringify(results);
      // raceRecaps carried forward explicitly — this route rebuilds the
      // record from scratch on any real entries/results change (the normal
      // 5-minute polling loop), and without this it would silently wipe out
      // any recap text /raceday/recap had already attached to this date,
      // the same clobbering bug already found and fixed twice elsewhere in
      // this file (2026-09-03) for the exact same "rebuild without carrying
      // forward a field this route doesn't itself manage" shape.
      const record = unchanged
        ? existing
        : { track, date, entries, results, capturedAt: new Date().toISOString(), raceRecaps: existing?.raceRecaps };
      if (!unchanged) {
        await env.STABLE_KV.put(key, JSON.stringify(record));
      }
      return json({ available: true, ...record }, 200, { "Cache-Control": "no-store" });
    }

    // Attaches (or clears, with recap: "") a race recap to one race of an
    // already-archived race day, and keeps the horse->recap reverse index
    // (used by runEntryAlerts() to surface a recap when that horse runs
    // back) in sync with it. Open write, no passphrase — same reasoning as
    // /notes: free text a visitor could vandalize, but consistent with how
    // every other content-editing route in this file is already gated (or
    // not) rather than introducing a new, inconsistent bar just for this.
    if (url.pathname === "/raceday/recap" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date || "";
      const raceNumber = Number(body.raceNumber);
      const recap = typeof body.recap === "string" ? body.recap.trim() : "";
      if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !raceNumber) {
        return json({ error: "Missing track, invalid date, or missing raceNumber" }, 400);
      }
      const result = await upsertRaceRecap(env, track, date, raceNumber, recap);
      return json(result, 200, { "Cache-Control": "no-store" });
    }

    // One whole-card recap per day (not per race, no horse index — just the
    // "how did the card play overall" writeup the Google Doc puts right
    // under the date header, above the individual R# entries). Manual
    // set/clear counterpart to the auto-pull in resyncRaceRecapsFromDoc();
    // an empty recap clears it. Routes through the same read-modify-write as
    // race recaps (upsertRaceRecapsBulk with an empty recapsByRace) rather
    // than its own KV write, for the same race-condition reason documented
    // on that function.
    if (url.pathname === "/raceday/fullcard" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date || "";
      const recap = typeof body.recap === "string" ? body.recap.trim() : "";
      if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: "Missing track or invalid date" }, 400);
      }
      const result = await upsertRaceRecapsBulk(env, track, date, {}, { fullCardRecap: recap });
      return json(result, 200, { "Cache-Control": "no-store" });
    }

    // Bulk variant of the above — every race for one track+date in a single
    // read-modify-write, so an import covering a whole card can't race
    // against itself the way calling /raceday/recap once per race did (see
    // upsertRaceRecapsBulk()'s own comment on the real data loss this
    // caused). Body: { track, date, recaps: { [raceNumber]: recapText } }.
    if (url.pathname === "/raceday/recap/bulk" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date || "";
      const recaps = body.recaps && typeof body.recaps === "object" ? body.recaps : null;
      if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !recaps || !Object.keys(recaps).length) {
        return json({ error: "Missing track, invalid date, or missing recaps" }, 400);
      }
      const result = await upsertRaceRecapsBulk(env, track, date, recaps);
      return json(result, 200, { "Cache-Control": "no-store" });
    }

    // Re-pulls ONE date's recaps straight from the shared Google Doc — the
    // "↻ Re-sync from Doc" button in Race Recaps. Scoped to exactly the one
    // date requested: the doc's other date sections are never even parsed
    // into a KV write, so an edit sitting in a different section of the doc
    // can't leak into this date's recaps. See resyncRaceRecapsFromDoc()'s own
    // comment for exactly what does/doesn't get overwritten.
    if (url.pathname === "/raceday/recap/resync" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const track = (body.track || "").trim();
      const date = body.date || "";
      if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: "Missing track or invalid date" }, 400);
      }
      try {
        const result = await resyncRaceRecapsFromDoc(env, track, date);
        return json(result, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ error: `Resync failed: ${err.message}` }, 500);
      }
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

    // Manual trigger for dedupeStableTourNotes() — same reasoning as
    // /debug-run-scheduled above (also runs on the real Cron Trigger
    // already; this is the on-demand equivalent for testing, or for
    // catching up right away instead of waiting for the next firing). Gated
    // like every other write route since this deletes real notes, even
    // though the detection itself is deliberately narrow (see the
    // function's own comment on why "same source link" was rejected as a
    // signal after auditing what it would have deleted).
    if (url.pathname === "/debug-dedupe-notes" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      let result;
      try {
        result = await dedupeStableTourNotes(env);
      } catch (err) {
        return json({ error: `Note dedupe run failed: ${err.message}` }, 500);
      }
      return json(result, 200, { "Cache-Control": "no-store" });
    }

    // Manual trigger for backfillRaceDayResults() — same reasoning as
    // /debug-run-scheduled above (also runs on the real Cron Trigger
    // already, this is just the on-demand equivalent for testing or
    // catching up a gap right away instead of waiting for the next firing).
    if (url.pathname === "/debug-backfill-raceday-results" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      let result;
      try {
        result = await backfillRaceDayResults(env);
      } catch (err) {
        return json({ error: `Race day results backfill failed: ${err.message}` }, 500);
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

    // One-off: sends today's REAL matched Saratoga/Belmont/Del Mar horses
    // (same trainer/note matching as runEntryAlerts(), see
    // collectTodaysRaceGroupsForPreview()'s own comment) through
    // buildStyledEntryDigestEmail() with { isTest: true } — a "TEST — "
    // subject prefix and body label, otherwise byte-for-byte the same
    // production template — so a template tweak can be previewed against
    // today's real content without waiting for the Cron Trigger. Never
    // touches raceNotifyKvKey() dedup state.
    if (url.pathname === "/debug-send-styled-test-email" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const track = url.searchParams.get("track") || "saratoga";
      const date = url.searchParams.get("date") || entryAlertTodayDate();
      const to = url.searchParams.get("to") ? [url.searchParams.get("to")] : NOTIFY_EMAILS;
      try {
        const raceGroups = await collectTodaysRaceGroupsForPreview(env, track, date);
        if (!raceGroups.length) {
          return json({ sent: false, reason: "No tracked-trainer horses with notes matched for that track/date." }, 200, { "Cache-Control": "no-store" });
        }
        const trackLabel = ENTRIES_TRACK_LABEL[track] || track;
        const result = await sendStyledTestEmail(env, track, trackLabel, date, raceGroups, to);
        const horseCount = raceGroups.reduce((sum, g) => sum + g.horses.length, 0);
        return json({ sent: true, sentTo: to, horseCount, resendId: result.id || null }, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ error: `Styled test email failed: ${err.message}` }, 500);
      }
    }

    // Visual-preview-only variant of the route above — includes scratched
    // horses, which the real pipeline (and /debug-send-styled-test-email)
    // correctly never does. Exists purely so a Race Recap can actually be
    // looked at in a real rendered email even on a day where every horse
    // that happens to have one on file got scratched before post (added
    // 2026-09-04: both real candidates that day — Shoot the Nickel,
    // Jadorlinija — were scratched, so there was no other way to see one
    // rendered without waiting for a future card). Doesn't touch
    // runEntryAlerts()/collectTodaysRaceGroupsForPreview() at all — this is
    // its own copy specifically so the real send logic can never accidentally
    // pick up a "include scratches" code path.
    if (url.pathname === "/debug-preview-recap-email" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const track = url.searchParams.get("track") || "saratoga";
      const date = url.searchParams.get("date") || entryAlertTodayDate();
      const to = url.searchParams.get("to") ? [url.searchParams.get("to")] : NOTIFY_EMAILS;
      try {
        const state = await readNotesAndTrainers(env);
        const trackedLastNames = new Set(state.trainers.map(lastNameKey));
        const untrackedHorseNames = new Set(
          state.notes.filter((n) => !n.trainer && n.horse).map((n) => stripHorseCountrySuffix(n.horse.trim().toLowerCase()))
        );
        const recapIndex = await readRecapIndex(env, track);
        const fullCardRecapCache = {};
        const sourceType = ENTRIES_SOURCE_BY_TRACK[track];
        let result;
        if (sourceType === "nyra") result = await fetchNyraEntriesDay(track, date);
        else if (sourceType === "dmtc") result = await fetchDmtcEntriesDay(date);
        else if (sourceType === "sportinglife") result = await fetchSportingLifeEntriesDay(track, date);
        else if (sourceType === "smartpony") result = await fetchSmartPonyEntriesDay(track, date);
        else result = await fetchMonmouthEntriesDay(date);

        const raceGroups = [];
        for (const race of result.races || []) {
          const matchedHorses = [];
          for (const horse of race.horses || []) {
            // No scratch filter — the one deliberate difference from every
            // other matching path in this file.
            const trainerTracked = horse.trainer && trackedLastNames.has(lastNameKey(horse.trainer));
            const hasUntrackedNote = untrackedHorseNames.has(stripHorseCountrySuffix((horse.name || "").trim().toLowerCase()));
            const recapsRaw = recapIndex[normalizeHorseNameForRecap(horse.name)] || [];
            const recaps = [];
            for (const r of recapsRaw) {
              recaps.push({ ...r, fullCardRecap: await readFullCardRecapForDate(env, track, r.date, fullCardRecapCache) });
            }
            if (!trainerTracked && !hasUntrackedNote && !recaps.length) continue;
            const notes = notesForHorse(state.notes, horse.trainer, horse.name);
            if (!notes.length && !recaps.length) continue;
            matchedHorses.push({ horse, notes, recaps });
          }
          if (matchedHorses.length) raceGroups.push({ race, horses: matchedHorses });
        }
        if (!raceGroups.length) {
          return json({ sent: false, reason: "No matches (tracked trainer, note, or recap) for that track/date, scratched or not." }, 200, { "Cache-Control": "no-store" });
        }
        const trackLabel = ENTRIES_TRACK_LABEL[track] || track;
        const sendResult = await sendStyledTestEmail(env, track, trackLabel, date, raceGroups, to);
        const horseCount = raceGroups.reduce((sum, g) => sum + g.horses.length, 0);
        return json({ sent: true, sentTo: to, horseCount, resendId: sendResult.id || null }, 200, { "Cache-Control": "no-store" });
      } catch (err) {
        return json({ error: `Recap preview email failed: ${err.message}` }, 500);
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

    // One-time backfill for notes that predate the importedVia field (see
    // /notes POST's own comment on why it exists). Originally keyed off
    // `sentiment` presence as a stand-in for "came through SmartPony" — but
    // that's SmartPony's OWN per-quote field and is null on plenty of their
    // real quotes too, so it only ever caught a fraction of the actual
    // SmartPony-sourced notes already sitting in KV (confirmed real: a
    // direct reconciliation against a fresh SmartPony fetch found several
    // hundred more matching notes than the sentiment-only count did).
    // Re-fetches SmartPony's quotes fresh (same trainer-resolution the live
    // import itself uses) and matches on (trainer, horse, link) instead —
    // the same identity the live import's own dedup already keys on, so
    // this always agrees with "would the live import consider this the same
    // note." Same passphrase gate as every other route that mutates shared
    // state; safe to re-run (a no-op once nothing left qualifies).
    if (url.pathname === "/debug-backfill-importedvia" && request.method === "GET") {
      if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
      const notes = await readNotes(env);
      let quotes;
      try {
        quotes = await fetchSmartPonyQuotes(env);
      } catch (err) {
        return json({ error: `SmartPony fetch failed: ${err.message}` }, 502);
      }
      const smartPonyKeys = new Set(quotes.map((q) => `${q.trainerName}|${q.horseName}|${q.link || ""}`));
      let updated = 0;
      for (const n of notes) {
        if (n.importedVia) continue;
        const key = `${n.trainer}|${n.horse}|${n.link || ""}`;
        if (smartPonyKeys.has(key)) {
          n.importedVia = "SmartPony";
          updated++;
        }
      }
      if (updated) {
        await env.STABLE_KV.put("notes", JSON.stringify(notes));
        await bumpDataVersion(env);
      }
      return json({ updated, smartPonyQuotesSeen: quotes.length }, 200, { "Cache-Control": "no-store" });
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
      // Confirmed real gap: point-based lookup only catches an alert whose
      // polygon happens to cover that EXACT coordinate — a tornado warning
      // scoped to "East Central Saratoga County" never showed here because
      // the track's own point sits just outside that specific polygon, even
      // though the county-wide warning very much applied. `zone` (an NWS
      // county UGC code, e.g. "NYC091" for Saratoga County) queries every
      // active alert for the WHOLE county regardless of which sub-area a
      // given polygon covers — takes precedence over point when both are
      // given. lat/lon stays the default for tracks with no county set.
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      const zone = url.searchParams.get("zone");
      if (!zone && (!lat || !lon)) return json({ error: "Missing lat/lon or zone" }, 400);
      const nwsUrl = zone
        ? `https://api.weather.gov/alerts/active?zone=${encodeURIComponent(zone)}`
        : `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
      let res;
      try {
        res = await fetch(nwsUrl, {
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

      const horses = await extractHorseChunks(articleRes, trainer);
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

// Confirmed real bug behind a wave of "duplicate" notes: the (trainer,
// horse, link) dedup check in /notes and /notes/bulk does a plain string
// compare, so the exact same article re-fetched with a "#disqus_thread"
// anchor or a different URL-path casing ("Go-for-Launch" vs
// "go-for-launch") reads as a NEW link every time, quietly recreating the
// same note over and over. Strips the fragment and lowercases the whole
// thing before comparing — good enough for "is this the same page,"
// without needing a full URL-equivalence library.
function normalizeLinkForDedup(link) {
  if (!link) return "";
  return link.split("#")[0].toLowerCase();
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
  dick: "richard", rich: "richard", richie: "richard", rick: "richard",
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
  ray: "raymond", // Ray Handal — confirmed real: SmartPony's own "Raymond Handal" spelling spawned a duplicate tracked entry alongside the already-tracked "Ray Handal"
  rusty: "george", // Rusty Arnold — confirmed real (user's own ID): George Arnold goes by "Rusty," and SmartPony only ever uses the nickname
  charlie: "charles", // Charlie Appleby — confirmed real: SmartPony spelled his formal first name out ("Charles Appleby") and spawned a duplicate alongside the already-tracked "Charlie Appleby"
  gus: "gustavo", // Gus Rodriguez — confirmed real (user's own ID): same person as the already-tracked "Gustavo Rodriguez," separate from "Rudy Rodriguez"
  phillip: "philip", // General double-L/single-L spelling variant — confirmed real for Capuano ("Phillip" vs the already-tracked "Phil"), same category of gap "phil" above already covers for the single-L spelling
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

// ---------- Race Recaps ----------
// A race recap is free text a human writes about how a whole race actually
// played out, attached to one race of an already-archived race day (stored
// inline on that same raceday:{track}:{date} record, in a new raceRecaps
// field keyed by race number — see the /raceday POST route's own comment on
// why that route now has to carry it forward explicitly). The point of a
// recap isn't the text alone, though — it's resurfacing the WHOLE paragraph
// automatically in the entry-alert email whenever any horse who actually
// ran in that race is entered again. That needs a reverse index (horse name
// -> every recap they've appeared in) so runEntryAlerts() can do one cheap
// lookup per track instead of scanning every archived race day on every
// run. The index is built from that race's real FINISH ORDER (who actually
// ran), not the morning entries list, so a scratched horse never gets
// wrongly tagged with a recap for a race it never ran.
function raceRecapIndexKvKey(track) {
  const safeTrack = track.replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  return `racerecap-index:${safeTrack}`;
}
// Same normalization notesForHorse()/stripHorseCountrySuffix() already use
// elsewhere in this file — kept consistent so a horse's recap index entry
// and its regular notes always agree on what counts as "the same horse."
function normalizeHorseNameForRecap(name) {
  return stripHorseCountrySuffix((name || "").trim().toLowerCase());
}
async function readRecapIndex(env, track) {
  const raw = await env.STABLE_KV.get(raceRecapIndexKvKey(track));
  const parsed = raw ? JSON.parse(raw) : {};
  return parsed && typeof parsed === "object" ? parsed : {};
}

// The horse->recap reverse index (readRecapIndex above) only ever stores
// per-race recap text, not the whole-card writeup — that lives on the
// raceday record itself (record.fullCardRecap), not per-horse, so it can't
// be denormalized into the index the same way without going stale: the
// manual "Full Card Recap" edit button (POST /raceday/fullcard) writes it
// with an EMPTY recapsByRace, which would leave any already-indexed horses
// for that date pointing at a stale/missing value if it were baked in at
// index-write time instead of looked up here. `cache` is a plain object the
// caller passes in and reuses across every horse in one runEntryAlerts()/
// collectTodaysRaceGroupsForPreview() call, so two horses who ran on the
// same date only cost one KV read between them, not one each.
async function readFullCardRecapForDate(env, track, date, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, date)) return cache[date];
  const raw = await env.STABLE_KV.get(racedayKvKey(track, date));
  const value = raw ? (JSON.parse(raw).fullCardRecap || null) : null;
  cache[date] = value;
  return value;
}

// Handles one or many races for the SAME track+date in a single read-
// modify-write of both the raceday record and the recap index. Confirmed
// real bug (2026-09-04): the original version of this only ever handled one
// race per call, and a bulk import (many races for the same date, fired in
// quick sequence) raced against itself — each call read the raceday record
// before a previous call's write had landed, so whichever write finished
// last silently clobbered the others. A from-scratch backfill of 54 races
// across 5 dates lost 12 of them this way before this fix; verified clean
// (byte-for-byte) after switching the import to this bulk path. recapsByRace
// is { [raceNumber]: recapText }; an empty string clears that race's recap.
// fullCardRecap is optional and touches the SAME record in this same read-
// modify-write (not a separate KV round trip) — omit it (undefined) to leave
// the day's full-card recap untouched; pass a string ("" to clear it) to
// set/clear it alongside whichever races are being written.
async function upsertRaceRecapsBulk(env, track, date, recapsByRace, { fullCardRecap } = {}) {
  const key = racedayKvKey(track, date);
  const raw = await env.STABLE_KV.get(key);
  if (!raw) return { available: false, error: "No archived race day for this track/date yet" };
  const record = JSON.parse(raw);
  record.raceRecaps = record.raceRecaps || {};
  if (fullCardRecap !== undefined) {
    const trimmed = typeof fullCardRecap === "string" ? fullCardRecap.trim() : "";
    if (trimmed) record.fullCardRecap = trimmed;
    else delete record.fullCardRecap;
  }

  const index = await readRecapIndex(env, track);
  const indexedHorsesByRace = {};

  for (const [raceNumberStr, recapRaw] of Object.entries(recapsByRace)) {
    const raceNumber = Number(raceNumberStr);
    const recap = typeof recapRaw === "string" ? recapRaw.trim() : "";
    if (recap) record.raceRecaps[raceNumber] = recap;
    else delete record.raceRecaps[raceNumber]; // empty text clears it

    // Prefer the real finish order (who actually ran); fall back to the
    // morning entries list (non-scratched) only when results haven't been
    // archived yet for this race, so the recap still gets indexed against
    // *someone* rather than silently indexing nobody.
    const resultRace = (record.results || []).find((r) => r.raceNumber === raceNumber);
    const entryRace = (record.entries || []).find((r) => r.raceNumber === raceNumber);
    let horseNames = [];
    if (resultRace?.finishOrder?.length) {
      horseNames = resultRace.finishOrder.map((f) => f.horseName).filter(Boolean);
    } else if (entryRace?.horses?.length) {
      horseNames = entryRace.horses.filter((h) => !h.scratched).map((h) => h.name).filter(Boolean);
    }
    indexedHorsesByRace[raceNumber] = horseNames;

    // Drop any stale entry for this exact date+race first (covers both a
    // recap being edited and a recap being cleared) before adding it back —
    // otherwise re-saving the same race's recap would pile up duplicates
    // every time it's edited.
    for (const horseKey of Object.keys(index)) {
      index[horseKey] = (index[horseKey] || []).filter((r) => !(r.date === date && r.raceNumber === raceNumber));
      if (!index[horseKey].length) delete index[horseKey];
    }
    if (recap) {
      for (const name of horseNames) {
        const horseKey = normalizeHorseNameForRecap(name);
        if (!horseKey) continue;
        if (!index[horseKey]) index[horseKey] = [];
        index[horseKey].push({ date, raceNumber, recap });
      }
    }
  }

  await env.STABLE_KV.put(key, JSON.stringify(record));
  await env.STABLE_KV.put(raceRecapIndexKvKey(track), JSON.stringify(index));

  return { available: true, track, date, indexedHorsesByRace, fullCardRecap: record.fullCardRecap || null };
}

async function upsertRaceRecap(env, track, date, raceNumber, recap) {
  const result = await upsertRaceRecapsBulk(env, track, date, { [raceNumber]: recap });
  if (!result.available) return result;
  return {
    available: true, track, date, raceNumber, recap: recap || null,
    indexedHorses: result.indexedHorsesByRace[raceNumber] || [],
  };
}

// ---------- Race Recap Google Doc re-sync (POST /raceday/recap/resync) ----------
// The user writes/edits recaps by hand in one shared Google Doc (link-shared,
// "anyone with the link" — confirmed fetchable with a plain server-side
// request, no auth/bot-wall like DRF or Racing Post hit). This is the
// worker-side port of the exact parsing logic used for the original 54-race
// backfill (2026-09-04), so a "re-sync this date" button can re-pull just one
// date's section without a human re-doing the parse each time. Hardcoded, not
// client-supplied, so this route can't be pointed at an arbitrary URL.
const RACE_RECAP_DOC_EXPORT_URL = "https://docs.google.com/document/d/1mp4oK11UmuYYt0cnc1f9E7q8MTfsHe3FSwkKQHF_KMU/export?format=txt";

// Date-section boundary: a line starting with bare "M/D" (1-2 digit month,
// 1-2 digit day — the doc never writes a year), optionally prefixed with
// "Recap " (as in "Recap 9/3", "9/4 Recap:"). Deliberately NOT a loose match —
// a mid-paragraph restatement like "SAR 8/30 — fast dirt..." doesn't begin
// the line with a bare date, so it never gets mistaken for a new section.
// (?!\d) instead of a trailing \b because real entries in this doc run the
// date straight into the next word with no separator at all ("8/21Card:").
const RACE_RECAP_DATE_MARKER = /^(?:Recap\s+)?(\d{1,2})\/(\d{1,2})(?!\d)/gm;

// Race marker: "R#" at the START of its own line, optionally followed —
// still on that SAME line only — by "(...conditions...)" and/or a —/:
// separator (covers both styles the doc has used: "R1 — text" / "R1
// (conditions): text" on one line, and "R1:" or bare "R2" alone on its own
// line with the actual recap starting on a later paragraph). Confirmed real
// bug (2026-09-04): an earlier version required the —/: separator to be
// present, which meant an unfilled stub like a bare "R2" with nothing after
// it didn't match as a marker AT ALL — its own line, plus every blank line
// after it, silently got appended as trailing text onto the PREVIOUS race's
// recap instead of being skipped. The [ \t]* here (not \s*) is what fixes
// it: the hunt for optional conditions/separator can never cross a line
// break looking for one, so a marker with nothing else on its line matches
// cleanly as just that bare "R#" and nothing more leaks into it or out of
// the race before it. A genuinely empty stub (nothing at all before the
// next marker) still safely produces no recap — now because its captured
// content comes back empty, not because the marker itself failed to match.
const RACE_RECAP_RACE_MARKER = /^R(\d{1,2})\b[ \t]*(?:\([^)]*\))?[ \t]*(?:[—:][ \t]*)?/gm;

// Collapses the doc's hard mid-sentence line-wraps into spaces while still
// preserving a genuine blank-line paragraph break as one — verified
// byte-for-byte against every already-imported race's stored text before
// this route shipped (2026-09-04).
function cleanRaceRecapDocText(raw) {
  return raw
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function findRaceRecapDateSections(docText) {
  const matches = [...docText.matchAll(RACE_RECAP_DATE_MARKER)];
  return matches.map((m, i) => ({
    month: Number(m[1]),
    day: Number(m[2]),
    body: docText.slice(m.index, i + 1 < matches.length ? matches[i + 1].index : docText.length),
  }));
}

function parseRaceRecapsFromSection(sectionBody) {
  const raceMatches = [...sectionBody.matchAll(RACE_RECAP_RACE_MARKER)];
  const recaps = {};
  for (let i = 0; i < raceMatches.length; i++) {
    const m = raceMatches[i];
    const contentStart = m.index + m[0].length;
    const contentEnd = i + 1 < raceMatches.length ? raceMatches[i + 1].index : sectionBody.length;
    const cleaned = cleanRaceRecapDocText(sectionBody.slice(contentStart, contentEnd));
    // Last occurrence for a given race number wins — the doc has at least
    // one real accidental duplicate paste (8/30's Race 1), and the later
    // copy is reliably the complete/corrected one, matching how a person
    // reading top-to-bottom would resolve it themselves.
    if (cleaned) recaps[Number(m[1])] = cleaned;
  }
  return recaps;
}

// Never clears a race's recap just because the doc section for it came back
// empty/unmatched (e.g. a stub "R2:" with nothing written yet) — only races
// that actually parsed to real text are included, so upsertRaceRecapsBulk()
// only touches races the doc actually has content for. If you deliberately
// blank out a race's text in the doc, re-syncing won't clear it here — edit
// or clear it directly in Race Recaps instead.
// The whole-card writeup the doc puts right under the date header, above
// the individual "R#" entries — labeled "Full Card Recap:" going forward
// (2026-09-04). Older dates used a bare "CARD:" label instead, checked as a
// fallback so past dates can be backfilled too (2026-09-04). Take the LAST
// "CARD:" match in the pre-race span, not the first — confirmed real quirk
// in the doc's 8/30 section: a stray "CARD:" with nothing after it sits
// right under the date header, and the actual writeup's own "CARD:" comes
// later, further down, still before the first race marker.
const FULL_CARD_RECAP_LABEL = /Full\s*Card\s*Recap\s*:\s*/i;
const FULL_CARD_RECAP_FALLBACK_LABEL = /Card\s*:\s*/gi;

function parseFullCardRecapFromSection(sectionBody) {
  // NOTE: sectionBody.match(RACE_RECAP_RACE_MARKER) here would be a real bug
  // — RACE_RECAP_RACE_MARKER carries the /g flag, and .match() on a global
  // regex returns an array of matched STRINGS with no .index at all (that
  // shape only exists on a non-global match), so firstRaceMatch.index would
  // be undefined and .slice(0, undefined) silently returns the WHOLE body —
  // every race's text would leak into "the full-card recap." matchAll()
  // (or, as here, spreading it and taking [0]) is what actually gives back
  // a real match object with a usable .index.
  const [firstRaceMatch] = sectionBody.matchAll(RACE_RECAP_RACE_MARKER);
  const preRaceSpan = firstRaceMatch ? sectionBody.slice(0, firstRaceMatch.index) : sectionBody;

  const primaryMatch = preRaceSpan.match(FULL_CARD_RECAP_LABEL);
  if (primaryMatch) {
    return cleanRaceRecapDocText(preRaceSpan.slice(primaryMatch.index + primaryMatch[0].length));
  }
  const fallbackMatches = [...preRaceSpan.matchAll(FULL_CARD_RECAP_FALLBACK_LABEL)];
  const lastFallback = fallbackMatches[fallbackMatches.length - 1];
  if (!lastFallback) return "";
  return cleanRaceRecapDocText(preRaceSpan.slice(lastFallback.index + lastFallback[0].length));
}

async function resyncRaceRecapsFromDoc(env, track, date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return { available: false, error: "Invalid date" };
  const month = Number(m[2]), day = Number(m[3]);

  const docRes = await fetch(RACE_RECAP_DOC_EXPORT_URL);
  if (!docRes.ok) return { available: false, error: `Doc fetch failed: ${docRes.status}` };
  const docText = await docRes.text();

  const sections = findRaceRecapDateSections(docText);
  const section = sections.find((s) => s.month === month && s.day === day);
  if (!section) return { available: false, error: "No section for this date found in the doc" };

  const recapsByRace = parseRaceRecapsFromSection(section.body);
  const fullCardRecap = parseFullCardRecapFromSection(section.body);
  if (!Object.keys(recapsByRace).length && !fullCardRecap) {
    return { available: false, error: "Found this date in the doc, but nothing parsed out of it" };
  }
  const result = await upsertRaceRecapsBulk(env, track, date, recapsByRace, { fullCardRecap: fullCardRecap || undefined });
  if (!result.available) return result;
  return {
    available: true, track, date,
    updatedRaces: Object.keys(recapsByRace).map(Number).sort((a, b) => a - b),
    fullCardRecapUpdated: !!fullCardRecap,
  };
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

// Fills in results for already-archived race days that only ever got their
// entries saved — confirmed real gap: saveRaceDaySnapshot() (client) only
// ever writes when someone actually has that track/date's card open while
// results are posting (see /raceday POST's own comment), so a day nobody
// was watching keeps an entries-only snapshot forever with no way to
// self-correct. Runs on every scheduled() firing (piggybacks the existing
// entry-alerts Cron Trigger — no new trigger needed) and via
// /debug-backfill-raceday-results for on-demand/manual use. Bounded to a
// trailing window so a caught-up backlog doesn't re-check the same old,
// permanently-resultless dates (rained out, canceled, etc.) every run.
// Confirmed real problem via a live audit (2026-09-03): 227 redundant notes
// across 210 groups, all the SAME source article getting auto-imported
// twice a few days apart (re-scraped before the pipeline's own "already
// imported" check caught up, or a source republishing under a fresh
// timestamp). Detection is deliberately narrow — same trainer, same horse,
// and BYTE-IDENTICAL note text (after trimming and collapsing whitespace
// runs, to still catch a pure formatting-only re-scrape) — because a wider
// signal like "same source link" turned out to be unreliable: audited all
// 39 same-trainer+horse+link groups whose text differs, and every one of
// them was two genuinely different quotes from the same article (trainer
// AND jockey both quoted about the same horse, or two separate paragraphs),
// not a duplicate. Auto-merging on that signal would have deleted real,
// distinct content. Exact-text matching has no such risk — the two notes
// say the literal same thing, so keeping only the earlier one loses
// nothing. Runs on every scheduled() firing (piggybacks the existing
// entry-alerts Cron Trigger, same as backfillRaceDayResults() above — no
// new trigger needed) and via /debug-dedupe-notes for on-demand/manual use.
function dedupeNoteKey(n) {
  const norm = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
  return `${norm(n.trainer)}|${norm(n.horse)}|${norm(n.note)}`;
}
async function dedupeStableTourNotes(env) {
  const notes = await readNotes(env);
  const groups = new Map();
  notes.forEach((n) => {
    const key = dedupeNoteKey(n);
    if (!key.trim()) return; // a note with no trainer/horse/text at all — nothing to key on, leave it alone
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  });

  const toRemove = new Set();
  const examples = [];
  let duplicateGroups = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups++;
    // Earliest capturedAt wins (falls back to array order — the earlier
    // occurrence in the stored list — when capturedAt is missing on an old
    // note, so this never throws away the ONLY copy of something).
    const sorted = [...group].sort((a, b) => (a.capturedAt || "").localeCompare(b.capturedAt || ""));
    const [keep, ...dupes] = sorted;
    dupes.forEach((d) => toRemove.add(d.id));
    if (examples.length < 10) {
      examples.push({ trainer: keep.trainer, horse: keep.horse, kept: keep.id, removed: dupes.map((d) => d.id) });
    }
  }

  if (!toRemove.size) {
    return { totalBefore: notes.length, totalAfter: notes.length, duplicateGroups: 0, removed: 0, examples: [] };
  }
  const filtered = notes.filter((n) => !toRemove.has(n.id));
  await env.STABLE_KV.put("notes", JSON.stringify(filtered));
  await bumpDataVersion(env);
  return { totalBefore: notes.length, totalAfter: filtered.length, duplicateGroups, removed: toRemove.size, examples };
}

const RACEDAY_BACKFILL_LOOKBACK_DAYS = 10;
async function backfillRaceDayResults(env) {
  const cutoff = new Date(Date.now() - RACEDAY_BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const listed = await env.STABLE_KV.list({ prefix: "raceday:" });
  let checked = 0;
  let backfilled = 0;
  for (const key of listed.keys) {
    const m = key.name.match(/^raceday:([^:]+):(\d{4}-\d{2}-\d{2})$/);
    if (!m) continue;
    const [, track, date] = m;
    if (date < cutoff) continue; // too old — not worth re-checking forever
    const resultsSource = RESULTS_SOURCE_BY_TRACK[track];
    if (!resultsSource) continue; // no results source wired for this track

    const raw = await env.STABLE_KV.get(key.name);
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (Array.isArray(record.results) && record.results.length) continue; // already has results

    checked++;
    let result;
    try {
      result = resultsSource === "dmtc" ? await fetchDmtcResultsDay(date)
        : resultsSource === "sportinglife" ? await fetchSportingLifeResultsDay(track, date)
        : await fetchNyraResultsDay(track, date);
    } catch (err) {
      continue; // best-effort — one bad fetch shouldn't block the rest of the batch
    }
    const races = result?.races || [];
    if (!races.length) continue; // still nothing to backfill — card hasn't gone final yet, or genuinely no results

    await env.STABLE_KV.put(key.name, JSON.stringify({ ...record, results: races, capturedAt: new Date().toISOString() }));
    backfilled++;
  }
  return { checked, backfilled };
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
  const [trainersRaw, notesRaw, trainerMetaRaw, versionRaw] = await Promise.all([
    env.STABLE_KV.get("trainers"),
    env.STABLE_KV.get("notes"),
    env.STABLE_KV.get("trainerMeta"),
    env.STABLE_KV.get("dataVersion"),
  ]);
  return {
    trainers: trainersRaw ? JSON.parse(trainersRaw) : [],
    notes: notesRaw ? JSON.parse(notesRaw) : [],
    // name -> { source, addedAt } — how/where each tracked trainer was
    // added (manual add, or which auto-import source). Only ever set at
    // add time, never overwritten by a later re-add of the same name, so
    // it reflects genuine provenance rather than most-recent-touch.
    trainerMeta: trainerMetaRaw ? JSON.parse(trainerMetaRaw) : {},
    version: versionRaw || "0",
  };
}

// Narrower reads for routes that only ever touch one slice of the state —
// added because every route used to call readState() and pull the full
// trainers+notes+trainerMeta blob (notes alone is multiple MB at real
// data volume) even when it only needed, say, the notes array. Doesn't
// change what gets WRITTEN (still one blob per key — see readState's own
// comment on why that's not being redesigned), just avoids the wasted
// read+parse of the other two keys on routes that never touch them.
async function readNotes(env) {
  const raw = await env.STABLE_KV.get("notes");
  return raw ? JSON.parse(raw) : [];
}

async function readTrainers(env) {
  const raw = await env.STABLE_KV.get("trainers");
  return raw ? JSON.parse(raw) : [];
}

async function readNotesAndTrainers(env) {
  const [notesRaw, trainersRaw] = await Promise.all([
    env.STABLE_KV.get("notes"),
    env.STABLE_KV.get("trainers"),
  ]);
  return {
    notes: notesRaw ? JSON.parse(notesRaw) : [],
    trainers: trainersRaw ? JSON.parse(trainersRaw) : [],
  };
}

async function readTrainersAndMeta(env) {
  const [trainersRaw, trainerMetaRaw] = await Promise.all([
    env.STABLE_KV.get("trainers"),
    env.STABLE_KV.get("trainerMeta"),
  ]);
  return {
    trainers: trainersRaw ? JSON.parse(trainersRaw) : [],
    trainerMeta: trainerMetaRaw ? JSON.parse(trainerMetaRaw) : {},
  };
}

// Bumped once per mutating call to trainers/notes/trainerMeta, right
// alongside the write(s) that actually happen — lets the client check
// GET /data/version (one tiny KV read) instead of re-pulling the full
// dataset on every 5-minute poll just to find out nothing changed.
async function bumpDataVersion(env) {
  try {
    await env.STABLE_KV.put("dataVersion", Date.now().toString());
  } catch (err) {
    // best-effort — a missed bump just costs one extra full client refetch
    // next time, not stale data (the client still has its old copy either way)
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
//
// Confirmed real bug (2026-08-30): a Q&A-style piece (a trainer, or a
// co-trainer pair, interviewed horse-by-horse) alternates "Horse Name:
// description" with "Trainer: 'quote'" paragraphs using the exact same
// "Name: text" shape — the code had no way to tell those apart, so every
// speaker line started a brand-new chunk under the SPEAKER's own name
// ("Casse", "Tonja", "John" — literally the trainer's own name) instead of
// being folded into the horse chunk it was actually answering for. That
// both fabricated fake "horses" out of the trainer's own name AND
// truncated the real horse's chunk down to just its lead-in description,
// silently dropping the actual quote. Trainer name tokens (handling a
// co-trainer "X and Y Z" string, or just "X Y" for one person) are now
// excluded from ever starting a new chunk — a match there is always the
// trainer being quoted, so it's merged into whatever horse chunk is
// currently open instead. Known residual gap, same spirit as every other
// "necessarily incomplete" note elsewhere in this file: a THIRD-party
// speaker quoted in passing (a PR staffer, an owner) isn't derivable from
// the trainer name and can still spawn a stray one-off chunk under their
// name — rare enough, and low-value enough when it happens, that it isn't
// worth chasing with a maintained name list.
async function extractHorseChunks(response, trainer) {
  const html = await response.text();
  const body = extractArticleBody(html);
  const paragraphs = htmlToPlainParagraphs(body);

  const speakerTokens = new Set(
    (trainer || "")
      .replace(/\band\b/gi, " ")
      .split(/\s+/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
  );

  const HORSE_COLON = /^([A-Z][A-Za-z.'’\-\s]{1,40}):\s*([\s\S]*)$/;
  const chunks = [];
  let current = null;
  for (const p of paragraphs) {
    const m = p.match(HORSE_COLON);
    const isSpeakerLabel = m && speakerTokens.has(m[1].trim().toLowerCase());
    if (m && !isSpeakerLabel && m[1].trim().split(/\s+/).length <= 5) {
      if (current) chunks.push(current);
      current = { horse: m[1].trim(), text: m[2].trim() };
      continue;
    }
    if (isSpeakerLabel) {
      if (current) current.text += (current.text ? "\n\n" : "") + m[2].trim();
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
//
// Belmont re-added 2026-09-04, but gated: NYRA_TRACK_MEET_WINDOWS below
// makes fetchNyraEntriesDay()/fetchNyraResultsDay() refuse to even ATTEMPT
// the fetch for any date outside Belmont's confirmed live window, so the
// substitution bug above can't happen — outside the window this just
// returns an honest empty card, same as "not wired up." This does NOT
// satisfy "verified fresh against a real live card" on its own (still
// dark as of this writing) — ALERT_TRACKS deliberately still excludes
// belmont until that real verification happens once Sept 18 arrives.
const NYRA_ENTRIES_BASE = { saratoga: "https://www.nyra.com/saratoga", belmont: "https://www.nyra.com/belmont" };

// Confirmed meet windows for NYRA tracks whose rdl/race endpoint has been
// caught silently substituting another track's live card while dark (see
// NYRA_ENTRIES_BASE's own comment on Belmont) — fetchNyraEntriesDay() and
// fetchNyraResultsDay() both refuse to fetch for a date outside this
// window. Saratoga isn't listed here: its own meet dates were never the
// problem (it's the track that gets wrongly substituted IN, not the one
// needing a guard), so it stays ungated. Update this window by hand if
// Belmont's fall meet dates ever change from what NYRA has published.
const NYRA_TRACK_MEET_WINDOWS = { belmont: { start: "2026-09-18", end: "2026-12-06" } };

function nyraTrackMeetIsDark(track, date) {
  const window = NYRA_TRACK_MEET_WINDOWS[track];
  return !!window && (date < window.start || date > window.end);
}

// Maps a track id to which entries scraper handles it — checked before
// either fetchNyraEntriesDay() or fetchDmtcEntriesDay() runs. Add a track
// here only once its source has actually been fetched and its markup
// verified (same rule as every other scrape in this file) — see
// NYRA_ENTRIES_BASE's own comment on why belmont briefly being a declared
// exception to that rule was a real bug, not a harmless shortcut.
const ENTRIES_SOURCE_BY_TRACK = {
  saratoga: "nyra", belmont: "nyra", delmar: "dmtc", monmouth: "monmouth",
  york: "sportinglife", ascot: "sportinglife", epsomdowns: "sportinglife", newmarket: "sportinglife",
  curragh: "sportinglife", longchamp: "sportinglife",
  shatin: "sportinglife", happyvalley: "sportinglife", meydan: "sportinglife",
  // "smartpony" — see SMARTPONY_TRACK_CODE's own comment: every track here
  // had no other free source at all after checking its own site plus
  // DRF/HRN/TwinSpires, confirmed 2026-09-04.
  churchilldowns: "smartpony", santaanita: "smartpony", oaklawnpark: "smartpony",
  keeneland: "smartpony", gulfstreampark: "smartpony", colonialdowns: "smartpony",
  kentuckydowns: "smartpony", ellispark: "smartpony", fairgrounds: "smartpony",
};

// Tracks job #16's entry alerts actually scans — a deliberate subset of
// ENTRIES_SOURCE_BY_TRACK above (that map stays as-is for the Entries tab,
// which is fine showing every track it supports for manual browsing).
// Confirmed real ask 2026-08-26: alerts should stay focused on the US
// tracks that matter here, not fire on every international/UK track the
// Entries tab happens to support. Belmont deliberately isn't in this list
// yet even though it's now in ENTRIES_SOURCE_BY_TRACK/RESULTS_SOURCE_BY_TRACK
// (2026-09-04) — NYRA_TRACK_MEET_WINDOWS stops it from ever returning
// Saratoga's card mislabeled as Belmont, but that guard alone isn't the
// same thing as fetching and verifying a REAL live Belmont card, which
// still hasn't happened (meet opens Sept 18, 2026). Add belmont here once
// that's done.
//
// The 9 SmartPony-sourced tracks (see SMARTPONY_TRACK_CODE) went straight
// in on 2026-09-04, no staged wait like Belmont's — SmartPony's data is
// filtered by an exact track+date match against a real relational
// database, not scraped off a page that could silently substitute the
// wrong track's card, so the specific risk that gates Belmont here
// (verified stale/wrong data looking valid) doesn't apply the same way.
// Most of them are still dark right now (off-season) — nothing fires
// until each meet actually has a race carded, same as any other track.
const ALERT_TRACKS = [
  "saratoga", "delmar",
  "churchilldowns", "santaanita", "oaklawnpark", "keeneland",
  "gulfstreampark", "colonialdowns", "kentuckydowns", "ellispark", "fairgrounds",
];

// Same idea as ENTRIES_SOURCE_BY_TRACK, for the /results route — separate
// map (not reused from ENTRIES_SOURCE_BY_TRACK) because a track can have
// entries wired up before its results page has actually been verified, or
// vice versa; the two shouldn't silently move in lockstep.
const RESULTS_SOURCE_BY_TRACK = {
  saratoga: "nyra", belmont: "nyra", delmar: "dmtc",
  york: "sportinglife", ascot: "sportinglife", epsomdowns: "sportinglife", newmarket: "sportinglife",
  curragh: "sportinglife", longchamp: "sportinglife",
  shatin: "sportinglife", happyvalley: "sportinglife", meydan: "sportinglife",
};

// Same idea again, for the /changes route (DMTC's free-text race-notes
// feed — see parseDmtcChanges()'s own file-level comment). No NYRA
// equivalent exists yet, so this only has Del Mar for now. (Fair Grounds
// briefly had a scratches-only version of this 2026-09-04, superseded the
// same day once SmartPony turned out to cover full entries for it — see
// SMARTPONY_TRACK_CODE below.)
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
  // See NYRA_TRACK_MEET_WINDOWS's own comment — refuse to fetch for a dark
  // date rather than risk another track's card silently coming back
  // mislabeled as this one.
  if (nyraTrackMeetIsDark(track, date)) return { date, races: [] };
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
  // See NYRA_TRACK_MEET_WINDOWS's own comment — same guard as
  // fetchNyraEntriesDay() above, same substitution risk.
  if (nyraTrackMeetIsDark(track, date)) return { date, races: [] };
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
    // Also matches "trained by" (not just "trainer") — confirmed real: TDN's
    // own "Trained by Hall of Famer Steve Asmussen, Powerline is..." never
    // registered a trainer name at all under "trainer"-only, so Asmussen's
    // own horses had nothing to attach to and drifted onto whichever OTHER
    // trainer happened to be nearby. The optional "Hall of Famer/Fame"
    // skip is its own confirmed-real fix — without it, "Hall" itself (from
    // "Hall of Famer Steve Asmussen") got captured as a bogus trainer name.
    const trainerMatch = inner.match(/\b(?:[Tt]rainer|[Tt]rained by)\s+(?:Hall of Famer?\s+)?([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})/);
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

  // Confirmed real bug this whole block fixes: a TDN Notebook article
  // bundles several unrelated mini-stories into one page (a trainer's own
  // horse, then a jockey milestone, then a completely different trainer's
  // horse), and the old code accumulated EVERY horse ever proximity-matched
  // to a trainer into one shared bucket, then filed that bucket's full
  // combined text under EACH horse — "Chad Summers" ended up credited with
  // both his own Napoleon Solo AND rival Baby Vino (mentioned only as "the
  // horse that caught him"), verbatim identical text under both. Neither
  // rival paragraph even named the trainer it got glued to; that's the
  // actual signal used below to tell a trainer's own additional horse
  // ("Rodriguez ALSO gave an update on HIS 2-year-old Flight Command" —
  // names him directly) apart from a horse merely mentioned nearby while
  // discussing someone else's.
  const rivalPhraseRe = new RegExp(
    [
      "face the likes of", "horses that will get plenty of play are",
      "\\bcaught by\\b", "who is also running", "\\bbeat\\b", "\\bbeaten by\\b",
      "\\brival\\b", "\\bagainst\\b.{0,20}\\bin the\\b",
      "\\bby\\s+[\\w./ ]{0,15}\\s*lengths?\\s+over\\b",
    ].join("|"),
    "i"
  );

  const assigned = {}; // name -> [{ idx, horseNames }] in paragraph order
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
    if (!assigned[best]) assigned[best] = [];
    assigned[best].push({ idx: i, horseNames: paras[i].horseNames });
  }

  const sections = [];
  for (const [trainerName, entries] of Object.entries(assigned)) {
    const lastName = trainerName.split(/\s+/).pop();
    // Rival-listing paragraphs are never trusted, whether they're the
    // first paragraph proximity-matched to this trainer or a later one —
    // confirmed real: a trainer's own horse can sit too far away (outside
    // TDN_PROXIMITY_WINDOW) for this pass to ever reach at all, leaving
    // only a rival-comparison paragraph in range; better to credit this
    // trainer with nothing here than with someone else's horse.
    const cleanEntries = entries.filter((e) => !rivalPhraseRe.test(paras[e.idx].plain));
    if (!cleanEntries.length) continue;
    const claimed = new Set(cleanEntries[0].horseNames);
    const keptIdx = [cleanEntries[0].idx];
    for (const { idx, horseNames } of cleanEntries.slice(1)) {
      const newHorses = horseNames.filter((h) => !claimed.has(h));
      if (!newHorses.length) { keptIdx.push(idx); continue; }
      // A later paragraph introducing a genuinely NEW horse is only
      // trusted as this trainer's own if it names the trainer directly —
      // proximity to some OTHER paragraph that happened to mention him
      // isn't enough (that's exactly how Baby Vino/Golden Tempo/Renegade/
      // Sea Strike got glued onto the wrong trainer originally).
      if (new RegExp(`\\b${escapeRegExpTdn(lastName)}\\b`).test(paras[idx].plain)) {
        for (const h of newHorses) claimed.add(h);
        keptIdx.push(idx);
      }
    }
    sections.push({
      trainerName,
      horseNames: [...claimed],
      text: keptIdx.sort((a, b) => a - b).map((i) => paras[i].plain).join(" ").slice(0, 1500),
    });
  }
  return sections;
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
// Entries data sometimes carries a trailing country-of-origin suffix
// ("Storm Miami (IRE)") that a note filed under the plain name ("Storm
// Miami") would otherwise never match — confirmed real: a live entry
// alert for a foreign-bred horse was silently missed over exactly this
// mismatch. Stripped from both sides before comparing, not just the
// entries side, in case a note itself ever picks up the suffix too (e.g.
// copied straight from an article headline).
function stripHorseCountrySuffix(name) {
  return name.replace(/\s*\([a-z]{2,4}\)\s*$/i, "").trim();
}

function notesForHorse(notes, trainer, horseName) {
  if (!horseName) return [];
  const wantHorse = stripHorseCountrySuffix(horseName.trim().toLowerCase());
  const horseMatches = notes.filter((n) => n.horse && stripHorseCountrySuffix(n.horse.trim().toLowerCase()) === wantHorse);
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
  saratoga: "Saratoga", belmont: "Belmont", delmar: "Del Mar", monmouth: "Monmouth",
  york: "York", ascot: "Ascot", epsomdowns: "Epsom Downs", newmarket: "Newmarket",
  curragh: "Curragh", longchamp: "Longchamp",
  shatin: "Sha Tin", happyvalley: "Happy Valley", meydan: "Meydan",
  churchilldowns: "Churchill Downs", santaanita: "Santa Anita", oaklawnpark: "Oaklawn Park",
  keeneland: "Keeneland", gulfstreampark: "Gulfstream Park", colonialdowns: "Colonial Downs",
  kentuckydowns: "Kentucky Downs", ellispark: "Ellis Park", fairgrounds: "Fair Grounds",
};

// One combined digest per track per day instead of a separate email per
// horse (confirmed real change requested 2026-08-26 — the old version, one
// Resend send per matched horse, was too noisy). raceGroups is already
// sorted by race number: [{ race, horses: [{ horse, notes }] }].
//
// The actual HTML/CSS is buildStyledEntryDigestEmail() below — chosen
// 2026-08-26 after a design-exploration pass across 10+ styles in a
// standalone Artifact (Style A's tote-board layout, re-skinned per track:
// red/white for Saratoga, green/gold for Belmont, turquoise/coral for Del
// Mar — see STYLED_DIGEST_TRACK_THEME). This replaced an earlier plain
// <h2>/<h3>/<ul> template that shipped first.
async function sendEntryDigestEmail(env, track, trackLabel, date, raceGroups) {
  const { subject, html } = buildStyledEntryDigestEmail(track, trackLabel, date, raceGroups);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: NOTIFY_EMAILS, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
}

// ---------- Styled entry digest (2026-08-26 design pass) ----------
// buildStyledEntryDigestEmail() below is the actual production template
// sendEntryDigestEmail() uses (see that function's own comment for how it
// got picked). sendStyledTestEmail()/the /debug-send-styled-test-email
// route reuse the exact same builder with { isTest: true } — a "TEST — "
// subject prefix and body label, no dedup KV writes — so a template tweak
// can be previewed against today's real matched horses without waiting
// for the Cron Trigger or touching raceNotifyKvKey() state. Fonts are
// Georgia/Arial/Courier New throughout — the exact fallback stack Gmail
// actually renders, since Gmail strips custom web fonts entirely — confirmed
// against the artifact's own Style K, which was re-checked against this
// same stack before it was picked as the production template.

// Server-side port of index.html's SADDLECLOTH_COLORS/ppBadgeHtml (job's
// own client-side comment explains the >12 "no dedicated color" gap the
// same way) — duplicated here rather than shared since the worker and
// client are separate JS runtimes with no shared module today.
const SADDLECLOTH_COLORS_EMAIL = {
  1: { bg: "#e21f26", fg: "#ffffff" }, 2: { bg: "#ffffff", fg: "#000000" },
  3: { bg: "#1c4faa", fg: "#ffffff" }, 4: { bg: "#ffd400", fg: "#000000" },
  5: { bg: "#1a7a3c", fg: "#ffffff" }, 6: { bg: "#000000", fg: "#ffd400" },
  7: { bg: "#f7941d", fg: "#000000" }, 8: { bg: "#f2a7c3", fg: "#000000" },
  9: { bg: "#40e0d0", fg: "#000000" }, 10: { bg: "#7b2d8e", fg: "#ffffff" },
  11: { bg: "#9a9a9a", fg: "#c1272d" }, 12: { bg: "#9acd32", fg: "#000000" },
};
function ppBadgeHtmlEmail(postPosition) {
  const n = parseInt(postPosition, 10);
  const colors = SADDLECLOTH_COLORS_EMAIL[n];
  if (!colors) {
    return `<span style="display:inline-block; font-family:'Courier New',Courier,monospace; font-weight:700; font-size:12px;">${escapeHtmlForEmail(postPosition || "—")}</span>`;
  }
  return `<span style="display:inline-block; width:20px; height:20px; line-height:20px; text-align:center; border-radius:4px; border:1px solid rgba(0,0,0,0.35); background:${colors.bg}; color:${colors.fg}; font-family:'Courier New',Courier,monospace; font-weight:700; font-size:12px; vertical-align:middle;">${n}</span>`;
}

// Rebuilds today's real matched horses (same trainer/note matching
// runEntryAlerts() uses) WITHOUT checking or writing raceNotifyKvKey()
// dedup entries — so it reproduces today's actual digest content even
// after the real cron run already marked those same horses as notified.
// Preview-only; never called from the real Cron Trigger / runEntryAlerts()
// path.
async function collectTodaysRaceGroupsForPreview(env, track, date) {
  const state = await readNotesAndTrainers(env); // trainerMeta isn't used anywhere in this function
  const trackedLastNames = new Set(state.trainers.map(lastNameKey));
  const untrackedHorseNames = new Set(
    state.notes.filter((n) => !n.trainer && n.horse).map((n) => stripHorseCountrySuffix(n.horse.trim().toLowerCase()))
  );
  // Kept in sync with runEntryAlerts()'s own matching rules by hand — this
  // is a preview/test path (no dedup writes, no real send unless the caller
  // asks), not the real scheduled one, so it can't just call that function
  // directly, but the matching logic itself (including job #22's recap
  // trigger) needs to stay identical or a test send stops meaning anything.
  const recapIndex = await readRecapIndex(env, track);
  const fullCardRecapCache = {};
  const sourceType = ENTRIES_SOURCE_BY_TRACK[track];
  let result;
  if (sourceType === "nyra") result = await fetchNyraEntriesDay(track, date);
  else if (sourceType === "dmtc") result = await fetchDmtcEntriesDay(date);
  else if (sourceType === "sportinglife") result = await fetchSportingLifeEntriesDay(track, date);
  else if (sourceType === "smartpony") result = await fetchSmartPonyEntriesDay(track, date);
  else result = await fetchMonmouthEntriesDay(date);

  const raceGroups = [];
  for (const race of result.races || []) {
    const matchedHorses = [];
    for (const horse of race.horses || []) {
      if (horse.scratched) continue;
      const trainerTracked = horse.trainer && trackedLastNames.has(lastNameKey(horse.trainer));
      const hasUntrackedNote = untrackedHorseNames.has(stripHorseCountrySuffix((horse.name || "").trim().toLowerCase()));
      const recapsRaw = recapIndex[normalizeHorseNameForRecap(horse.name)] || [];
      const recaps = [];
      for (const r of recapsRaw) {
        recaps.push({ ...r, fullCardRecap: await readFullCardRecapForDate(env, track, r.date, fullCardRecapCache) });
      }
      if (!trainerTracked && !hasUntrackedNote && !recaps.length) continue;
      const notes = notesForHorse(state.notes, horse.trainer, horse.name);
      if (!notes.length && !recaps.length) continue;
      matchedHorses.push({ horse, notes, recaps });
    }
    if (matchedHorses.length) raceGroups.push({ race, horses: matchedHorses });
  }
  return raceGroups;
}

// Per-track accent colors for the styled preview — same values used in the
// design-exploration artifact's Style K (Saratoga)/L (Belmont)/M (Del Mar).
const STYLED_DIGEST_TRACK_THEME = {
  saratoga: { accent: "#a3241f", bg: "#fffdfa", ink: "#2a1c17", dim: "#8a6f68", hairline: "#ecdcd9" },
  belmont: { accent: "#0d3b2a", bg: "#fbfdfb", ink: "#14211a", dim: "#6b8074", hairline: "#e3ede6" },
  delmar: { accent: "#0e8a8a", bg: "#fdfaf3", ink: "#1c3a3a", dim: "#5c7a78", hairline: "#e3ddc8" },
  // Added 2026-09-04 for the 9 SmartPony-sourced tracks. First pass used
  // each site's own <meta name="theme-color"> tag, but that turned out to
  // be a modern-website UI accent, not each track's actual recognizable
  // identity (confirmed real feedback: Churchill Downs, Santa Anita, and
  // Keeneland "seemed off") — Churchill Downs and Keeneland's real logo
  // assets both happened to be teal/dark-green (confirmed by sampling the
  // actual PNG/ICO pixels directly), and Santa Anita's live site really
  // does use bright teal throughout its UI, but none of that is what
  // actually reads as "Churchill Downs" or "Santa Anita" to someone who
  // knows racing. Redone using each track's real iconic association
  // instead: Churchill Downs -> the garland of roses/Twin Spires red
  // (distinguished from Saratoga's own warmer brick-red by leaning cooler,
  // toward burgundy); Santa Anita -> the yellow lettering on its famous
  // starting-gate sign (confirmed real ask); Keeneland keeps its real
  // sampled dark green (#005941, from its own favicon) — now that the
  // other two are off teal, it's the only green track, so the
  // differentiation problem that prompted this redo resolves on its own;
  // Gulfstream Park -> the navy blue of its own live header bar (confirmed
  // by viewing the actual rendered page, not just its theme-color meta).
  // Oaklawn Park's tan/gold (#b49e6c) was independently confirmed twice
  // (theme-color tag AND its own apple-touch-icon's actual pixels) and is
  // unchanged. Kentucky Downs' forest-green-and-beige comes from a direct
  // description of The Mint's own logo, cross-checked against its real
  // favicon (#003b1f). Keeneland, Colonial Downs, Ellis Park, and Fair
  // Grounds still have no independently-sampled brand color beyond what's
  // noted above, so Colonial Downs (rose/pink, from "Rosie's Gaming
  // Emporium"), Ellis Park (amber, chosen only to stay visually distinct
  // from Kentucky Downs' green), and Fair Grounds (Mardi Gras purple, its
  // home city's own association) remain best-available placeholders, not
  // verified brand colors — revisit if a real one ever turns up.
  // bg/ink/dim/hairline for all 9 are hand-derived to match each accent's
  // hue, same relationship as the three original themes above.
  churchilldowns: { accent: "#8a1538", bg: "#fdf7f8", ink: "#2a1620", dim: "#8a6070", hairline: "#ecdbe1" },
  santaanita: { accent: "#c9971f", bg: "#fdfaf3", ink: "#2e2410", dim: "#8a7a52", hairline: "#ede3c8" },
  oaklawnpark: { accent: "#b49e6c", bg: "#fdfbf6", ink: "#2e2718", dim: "#8a7a5c", hairline: "#ede6d6" },
  keeneland: { accent: "#0d5c44", bg: "#f6fbf8", ink: "#123328", dim: "#5c8274", hairline: "#dcece4" },
  gulfstreampark: { accent: "#16406b", bg: "#f6f9fc", ink: "#12222f", dim: "#5c7284", hairline: "#dce4ec" },
  colonialdowns: { accent: "#c2185b", bg: "#fdf7fa", ink: "#2e1420", dim: "#8a5c70", hairline: "#ecdce3" },
  // Shifted warmer/more olive than a first pass's #1a4d2e, which read too
  // close to Keeneland's own cooler teal-green in the track list — still
  // the same real sampled forest-green family (#003b1f), just leaning
  // toward the beige half of "forest green and beige" for separation.
  kentuckydowns: { accent: "#4a5a1f", bg: "#f8f6ee", ink: "#22240f", dim: "#7c7a5c", hairline: "#e6e3d0" },
  ellispark: { accent: "#b5772c", bg: "#fdf9f3", ink: "#2e2013", dim: "#8a7458", hairline: "#ede2d0" },
  fairgrounds: { accent: "#5b2c83", bg: "#faf7fd", ink: "#201530", dim: "#7a6b8a", hairline: "#e6ddf0" },
};

// Site-domain tag on a note (e.g. "drf.com") — derived from the note's own
// stored link, same as index.html's stableNoteSiteLabel(). Only ever a
// display addition; never stored, so it stays in sync automatically if a
// note's link ever changes.
function siteLabelForEmail(link) {
  if (!link) return null;
  try { return new URL(link).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

// entryAlertTodayDate() always hands this a "YYYY-MM-DD" string — reformat
// to M/D/YYYY for the email subject/header (US reader-facing date order,
// not ISO's year-first).
function formatEmailDateLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return dateStr;
  const [, year, month, day] = m;
  return `${Number(month)}/${Number(day)}/${year}`;
}

// Full untruncated note text, each as its own <div> (not a <ul><li> list,
// to match the artifact's card layout) — inline-styled throughout since
// Gmail strips most <style>-block rules and never renders custom web fonts
// at all, hence Georgia/Arial/Courier New everywhere instead of the
// artifact's own Oswald/Fraunces/JetBrains Mono. isTest only changes the
// subject prefix and the header's date line — everything else (colors,
// layout, badges, full quotes) is identical between a real send and a
// preview one.
function buildStyledEntryDigestEmail(track, trackLabel, date, raceGroups, { isTest = false } = {}) {
  const theme = STYLED_DIGEST_TRACK_THEME[track] || STYLED_DIGEST_TRACK_THEME.saratoga;
  const horseCount = raceGroups.reduce((sum, g) => sum + g.horses.length, 0);
  const dateLabel = formatEmailDateLabel(date);
  const subject = `${isTest ? "TEST — " : ""}GiddyUpQuotes — ${trackLabel} Edition — ${horseCount} horse${horseCount === 1 ? "" : "s"} today (${dateLabel})`;
  const racesHtml = raceGroups.map(({ race, horses }) => {
    const postTime = formatPostTimeLabelServer(race.postTimeIso) || race.mtpLabel || "—";
    const conditionsBits = [race.purse, race.raceType].filter(Boolean).join(" ");
    const distBits = [race.distanceLabel, race.surface].filter(Boolean).join(" · ");
    const raceTag = [`RACE ${race.raceNumber}`, postTime, conditionsBits, distBits].filter(Boolean).join(" · ");
    const horsesHtml = horses.map(({ horse, notes, recaps }) => {
      const badge = horse.postPosition ? ppBadgeHtmlEmail(horse.postPosition) : "";
      // Full, untruncated note text — no slicing anywhere in this path.
      const notesHtml = notes.map((n) => {
        const siteLabel = siteLabelForEmail(n.link);
        const siteTag = siteLabel
          ? ` <span style="display:inline-block; font-size:9px; font-family:'Courier New',Courier,monospace; color:${theme.dim}; background:rgba(0,0,0,0.06); padding:1px 5px; border-radius:3px;">${escapeHtmlForEmail(siteLabel)}</span>`
          : "";
        return `
        <div style="font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:${theme.ink}; border-left:2px solid ${theme.accent}; padding-left:10px; margin:4px 0 10px;">
          <strong>${escapeHtmlForEmail(n.date ? formatEmailDateLabel(n.date) : "—")}</strong> (${escapeHtmlForEmail(n.autoImported ? (n.source || "auto-imported") : "manual")})${siteTag}: ${escapeHtmlForEmail(n.note)}
        </div>
      `;
      }).join("");
      // Filled box (not the notes' plain left-border style) so a race recap
      // reads as visually distinct at a glance — this is "how this horse's
      // actual last race went," a different kind of information than a
      // quote or observation, and shouldn't blend in with regular notes.
      // A FULL CARD RECAP box (when that date has one) sits right above its
      // matching RACE RECAP box, broad context before the specific race —
      // dashed/muted styling on purpose so it doesn't compete with the
      // solid-accent race recap for attention. Wired in the same way the
      // race recap itself is: an independent per-date lookup attached to
      // each recap entry in runEntryAlerts()/collectTodaysRaceGroupsForPreview(),
      // not stored on the horse/note data itself.
      const recapsHtml = (recaps || []).map((r) => {
        const dateLabel = r.date ? formatEmailDateLabel(r.date) : "—";
        const fullCardHtml = r.fullCardRecap ? `
          <div style="background:rgba(0,0,0,0.03); border:1px dashed ${theme.dim}; border-radius:6px; padding:10px 12px; margin:4px 0 6px;">
            <span style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10px; letter-spacing:0.05em; color:${theme.dim}; margin-bottom:4px;">FULL CARD RECAP &mdash; ${escapeHtmlForEmail(dateLabel)}</span>
            <div style="font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:${theme.ink};">${escapeHtmlForEmail(r.fullCardRecap)}</div>
          </div>
        ` : "";
        return `
        ${fullCardHtml}
        <div style="background:rgba(0,0,0,0.05); border:1px solid ${theme.accent}; border-radius:6px; padding:10px 12px; margin:4px 0 10px;">
          <span style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10px; letter-spacing:0.05em; color:${theme.accent}; margin-bottom:4px;">RACE RECAP &mdash; ${escapeHtmlForEmail(dateLabel)}${r.raceNumber ? ` RACE ${escapeHtmlForEmail(String(r.raceNumber))}` : ""}</span>
          <div style="font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:${theme.ink};">${escapeHtmlForEmail(r.recap)}</div>
        </div>
      `;
      }).join("");
      return `
        <div style="margin:10px 0 3px;">
          ${badge ? `${badge}<span style="display:inline-block; width:6px;">&nbsp;</span>` : ""}<span style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:15px; color:${theme.ink}; vertical-align:middle;">${escapeHtmlForEmail(horse.name || "Horse")}</span>
        </div>
        <div style="font-family:'Courier New',Courier,monospace; font-size:10.5px; color:#000000; margin-bottom:5px;">${escapeHtmlForEmail(horse.trainer || "—")}${horse.jockey ? ` &middot; ${escapeHtmlForEmail(horse.jockey)}` : ""}</div>
        ${recapsHtml}
        ${notesHtml}
      `;
    }).join("");
    return `
      <div style="padding:16px 30px; border-bottom:1px solid ${theme.hairline};">
        <span style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px; letter-spacing:0.06em; background:${theme.accent}; color:#ffffff; padding:3px 9px; border-radius:3px; margin-bottom:10px;">${escapeHtmlForEmail(raceTag)}</span>
        ${horsesHtml}
      </div>
    `;
  }).join("");
  const html = `
    <div style="background:${theme.bg}; color:${theme.ink}; font-family:Georgia,'Times New Roman',serif; max-width:640px; margin:0 auto;">
      <div style="padding:26px 30px 20px; text-align:center; border-bottom:3px double ${theme.accent};">
        <div style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:22px; color:${theme.accent}; margin-bottom:6px;">GiddyUpQuotes &mdash; ${escapeHtmlForEmail(trackLabel)} Edition</div>
        <div style="font-family:'Courier New',Courier,monospace; font-size:11px; color:${theme.dim};">${isTest ? "TEST SEND &middot; " : ""}${escapeHtmlForEmail(dateLabel)} &middot; ${horseCount} tracked horse${horseCount === 1 ? "" : "s"} today</div>
      </div>
      ${racesHtml}
    </div>
  `;
  return { subject, html };
}

async function sendStyledTestEmail(env, track, trackLabel, date, raceGroups, to) {
  const { subject, html } = buildStyledEntryDigestEmail(track, trackLabel, date, raceGroups, { isTest: true });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return await res.json().catch(() => ({}));
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
    const state = await readNotesAndTrainers(env); // trainerMeta isn't used anywhere in this function
    // Horse names (lowercased) with at least one trainer-less note — these
    // need checking even when horse.trainer isn't a tracked trainer at all,
    // since a trainer-less note is deliberately not pinned to any trainer
    // (see /notes POST) and must still catch the horse regardless of who
    // ends up training it.
    const untrackedHorseNames = new Set(
      state.notes.filter((n) => !n.trainer && n.horse).map((n) => stripHorseCountrySuffix(n.horse.trim().toLowerCase()))
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
        else if (sourceType === "smartpony") result = await fetchSmartPonyEntriesDay(track, date);
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
      // One read of this track's whole recap index up front — cheap (one
      // KV get), and reused for every horse on the card below instead of a
      // per-horse lookup.
      const recapIndex = await readRecapIndex(env, track);
      const fullCardRecapCache = {};
      const raceGroups = [];
      for (const race of result.races || []) {
        const matchedHorses = [];
        for (const horse of race.horses || []) {
          checked++;
          if (horse.scratched) continue;
          const trainerTracked = horse.trainer && trackedLastNames.has(lastNameKey(horse.trainer));
          const hasUntrackedNote = untrackedHorseNames.has(stripHorseCountrySuffix((horse.name || "").trim().toLowerCase()));
          const recapsRaw = recapIndex[normalizeHorseNameForRecap(horse.name)] || [];
          const recaps = [];
          for (const r of recapsRaw) {
            recaps.push({ ...r, fullCardRecap: await readFullCardRecapForDate(env, track, r.date, fullCardRecapCache) });
          }
          // A race recap is its own independent reason to include a horse —
          // it doesn't require a tracked trainer or an existing note, since
          // the whole point is surfacing "here's how this horse's last
          // recorded race actually went" even for a horse nobody's
          // otherwise tracking.
          if (!trainerTracked && !hasUntrackedNote && !recaps.length) continue;
          // Only worth including if there's actually something to show —
          // notes OR recaps — not dedup-marked when skipped for this reason
          // (see below), so a note/recap added later that same race day
          // before the 8am window still gets caught at the next run.
          const notes = notesForHorse(state.notes, horse.trainer, horse.name);
          if (!notes.length && !recaps.length) continue;
          const key = raceNotifyKvKey(track, date, race.raceNumber, horse.name);
          const already = await env.STABLE_KV.get(key);
          if (already) continue;
          matchedHorses.push({ horse, notes, recaps, key });
        }
        if (matchedHorses.length) raceGroups.push({ race, horses: matchedHorses });
      }
      if (!raceGroups.length) continue;
      const trackLabel = ENTRIES_TRACK_LABEL[track] || track;
      try {
        await sendEntryDigestEmail(env, track, trackLabel, date, raceGroups);
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
    // Confirmed real bug (same root cause as job #7's TDN one): with no
    // entries table to fall back on, every horse proximity-matched to this
    // trainer anywhere in the article shares ONE combined text, which then
    // gets filed under EACH of them — a real Chad Brown note ended up
    // identically duplicated under both Ways and Means and Fully
    // Subscribed. HRN's prose here doesn't reliably re-name the horse per
    // paragraph the way DRF's does (see textForLastName's own comment), so
    // there's no reliable way to scope the text to just one of several —
    // safer to drop this trainer's fallback section entirely than credit
    // every horse found nearby with the same words.
    if (horseNames.length > 1) return [];
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
// (DRF_SITEMAP_NEWS_URL) rather than /rss.xml — that feed exists but mixes
// in betting-affiliate/promo content and doesn't cover the quote-bearing
// news articles at all, confirmed by inspecting it directly. The news
// sitemap is a rolling ~48-hour window of every article DRF publishes,
// newest first, with title/link/publish-date all in clean XML, no HTML
// parsing needed for discovery.
//
// Second discovery source added 2026-08-27 (requested to widen coverage
// "as much as possible"): DRF's own /news/all-news listing (page 1 only —
// see DRF_ALL_NEWS_LIST_URL's own comment), merged with the sitemap and
// deduped by link. Confirmed real that this catches genuine articles
// already rolled off the sitemap's tighter 48-hour window (e.g. a real
// Phil D'Amato/Jeff Mullins feature found this way during setup). DRF gets
// its own higher DRF_MAX_ARTICLES_PER_RUN rather than sharing
// MAX_ARTICLES_PER_RUN with every other source, since two merged listings
// need more headroom than one to both actually contribute most runs.
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
// Second discovery source (requested 2026-08-27 to widen DRF coverage
// beyond the sitemap's own rolling ~48-hour window) — DRF's own "Latest
// Horse Racing News" listing at /news/all-news, paginated (?page=N; its own
// embedded data reports over 20,000 pages, i.e. DRF's entire archive back
// years — nowhere near relevant to Stable Tour, so this only ever reads
// page 1, just enough to catch anything just outside the sitemap's tighter
// window, e.g. a real find during setup: a Cherie DeVaux feature that had
// already rolled off the sitemap but was still on page 1 here). Article
// pages themselves are identical either way this file discovers them, so
// they flow through the exact same extractDrfKeywords()/extractDrfSections()
// pipeline below regardless of which listing found the link.
//
// The page ships this listing as Next.js RSC stream data, NOT plain HTML —
// confirmed real: no <a>/<h3> markup pairs a title with its link the way a
// normal listing page would. Each item shows up instead as an escaped JSON
// object mid-stream: \"titleSlug\":\"news/SLUG\",\"newsTitle\":\"Title\"
// ...\"postDate\":\"1787765220\" (a Unix-seconds timestamp) — parseDrfAllNewsListing()
// below regexes straight for those three fields rather than trying to
// parse the streaming format properly.
const DRF_ALL_NEWS_LIST_URL = "https://www.drf.com/news/all-news";
const DRF_BASE_URL = "https://www.drf.com";

// Third discovery source (requested 2026-08-27, specifically for Saratoga):
// DRF's own track hub page at /horse-racing-tracks/saratoga. Confirmed
// real: this is a MUCH deeper, track-filtered feed than either the sitemap
// or /news/all-news — a single fetch surfaced 70+ Saratoga-specific
// articles spanning the whole meet (Race Preview/Race Recap/Track Notes
// categories), not just the last day or two. Same RSC-stream escaped-JSON
// shipping as /news/all-news, but a different, richer shape: a
// "component":"tracks_news_section" block containing
// "news_configuration":{"articleList":[{...}, {...}]} — parseDrf
// TrackNewsListing() below splits on each object's own leading \"id\":N
// field rather than chaining field-to-field regexes across the whole
// blob, since some objects have fields in a different order than others
// (confirmed real: naive field-chaining paired titles with the WRONG
// article's slug on the first attempt).
const DRF_SARATOGA_TRACK_URL = "https://www.drf.com/horse-racing-tracks/saratoga";

const DRF_KEYWORD_TRACK_NAMES = new Set([
  "saratoga", "saratoga race course", "belmont", "belmont park", "aqueduct", "del mar", "santa anita", "santa anita park",
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

// Confirmed real gap on top of the suffix check above: some marquee stakes
// races get tagged by their bare popular name with no suffix word at all —
// a Castellano profile piece tagged the race he's riding in that Saturday
// as just "Travers" (not "Travers Stakes"), which read as a horse until
// this was added. Necessarily incomplete like the two sets above — a real
// horse coincidentally sharing one of these names would get excluded too —
// grown only as a real case turns up, same as DRF_KEYWORD_TRACK_NAMES.
const DRF_BARE_RACE_NAMES = new Set([
  "travers", "bolton landing", "hall of fame", "haskell", "pegasus", "statue of liberty",
  "skidmore",
]);

function drfKeywordIsTrackOrRace(keywordLower) {
  if (DRF_KEYWORD_TRACK_NAMES.has(keywordLower)) return true;
  if (DRF_BARE_RACE_NAMES.has(keywordLower)) return true;
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
  // Every comparison in this file runs through stripDiacritics() (removes
  // accents AND apostrophes) rather than plain .toLowerCase() — confirmed
  // real bug: DRF's own <meta keywords> tag spells a trainer with a
  // straight apostrophe ("Phil D'Amato") while the article's prose quotes
  // him with a curly one ("D'Amato said"), and a plain string compare
  // never matched the two.
  const fullTextNorm = stripDiacritics(fullText);

  // Quote + its speaker in one match — captures BOTH so a paragraph can
  // later be checked for "who is ACTUALLY speaking here" rather than just
  // "does this paragraph mention this trainer's name anywhere" (see
  // paraSpeakerKey below for why that distinction matters). The optional
  // non-capturing first-name group lets a FULL name ("George Weaver said")
  // resolve to the surname the same way a bare surname ("Cox said")
  // already did — confirmed real gap: nothing sat directly after the
  // closing quote but "George", not "Weaver", so the surname was never
  // reached before this. Also recognizes "wrote" alongside "said" — a real
  // trainer quote given by text message ("Morley wrote in a text") was
  // invisible entirely before this, since only "said" was ever checked
  // for.
  const quoteWithSpeakerRe = /[“"]([^”"]{4,600})[”"]\s+(?:[A-Z][A-Za-z'’-]+\s+)?([A-Z][A-Za-z'’-]+)\s+(?:said|wrote)\b/g;
  const quotedLastNames = new Set();
  for (const qm of fullText.matchAll(quoteWithSpeakerRe)) quotedLastNames.add(qm[2]);
  if (!quotedLastNames.size) return [];
  const quotedKeys = new Set([...quotedLastNames].map((n) => stripDiacritics(n).toLowerCase()));

  // Confirmed real bug: DRF's own keywords tag doesn't always include the
  // article's actual subject horse at all — "Wood Island captures Skidmore
  // in turf debut" tagged "Jackie's Warrior" (mentioned exactly once, as
  // "the sire Jackie's Warrior") but never tagged "Wood Island" itself,
  // despite Wood Island being the horse in every other paragraph. With no
  // real candidate available, the sire's own name was the only thing left
  // to fall back to. Scans for the "the sire NAME" / "sired by NAME"
  // construct specifically and excludes any keyword that matches — doesn't
  // help recover the untagged real horse (nothing to fall back to for
  // that), but stops the sire from being mistaken for it.
  const sireKeys = new Set();
  for (const sm of fullTextNorm.matchAll(/\b(?:the sire|sired by)\s+([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,2})/g)) {
    sireKeys.add(stripDiacritics(sm[1]).toLowerCase());
  }

  const candidateHorsesGlobal = keywords.filter((k) => {
    if (drfKeywordIsTrackOrRace(k.toLowerCase())) return false;
    const keyNorm = stripDiacritics(k).toLowerCase();
    if (sireKeys.has(keyNorm)) return false;
    const lastWordKey = keyNorm.split(/\s+/).pop();
    // Excludes EVERY quoted person's own name found anywhere in the
    // article, not just "the current trainer" — confirmed real bug: a
    // multi-person DRF piece lists every quoted person's full name in the
    // same shared keywords tag, and only excluding one at a time let each
    // OTHER one slip through as if they were a horse.
    return !quotedKeys.has(lastWordKey);
  });
  if (!candidateHorsesGlobal.length) return [];

  // Confirmed real bug: a trainer's OWN quote that happens to mention a
  // jockey/other quoted person BY NAME ("Manny rode him brilliantly...")
  // was making that whole paragraph look like it belonged to the mentioned
  // person too, crediting them with words they never said. paraSpeakerKey
  // records who the attribution regex ACTUALLY resolves to for each
  // individual paragraph, so a quote only ever gets attached to its real
  // speaker — a paragraph mentioning someone's name in passing no longer
  // counts as "their" paragraph for quote-attachment purposes.
  const quoteWithSpeakerReSingle = new RegExp(quoteWithSpeakerRe.source); // same pattern, no /g — .match() returns capture groups directly
  const paraSpeakerKey = new Map();
  for (let i = 0; i < paras.length; i++) {
    const m = paras[i].match(quoteWithSpeakerReSingle);
    if (m) paraSpeakerKey.set(i, stripDiacritics(m[2]).toLowerCase());
  }

  // Global horse ownership — "Trainer NAME ... HORSE" / "Trained by NAME,
  // HORSE" anywhere in the article (prose OR a photo caption, both use
  // this construct). Used two ways below: positively, to anchor a trainer
  // to his own horse when a quote paragraph names no horse of its own;
  // negatively, to exclude a horse already confirmed as someone ELSE's.
  // Confirmed real bug this catches: a recap tagging only the RACE
  // WINNER'S horse as a keyword left a losing trainer's own quote (about
  // his own, untagged horse) with nothing to resolve to but the winner's
  // name mentioned nearby — explicit ownership evidence stops that guess.
  // NOTE: deliberately NOT using the /i flag here — it would make the
  // [A-Z] character classes below match lowercase too (confirmed real:
  // this silently turned "trainer Todd Pletcher and jockey..." into a
  // 3-word capture ending in "and"), so "trainer"/"trained by" are spelled
  // out in both cases explicitly instead.
  const horseOwner = new Map();
  for (const om of fullTextNorm.matchAll(/(?:[Tt]rainer|[Tt]rained by)\s+([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,2})/g)) {
    // A byline glued directly onto the end of a headline with no space
    // ("...trainer PletcherDavid Grening|Aug 01, 2026") can let the
    // byline's own second name leak into the captured group — confirmed
    // real: this produced a bogus owner key that excluded a horse from
    // literally every trainer in the piece, its real trainer included. A
    // real byline always has "|Mon DD, YYYY" right after; if a "|" shows
    // up within a few chars of the match, it's corrupted — skip it.
    if (fullTextNorm.slice(om.index + om[0].length, om.index + om[0].length + 40).includes("|")) continue;
    const nameKey = stripDiacritics(om[1]).toLowerCase().split(/\s+/).pop();
    const window = fullTextNorm.slice(om.index + om[0].length, om.index + om[0].length + 80);
    for (const horse of candidateHorsesGlobal) {
      if (!horseOwner.has(horse) && new RegExp(`\\b${escapeRegExpTdn(stripDiacritics(horse))}\\b`, "i").test(window)) {
        horseOwner.set(horse, nameKey);
      }
    }
  }

  // Rival-mention detector — a horse that's only ever framed as "beaten by
  // X"/"facing X"/"beat X"/"against X"/"impressed with X when he/she won"/
  // "rival X" anywhere in the article is likely someone ELSE's horse being
  // praised or compared, not the quoted trainer's own (confirmed real: "I
  // was very impressed with Renegade when he won the Arkansas Derby,"
  // Casse said — about HIS OWN horse, referred to only as "him", not about
  // Renegade at all). A horseOwner match already handles the case where
  // that rival's real trainer is named in THIS article; this catches it
  // even when no owner is ever stated for it here.
  const isOpponentMentioned = (horse) => {
    const h = escapeRegExpTdn(stripDiacritics(horse));
    return [
      new RegExp(`beaten[^.]{0,30}\\bby\\s+${h}\\b`, "i"),
      new RegExp(`\\bfacing\\s+${h}\\b`, "i"),
      new RegExp(`\\bbeat\\s+${h}\\b`, "i"),
      new RegExp(`\\bagainst\\s+${h}\\b`, "i"),
      new RegExp(`\\bimpressed with\\s+${h}\\b`, "i"),
      new RegExp(`\\brival\\s+${h}\\b`, "i"),
      new RegExp(`\\brun down[^.]{0,15}\\bby\\s+${h}\\b`, "i"),
    ].some((re) => re.test(fullTextNorm));
  };

  // One note per (trainer, horse) — not one note per trainer covering
  // every horse he's associated with anywhere in the piece. Confirmed real
  // complaint: a DRF stakes-preview covering several of the same trainer's
  // horses was producing ONE combined blob of every quote about every one
  // of his horses, then filing that SAME incoherent blob under EACH
  // horse's name.
  const sections = [];
  for (const lastName of quotedLastNames) {
    const ownKey = stripDiacritics(lastName).toLowerCase();
    const ownParagraphs = [...paraSpeakerKey.entries()].filter(([, spk]) => spk === ownKey).map(([i]) => i);
    if (!ownParagraphs.length) continue;

    const candidateHorses = candidateHorsesGlobal.filter((h) => stripDiacritics(h).toLowerCase() !== ownKey);
    if (!candidateHorses.length) continue;
    const ownAnchors = new Set([...horseOwner.entries()].filter(([h, owner]) => owner === ownKey && candidateHorses.includes(h)).map(([h]) => h));

    // Broader "mentions this trainer's name anywhere" set, for the
    // prev-paragraph horse-fallback below only (NOT for deciding whose
    // quote a paragraph's own text belongs to — that's paraSpeakerKey).
    const nameRe = new RegExp(`\\b${escapeRegExpTdn(ownKey)}\\b`, "i");

    const textByHorse = {};
    for (const i of ownParagraphs) {
      const quoteSpansHere = [...paras[i].matchAll(/[“"]([^”"]{4,600})[”"]/g)].map((m) => m[1].trim());
      if (!quoteSpansHere.length) continue;
      const ownParaNorm = stripDiacritics(paras[i]);
      const horsesInOwnPara = candidateHorses.filter((horse) =>
        new RegExp(`\\b${escapeRegExpTdn(stripDiacritics(horse))}\\b`, "i").test(ownParaNorm)
      );
      let horsesForThisQuote = horsesInOwnPara;
      // Confirmed real bug: "Trainer Lindsay Schultz said 'it was Paco's
      // horse before it was Jorge's horse.'" — Schultz's own quote paragraph
      // names no candidate horse (just two jockeys' possessive "horse"), so
      // the prev-paragraph fallback below kicked in and grabbed "Napoleon
      // Solo" — the only TAGGED horse mentioned there — even though the
      // paragraph's real subject (Baby Vino, the horse actually being
      // discussed) was never a DRF keyword at all and so was invisible as a
      // candidate. A quote phrased as "[Name]'s horse/mount" is inherently
      // about someone else's horse by name, not a horse to guess from
      // surrounding narrative — skip the fallback entirely rather than risk
      // crediting the wrong one.
      const namesThirdPartyMount = /\b[A-Z][a-z]+['’]s\s+(?:horse|mount)\b/.test(paras[i]);
      if (!horsesForThisQuote.length && i > 0 && !namesThirdPartyMount) {
        // Fall back to the paragraph right before — but ONLY when it
        // names exactly one candidate horse. Confirmed real bug: a
        // background-summary paragraph mentioning THREE horses in passing
        // sat right before a generic quote with no horse of its own —
        // every one of those three horses incorrectly got the same
        // generic quote. Ambiguous means don't guess.
        const prevParaNorm = stripDiacritics(paras[i - 1]);
        const horsesInPrevPara = candidateHorses.filter((horse) =>
          new RegExp(`\\b${escapeRegExpTdn(stripDiacritics(horse))}\\b`, "i").test(prevParaNorm)
        );
        if (horsesInPrevPara.length === 1) horsesForThisQuote = horsesInPrevPara;
      }

      const filtered = horsesForThisQuote.filter((horse) => {
        const owner = horseOwner.get(horse);
        if (owner && owner !== ownKey) return false; // confirmed someone else's horse
        if (isOpponentMentioned(horse) && !ownAnchors.has(horse)) return false; // framed as a rival, not confirmed as his own
        return true;
      });
      // If filtering left nothing but this trainer has exactly one
      // confirmed horse in the whole article, attribute the quote to that
      // one rather than losing it — it clearly is about his own horse,
      // just referred to as "he"/"it" in this specific paragraph.
      horsesForThisQuote = filtered.length ? filtered : (ownAnchors.size === 1 ? [...ownAnchors] : []);

      for (const horse of horsesForThisQuote) {
        if (!textByHorse[horse]) textByHorse[horse] = [];
        textByHorse[horse].push(...quoteSpansHere);
      }
    }

    for (const [horse, spans] of Object.entries(textByHorse)) {
      sections.push({ trainerName: lastName, horseNames: [horse], text: spans.join(" ").slice(0, 600) });
    }
  }
  return sections;
}

// Regexes for the ESCAPED quotes (\") the RSC stream ships, not plain JSON
// — this is inside a JS string literal (self.__next_f.push(["..."])), so
// every quote in the actual payload is backslash-escaped. Confirmed
// directly against a real fetch of page 1: titleSlug/newsTitle always
// appear adjacent in that order, postDate follows within a few hundred
// characters (author/teaser/image fields sit between them).
function parseDrfAllNewsListing(html) {
  const items = [];
  const itemRe = /\\"titleSlug\\":\\"(news\/[^\\]+)\\",\\"newsTitle\\":\\"([^\\]*)\\"/g;
  for (const m of html.matchAll(itemRe)) {
    const slug = m[1];
    const title = decodeEntities(m[2]).trim();
    const window = html.slice(m.index, m.index + 800);
    const dateMatch = window.match(/\\"postDate\\":\\"(\d+)\\"/);
    const pubDate = dateMatch ? new Date(parseInt(dateMatch[1], 10) * 1000).toISOString() : null;
    items.push({ link: `${DRF_BASE_URL}/${slug}`, title, pubDate });
  }
  return items;
}

// See DRF_SARATOGA_TRACK_URL's own comment for why this splits into
// individual article objects (on each one's own leading \"id\":N field)
// instead of chasing three fields across the whole blob the way
// parseDrfAllNewsListing() does — this feed's objects don't reliably keep
// newsSlug/newsTitle/listed_at in the same relative order every time.
function parseDrfTrackNewsListing(html) {
  const idx = html.indexOf("articleList");
  if (idx === -1) return [];
  const chunk = html.slice(idx, idx + 200000);
  const objStarts = [...chunk.matchAll(/\\"id\\":\d+/g)].map((m) => m.index);
  objStarts.push(chunk.length);

  const items = [];
  for (let i = 0; i < objStarts.length - 1; i++) {
    const obj = chunk.slice(objStarts[i], objStarts[i + 1]);
    const slugMatch = obj.match(/\\"newsSlug\\":\\"([^\\]+)\\"/);
    const titleMatch = obj.match(/\\"newsTitle\\":\\"([^\\]*)\\"/);
    const listedMatch = obj.match(/\\"listed_at\\":\\"([^\\]+)\\"/);
    if (!slugMatch || !titleMatch) continue;
    items.push({
      link: `${DRF_BASE_URL}/${slugMatch[1]}`,
      title: decodeEntities(titleMatch[1]).trim(),
      pubDate: listedMatch ? listedMatch[1] : null,
    });
  }
  return items;
}

async function fetchDrfNews() {
  const sitemapRes = await fetch(DRF_SITEMAP_NEWS_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!sitemapRes.ok) throw new Error(`DRF news sitemap returned HTTP ${sitemapRes.status}`);
  const sitemapXml = await sitemapRes.text();

  const sitemapItems = [];
  const seenLinks = new Set();
  for (const m of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const link = block.match(/<loc>(.*?)<\/loc>/)?.[1];
    const title = block.match(/<news:title>(.*?)<\/news:title>/)?.[1];
    const pubDate = block.match(/<news:publication_date>(.*?)<\/news:publication_date>/)?.[1];
    if (!link) continue;
    seenLinks.add(link);
    sitemapItems.push({ link, title: title ? decodeEntities(title).trim() : null, pubDate: pubDate || null });
  }

  // Second and third sources (page 1 of /news/all-news, and the Saratoga
  // track hub page — see each URL constant's own comment) — both
  // best-effort, so a hiccup fetching or parsing either just means falling
  // back to whatever else succeeded this run, not failing the whole job.
  const allNewsItems = [];
  try {
    const allNewsRes = await fetch(DRF_ALL_NEWS_LIST_URL, {
      headers: { "User-Agent": BROWSER_UA },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (allNewsRes.ok) {
      const allNewsHtml = await allNewsRes.text();
      for (const item of parseDrfAllNewsListing(allNewsHtml)) {
        if (seenLinks.has(item.link)) continue;
        seenLinks.add(item.link);
        allNewsItems.push(item);
      }
    }
  } catch (err) {
    console.error("DRF all-news listing fetch failed", err.message);
  }

  const saratogaTrackItems = [];
  try {
    const saratogaRes = await fetch(DRF_SARATOGA_TRACK_URL, {
      headers: { "User-Agent": BROWSER_UA },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (saratogaRes.ok) {
      const saratogaHtml = await saratogaRes.text();
      for (const item of parseDrfTrackNewsListing(saratogaHtml)) {
        if (seenLinks.has(item.link)) continue;
        seenLinks.add(item.link);
        saratogaTrackItems.push(item);
      }
    }
  } catch (err) {
    console.error("DRF Saratoga track-page fetch failed", err.message);
  }

  // Interleaved, not concatenated — confirmed real that the sitemap alone
  // usually has 20-30 items (mostly harness/wagering/analysis content with
  // zero quotes, per this job's own top comment), which would fill the
  // entire DRF_MAX_ARTICLES_PER_RUN budget before the other sources ever
  // got a turn if the lists were just appended one after another.
  // Round-robining one-from-each list means all three actually get
  // processed most runs regardless of how many the sitemap alone has (the
  // Saratoga track page alone can have 70+ articles spanning the whole
  // meet, easily the largest of the three).
  const sourceLists = [sitemapItems, allNewsItems, saratogaTrackItems];
  const items = [];
  const maxLen = Math.max(...sourceLists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of sourceLists) {
      if (list[i]) items.push(list[i]);
    }
  }

  const articles = [];
  for (const item of items.slice(0, DRF_MAX_ARTICLES_PER_RUN)) {
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

// ---------- NYRA News (job #20) ----------
// NYRA's own Saratoga press releases (nyra.com/saratoga/news/) — first-
// party, not third-party coverage like TDN/HRN/DRF. Verified directly:
// plain unauthenticated static HTML (a bare curl with no JS execution
// already returns full article text, unlike DRF's Next.js hydration data),
// no robots.txt restriction, and real substantial trainer quotes in the
// site's "Stakes Advance" articles — a single preview piece can profile
// 3+ horses, each with its own trainer and its own run of quote paragraphs.
//
// Horse identification is the one real wrinkle here: unlike HRN (inline
// horse links) or DRF (a <meta keywords> tag naming every horse), NYRA's
// prose has neither. What it DOES have, verified against a real article:
// every horse besides the article's lead horse gets introduced as
// "OWNER's HORSE NAME [post N, Jockey]" — extractNyraBracketHorse() below
// leans on that bracket as a structural marker, and falls back to
// extractNyraTitleHorse() (the article's own headline reliably leads with
// the horse's name, e.g. "Awesome Czech looks to defend her title...") for
// the lead horse, which never gets its own bracket until well after its
// first quote.
const NYRA_NEWS_LIST_URL = "https://www.nyra.com/saratoga/news/";
const NYRA_BASE = "https://www.nyra.com";

// Strips an owner's possessive prefix off the FRONT of a name run, cutting
// at the LAST possessive marker found — an owner name is itself often
// several comma-joined names ("Delta Squad Racing, HRH Prince Faisal...and
// Cosmo Stables' Baby Vino"), so only the rightmost marker (closest to the
// actual horse name) matters. Checks all four forms: a normal possessive
// ("Stables's "/"Stables’s ") AND a bare plural possessive with no
// trailing s ("Stables' "/"Stables’ ") — confirmed real that NYRA uses
// both depending on whether the owner name already ends in "s".
function stripNyraPossessivePrefix(text) {
  const markers = ["’s ", "'s ", "’ ", "' "];
  let bestIdx = -1, bestLen = 0;
  for (const marker of markers) {
    const idx = text.lastIndexOf(marker);
    if (idx > bestIdx) { bestIdx = idx; bestLen = marker.length; }
  }
  return bestIdx === -1 ? text : text.slice(bestIdx + bestLen).trim();
}

// Confirmed real gap this closes: "Blue Heaven Farm's Kentucky homebred Go
// for Launch saved ground..." — stripNyraPossessivePrefix() only removes
// the owner's name, leaving a breeding descriptor ("Kentucky homebred",
// "New York-bred") sitting between it and the actual horse name, which
// then got filed as part of the horse name itself (a real functional bug,
// not cosmetic — notesForHorse()/findHorseStableNotes() need an EXACT
// horse-name match). ".*bred " is greedy, so it strips through the LAST
// "*bred " in the text, i.e. past the descriptor and up to the horse's own
// name — verified against the live article above.
function stripNyraBreedingDescriptor(text) {
  return text.replace(/^.*bred\s+/i, "");
}

// A headline's leading words ARE the horse's name up until the verb phrase
// — but a real horse name can itself contain lowercase filler words ("Sail
// With the Wind", "And One More Time"), so this can't just stop at the
// first lowercase word. Instead it keeps consuming capitalized words, and
// only keeps going through a lowercase word if the word right after it is
// capitalized again (i.e. the lowercase word is bridging two more name
// words, not starting the headline's verb). Verified against every title
// in a real /saratoga/news/ listing pull (see the job's own commit).
function extractNyraTitleHorse(title) {
  const words = title.split(/\s+/);
  const nameWords = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isCap = /^[A-Z]/.test(w);
    const bridgesToCap = !isCap && i + 1 < words.length && /^[A-Z]/.test(words[i + 1]);
    if (isCap || bridgesToCap) { nameWords.push(w); continue; }
    break;
  }
  // A headline that opens with the owner's possessive name before the horse
  // ("Blue Heaven Farm's Kentucky homebred Go for Launch saved...") passes
  // the same capitalized/bridging test as the owner name itself — strip the
  // owner off, then any breeding descriptor between it and the actual horse
  // name, the same two-step extractNyraBracketHorse() uses.
  const guess = stripNyraBreedingDescriptor(stripNyraPossessivePrefix(nameWords.join(" ").trim()));
  return guess || null;
}

// Reads the "OWNER's HORSE NAME [post N, Jockey]" bracket convention — the
// horse name is whatever sits between the bracket and either (a) the last
// possessive marker before it (stripping the owner's name off the front) or
// (b) the start of the paragraph if there's no possessive in range. Capped
// to the last 5 words as a backstop against an unrelated sentence bleeding
// in on a paragraph with no possessive at all.
function extractNyraBracketHorse(paragraphPlainText) {
  const m = paragraphPlainText.match(/^[^.!?]*?\[post\s+\d+/);
  if (!m) return null;
  const rawPrefix = m[0].replace(/\[post\s+\d+.*/, "").trim();
  const prefix = stripNyraBreedingDescriptor(stripNyraPossessivePrefix(rawPrefix));
  const words = prefix.split(/\s+/).filter(Boolean);
  const capped = words.length > 5 ? words.slice(-5).join(" ") : prefix;
  return capped || null;
}

// One combined section per (trainer, horse) pair found in the article —
// every paragraph naming that pair's quotes gets merged into one section's
// text (a stakes-preview routinely gives one trainer 2-3 separate quote
// paragraphs about the same horse; keeping those as one section instead of
// three means the resulting note is the full, untruncated run of what that
// trainer said, not just the first paragraph of it).
function extractNyraSections(paragraphs, titleHorseGuess) {
  // Step 1: which trainers does this article actually name, and under what
  // full name — scanned up front across every paragraph, same as HRN's own
  // quotedLastNames-first approach, so a quote attributed only by surname
  // ("De Paz said") can still resolve to the full name ("Horacio De Paz")
  // announced elsewhere in the piece.
  const trainerFullNameByKey = {};
  // Confirmed real gap (2026-08-30): the original two patterns only caught
  // the narrowest literal phrasings ("Trained by NAME", "for trainer
  // NAME") — but NYRA's own house style routinely wedges an accolade
  // clause between the trigger word and the actual name ("Trained by dual
  // Eclipse Award-winner Brad Cox", "for ... dual Eclipse Award-winning
  // trainer Brad Cox"), and uses several other constructions entirely
  // ("Cherie DeVaux, trainer of the popular Golden Tempo", "Trainer Ron
  // Moquett, who...", "Hall of Famer Bill Mott-trained T Kraft", "trainer
  // Chad Brown his third win"). Since Step 2 below bails out to an empty
  // result for the WHOLE article when this comes back empty, missing all
  // of these meant several real post-race recaps (including the Travers
  // winner's own writeup) silently produced zero notes despite having
  // genuine trainer quotes in them.
  const trainerNamePatterns = [
    // No literal "." in the name classes below — confirmed real bug: "for
    // trainer Jim Ryerson." (sentence-ending period right against the
    // name) would otherwise swallow the period into the captured word,
    // making lastNameKey() produce "ryerson." instead of "ryerson" and
    // silently failing to match this trainer's own quote attributions
    // later.
    // "Trained by [accolade clause] NAME," — skip up to 6 filler tokens
    // non-greedily, then a hyphen-free capitalized run anchored by a
    // trailing comma/period (hyphen excluded here specifically so a
    // hyphenated accolade word like "Award-winner" can't itself get
    // captured as if it were the first name word).
    /Trained by\s+(?:\S+\s+){0,6}?([A-Z][A-Za-z’']+(?:\s+[A-Z][A-Za-z’']+){0,2})[,.]/g,
    // "trainer NAME" / "Trainer NAME," — with or without a leading "for",
    // with or without an accolade clause before "trainer" (that clause is
    // simply ignored since the name is captured AFTER the trigger word).
    /\b[Tt]rainer\s+([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){0,2})/g,
    // "NAME, trainer of HORSE" — name comes before the trigger phrase here.
    /([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){0,2}),\s+trainer of\b/g,
    // "NAME-trained HORSE".
    /([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){0,2})-trained\b/g,
  ];
  for (const para of paragraphs) {
    for (const re of trainerNamePatterns) {
      for (const m of para.matchAll(re)) {
        const fullName = m[1].trim();
        const key = lastNameKey(fullName);
        if (!trainerFullNameByKey[key]) trainerFullNameByKey[key] = fullName;
      }
    }
  }
  if (!Object.keys(trainerFullNameByKey).length) return [];

  // Step 2: walk paragraphs in order, tracking which horse is currently
  // "in frame" (updated by the bracket convention, seeded from the
  // headline for the lead horse before its own bracket ever appears), and
  // building one merged section per (trainer, horse) pair.
  // Confirmed real bug (2026-08-30): a "roundup"-style headline like "DeVaux
  // barn represented by top sophomores Englishman, Golden Tempo..." leads
  // with the TRAINER's surname, not a horse — extractNyraTitleHorse() can't
  // tell the difference on its own (it just grabs the leading capitalized
  // run). Without a "[post N, Jockey]" bracket anywhere in the piece to
  // correct it, that wrong guess stuck as the horse for the WHOLE article,
  // silently mislabeling every section in it (not just the ones near the
  // headline). Cross-checking against trainerFullNameByKey — already built
  // in Step 1 from the article's own body text — catches this generally,
  // without needing to hand-maintain a blocklist of headline phrasings
  // ("barn", "well-represented by", etc.): if the guess's last name matches
  // a trainer this article already names, it's not a horse, so drop it and
  // let the bracket convention (or nothing, if none appears) take over
  // instead of guessing wrong.
  const titleGuessIsActuallyTrainer = titleHorseGuess && trainerFullNameByKey[lastNameKey(titleHorseGuess)];
  let currentHorse = titleGuessIsActuallyTrainer ? null : titleHorseGuess;
  const sections = {}; // `${trainerKey}|${horse}` -> { trainerName, horse, parts: [] }

  for (const para of paragraphs) {
    const bracketHorse = extractNyraBracketHorse(para);
    if (bracketHorse) currentHorse = bracketHorse;
    if (!currentHorse) continue;

    let attributed = null;
    const afterMatch = para.match(/\b([A-Z][A-Za-z’'-]+(?:\s[A-Z][A-Za-z’'-]+)?)\s+said\b/);
    if (afterMatch) attributed = afterMatch[1];
    else {
      const beforeMatch = para.match(/\bsaid\s+([A-Z][A-Za-z’'-]+(?:\s[A-Z][A-Za-z’'-]+)?)\b/);
      if (beforeMatch) attributed = beforeMatch[1];
    }
    if (!attributed) continue;

    const key = lastNameKey(attributed);
    const fullName = trainerFullNameByKey[key];
    if (!fullName) continue; // quoted someone with no "Trained by"/"for trainer" intro anywhere — don't guess

    const quoteSpans = [...para.matchAll(/[“"]([^”"]{4,600})[”"]/g)].map((m) => m[1].trim()).filter(Boolean);
    if (!quoteSpans.length) continue;

    const sectionKey = `${key}|${currentHorse}`;
    if (!sections[sectionKey]) sections[sectionKey] = { trainerName: fullName, horse: currentHorse, parts: [] };
    sections[sectionKey].parts.push(quoteSpans.join(" "));
  }

  return Object.values(sections).map((s) => ({
    trainerName: s.trainerName,
    horseNames: [s.horse],
    text: s.parts.join(" "),
  }));
}

async function fetchNyraNews() {
  const listRes = await fetch(NYRA_NEWS_LIST_URL, {
    headers: { "User-Agent": BROWSER_UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!listRes.ok) throw new Error(`NYRA News list returned HTTP ${listRes.status}`);
  const listHtml = await listRes.text();

  const items = [];
  const seenLinks = new Set();
  for (const m of listHtml.matchAll(/<a href="(\/saratoga\/news\/[^"]+\/)" class="block">[\s\S]*?<h2[^>]*>\s*([\s\S]*?)\s*<\/h2>[\s\S]*?<span>([^<]+)<\/span>/g)) {
    const link = NYRA_BASE + m[1];
    if (seenLinks.has(link)) continue;
    seenLinks.add(link);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const dateLabel = m[3].trim(); // e.g. "Aug 26 2026"
    const pubDate = new Date(dateLabel);
    items.push({ link, title, pubDate: isNaN(pubDate) ? null : pubDate.toISOString() });
  }

  const articles = [];
  for (const item of items.slice(0, NYRA_NEWS_MAX_ARTICLES_PER_RUN)) {
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
    const bodyIdx = html.indexOf('class="format-text"');
    if (bodyIdx === -1) continue;
    const bodyHtml = html.slice(bodyIdx, Math.min(bodyIdx + 20000, html.length));
    const paragraphs = [...bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!paragraphs.length) continue;
    const titleHorseGuess = extractNyraTitleHorse(item.title);
    const sections = extractNyraSections(paragraphs, titleHorseGuess);
    if (!sections.length) continue;
    articles.push({ guid: item.link, title: item.title, link: item.link, pubDate: item.pubDate, sections });
  }

  return { source: NYRA_NEWS_LIST_URL, fetchedAt: new Date().toISOString(), articles };
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
  const trainers = await readTrainers(env); // see the tracked-spelling snap below — this is all fetchSmartPonyQuotes() ever needs, no reason to also pull+parse the (much larger) notes blob
  // All three of SmartPony's own review states (needs_review, auto_matched,
  // verified) — originally scoped to verified-only, but that missed most
  // of what's actually on their site (confirmed real: several Chad Brown
  // quotes visible on smartpony.ai never made it through since they were
  // still needs_review/auto_matched). User's explicit call: broader
  // coverage matters more here than only importing SmartPony's own final
  // human-reviewed queue — this file's usual "don't guess" standard is
  // about horse/trainer identification, which SmartPony has already done
  // for us, not about their internal review-workflow status.
  // Confirmed real bug: a flat &limit=500 with no pagination silently
  // capped this at SmartPony's 500 MOST RECENT quotes forever, no matter
  // how many older ones existed beneath that — with their own backlog past
  // 800 and growing, several hundred quotes older than the current top-500
  // were permanently invisible to this whole pipeline, not just slow to
  // arrive. Paginates via PostgREST's offset/limit until a page comes back
  // short (the standard "that was the last page" signal), so the true
  // total gets pulled every run regardless of how large the backlog gets.
  //
  // Also confirmed real, discovered the moment pagination above actually
  // worked: with NO bound at all, SmartPony's full table goes back years —
  // 3,188 rows total, not the ~800 on their own current-season view — and
  // this app auto-adds any unmatched full-name trainer as a new tracked
  // trainer (see the loop below), so an unbounded fetch would have silently
  // flooded the tracked list with ~700 mostly-historical, mostly-irrelevant
  // trainers on the very next import run. A stable-tour app only ever cares
  // about the CURRENT meet, so bounding to a trailing window is the correct
  // fix here, not just a stopgap — pick something a full season plus buffer
  // comfortably fits inside.
  const SMARTPONY_LOOKBACK_DAYS = 120;
  const lookbackCutoff = new Date(Date.now() - SMARTPONY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const query = "select=id,quote_text,trainer_name_raw,trainer_name,mentioned_horse_name,sentiment,created_at,matched_horse_id,raw_articles(url,title,source,published_at)"
    + `&status=in.(needs_review,auto_matched,verified)&created_at=gte.${lookbackCutoff}&order=created_at.desc`;
  const SMARTPONY_QUOTES_PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += SMARTPONY_QUOTES_PAGE_SIZE) {
    const res = await fetch(`${SMARTPONY_SUPABASE_URL}/rest/v1/trainer_quotes?${query}&limit=${SMARTPONY_QUOTES_PAGE_SIZE}&offset=${offset}`, {
      headers: { apikey: SMARTPONY_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      cf: { cacheTtl: 300, cacheEverything: false }, // per-user auth header — never a shared cache key
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `SmartPony quotes fetch returned HTTP ${res.status}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < SMARTPONY_QUOTES_PAGE_SIZE) break; // short page — that was the last one
  }

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
    const tracked = resolveTrackedTrainer(trainerName, trainers);
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
          const key = stripHorseCountrySuffix(horse.name.trim().toLowerCase());
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
  const notes = await readNotes(env); // trainers/trainerMeta aren't used anywhere below

  const horseNames = [...new Set(notes.map((n) => (n.horse || "").trim()).filter(Boolean))];
  const nameToHorseId = await lookupHorseIdsByName(accessToken, horseNames);
  const horseIds = [...new Set(Object.values(nameToHorseId))];
  const entryByHorseId = await lookupRaceEntriesByHorseId(accessToken, horseIds);
  const nyraByHorse = await lookupNyraEntriesTrainerByHorse();

  const mismatches = [];
  let checked = 0;
  for (const n of notes) {
    if (!n.trainer) continue; // deliberately trainer-less (see /notes POST) — not a mismatch, nothing to compare
    const nyraHit = nyraByHorse[stripHorseCountrySuffix((n.horse || "").trim().toLowerCase())];

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

// ---------- SmartPony entries (job #23) ----------
// Separate from job #18's trainer-quote lookups above (which query
// race_entries by an ALREADY-KNOWN horse_id, for note-matching only) —
// this queries races+race_entries+horses directly by track+date to pull
// a genuine full day's card, for tracks with no other free source at all
// (confirmed 2026-09-04: Churchill Downs, Santa Anita, Oaklawn Park,
// Keeneland, Gulfstream Park, Colonial Downs, Kentucky Downs, Ellis Park,
// Fair Grounds — every track this app couldn't get real entries for any
// other way, after a full day of checking each track's own site plus
// DRF/Horse Racing Nation/TwinSpires). Deliberately NOT used for
// Saratoga/Belmont/Del Mar/Monmouth, which already have their own
// track-run sources — those stay as-is, this only fills real gaps.
//
// No login needed for these three tables specifically (races,
// race_entries, horses) — confirmed directly: the same public anon key
// used everywhere else in this file reads them fine with no Authorization
// bearer token, unlike job #18's trainer_quotes table, which does need
// the real smartponyLogin() session. Row-level security evidently scopes
// these three tables as public-read; smartponyLogin() is NOT called here.
//
// This is a heavier, ongoing reliance on a friend's own (very likely
// BRIS/Equibase-licensed) data than job #18's occasional quote lookups —
// confirmed OK with SmartPony's operator directly before building this
// (2026-09-04), not assumed. The whole thing could disappear if that RLS
// policy ever gets locked down on their end with no warning — there's no
// way to detect that in advance, only handle the resulting fetch failure
// the same as any other source going down.
const SMARTPONY_TRACK_CODE = {
  churchilldowns: "CD", santaanita: "SA", oaklawnpark: "OP", keeneland: "KEE",
  gulfstreampark: "GP", colonialdowns: "CNL", kentuckydowns: "KD",
  ellispark: "ELP", fairgrounds: "FG",
};
// IANA timezone per SmartPony-sourced track — needed to convert
// races.post_time_utc (a real timestamptz) into the local naive
// "YYYY-MM-DDTHH:MM:SS" shape formatPostTimeLabel()/weatherAtPostTime()
// already expect from every other track's postTimeIso (see
// toTrackLocalIso() below). Matches each track's own TRACKS.timezone in
// index.html.
const SMARTPONY_TRACK_TIMEZONE = {
  churchilldowns: "America/New_York", santaanita: "America/Los_Angeles",
  oaklawnpark: "America/Chicago", keeneland: "America/New_York",
  gulfstreampark: "America/New_York", colonialdowns: "America/New_York",
  kentuckydowns: "America/Chicago", ellispark: "America/Chicago",
  fairgrounds: "America/Chicago",
};

function toTrackLocalIso(utcIso, timeZone) {
  if (!utcIso) return null;
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

// 220 yards = 1 furlong, 1760 yards = 1 mile — real racing distances only
// ever land on halves (furlongs) or sixteenths (miles), so this covers
// every actual distance without needing a general fraction reducer.
function yardsToDistanceLabel(yards) {
  if (yards == null) return null;
  const furlongs = yards / 220;
  if (furlongs < 8) {
    const whole = Math.floor(furlongs);
    const isHalf = Math.round((furlongs - whole) * 2) === 1;
    return `${whole}${isHalf ? " 1/2" : ""} Furlong${whole === 1 && !isHalf ? "" : "s"}`;
  }
  const miles = yards / 1760;
  let whole = Math.floor(miles);
  let sixteenths = Math.round((miles - whole) * 16);
  if (sixteenths === 16) { whole += 1; sixteenths = 0; }
  const fracMap = { 1: "1/16", 2: "1/8", 3: "3/16", 4: "1/4", 5: "5/16", 6: "3/8", 7: "7/16", 8: "1/2", 9: "9/16", 10: "5/8", 11: "11/16", 12: "3/4", 13: "13/16", 14: "7/8", 15: "15/16" };
  const fracLabel = fracMap[sixteenths];
  return `${whole}${fracLabel ? " " + fracLabel : ""} Mile${whole === 1 && !fracLabel ? "" : "s"}`;
}

// SmartPony stores morning-line odds as a decimal "profit per $1" number
// (e.g. "3.50" = 7-2) rather than the traditional fractional display used
// everywhere else here. Only the fraction denominators real morning lines
// actually use are covered — anything else falls back to a plain decimal
// display rather than a wrong fraction.
const ML_ODDS_FRACTION_DENOMINATORS = [1, 2, 4, 5, 10, 20];
function smartponyGcd(a, b) { return b === 0 ? a : smartponyGcd(b, a % b); }
function formatSmartPonyMlOdds(decimalStr) {
  if (decimalStr == null) return null;
  const val = parseFloat(decimalStr);
  if (!isFinite(val) || val <= 0) return null;
  for (const denom of ML_ODDS_FRACTION_DENOMINATORS) {
    const numerator = Math.round(val * denom);
    if (numerator > 0 && Math.abs(numerator / denom - val) < 0.01) {
      const g = smartponyGcd(numerator, denom);
      return `${numerator / g}-${denom / g}`;
    }
  }
  return `${val.toFixed(2)}-1`;
}

// SmartPony's medication field is a bare "0"/"1" flag in this feed (not
// the multi-character code some other feeds use) — 1 is assumed to mean
// Lasix (by far the most common flagged race-day medication in North
// American racing), 0 means none. Genuinely uncertain for any other
// value, so those pass through as-is rather than guessing.
function smartponyMedicationLabel(code) {
  if (code == null) return null;
  if (code === "1") return "L";
  if (code === "0") return null;
  return code;
}

async function fetchSmartPonyEntriesDay(track, date) {
  const code = SMARTPONY_TRACK_CODE[track];
  if (!code) return { date, races: [] };
  const timeZone = SMARTPONY_TRACK_TIMEZONE[track] || "America/New_York";

  const racesRes = await fetch(
    `${SMARTPONY_SUPABASE_URL}/rest/v1/races?track=eq.${code}&race_date=eq.${date}` +
      `&select=id,race_num,distance_yards,surface,race_class,purse,post_time_utc,is_hurdle_race&order=race_num.asc`,
    { headers: { apikey: SMARTPONY_ANON_KEY }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!racesRes.ok) throw new Error(`SmartPony races returned HTTP ${racesRes.status}`);
  const raceRows = await racesRes.json();
  if (!raceRows.length) return { date, races: [] };

  const raceIdList = raceRows.map((r) => r.id).join(",");
  const entriesRes = await fetch(
    `${SMARTPONY_SUPABASE_URL}/rest/v1/race_entries?race_id=in.(${raceIdList})` +
      `&select=race_id,post_position,program_number,jockey,trainer,owner,weight,medication,ml_odds,is_scratched,` +
      `horses!fk_race_entries_horse_id(horse_name,sex,birth_year)&order=post_position.asc`,
    { headers: { apikey: SMARTPONY_ANON_KEY }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!entriesRes.ok) throw new Error(`SmartPony race_entries returned HTTP ${entriesRes.status}`);
  const entryRows = await entriesRes.json();

  const raceYear = parseInt(date.slice(0, 4), 10);
  const entriesByRace = {};
  for (const e of entryRows) {
    const horse = e.horses || {};
    const age = horse.birth_year ? raceYear - horse.birth_year : null;
    (entriesByRace[e.race_id] ??= []).push({
      postPosition: e.program_number || (e.post_position != null ? String(e.post_position) : null),
      name: horse.horse_name ? titleCaseName(horse.horse_name) : "Unknown",
      jockey: e.jockey ? reformatLastFirstName(e.jockey) : null,
      trainer: e.trainer ? reformatLastFirstName(e.trainer) : null,
      owner: e.owner ? titleCaseName(e.owner) : null,
      weight: e.weight != null ? String(e.weight) : null,
      medication: smartponyMedicationLabel(e.medication),
      ageSex: age != null && horse.sex ? `${age} ${horse.sex}` : null,
      scratched: !!e.is_scratched,
      currentOdds: null, // SmartPony has no live tote feed, only morning line
      mlOdds: formatSmartPonyMlOdds(e.ml_odds),
    });
  }

  const races = raceRows.map((r) => ({
    raceNumber: r.race_num,
    postTimeIso: toTrackLocalIso(r.post_time_utc, timeZone),
    mtpLabel: null,
    purse: r.purse != null ? `$${Number(r.purse).toLocaleString()}` : null,
    raceType: r.race_class || null,
    raceName: null, // SmartPony's feed has no stakes-name field to draw from
    distanceLabel: yardsToDistanceLabel(r.distance_yards),
    surface: r.is_hurdle_race ? `${r.surface || ""} (Hurdle)`.trim() : (r.surface || null),
    horses: entriesByRace[r.id] || [],
  }));
  return { date, races };
}
