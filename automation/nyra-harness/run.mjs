// NYRA News (job #20) coverage harness. Local only, never deployed.
//
//   node run.mjs            all test articles
//   node run.mjs <id>       one article (ids in articles.json)
//   node run.mjs --worker <path>   test a different copy of the Worker
//
// For every quoted span in each article (independent ground truth, hand
// labeled in truth/<id>.json) it reports whether the Worker's CURRENT
// fetchNyraNews() captured it, and if not, why. The "why" comes from
// replaying extractNyraSections()'s decision chain paragraph by paragraph;
// the replay is checked against the real function's output on every run
// ("replay fidelity"), so a reason can't silently drift from the real code.
import fs from "node:fs";
import { loadWorker } from "./lib/load-worker.mjs";
import { fullBodyParagraphs, findQuoteSpans, fixtureFile } from "./lib/article.mjs";

const args = process.argv.slice(2);
const workerArg = args.includes("--worker") ? args[args.indexOf("--worker") + 1] : undefined;
const quiet = args.includes("--summary");
const onlyId = args.find((a) => !a.startsWith("--") && a !== workerArg);
const W = await loadWorker(workerArg);
const articles = JSON.parse(fs.readFileSync(new URL("./articles.json", import.meta.url)));
const data = JSON.parse(fs.readFileSync(new URL("./fixtures/data.json", import.meta.url)));
const KNOWN_HORSES = data.notes.map((n) => n.horse).filter(Boolean);

const norm = (s) => (s || "").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const short = (s, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

// ---- Run the real fetchNyraNews() against cached pages ----
// The listing is cut down to just this article's own real anchor block, so
// fetchNyraNews() sees the article's real listing title/date regardless of
// how far down the live listing it has scrolled by now.
async function runRealWorker(a) {
  const listHtml = fs.readFileSync(fixtureFile(`${a.track}/news/`), "utf8");
  const href = `/${a.path}`;
  const start = listHtml.indexOf(`<a href="${href}" class="block">`);
  if (start === -1) throw new Error(`${a.id}: not found in cached ${a.track} listing`);
  const next = listHtml.indexOf(`<a href="/${a.track}/news/`, start + 10);
  const block = listHtml.slice(start, next === -1 ? undefined : next);
  const articleHtml = fs.readFileSync(fixtureFile(a.path), "utf8");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith(`/${a.track}/news/`)) return new Response(block, { status: 200 });
    if (u.endsWith(href)) return new Response(articleHtml, { status: 200 });
    return new Response("not cached", { status: 404 });
  };
  const trace = [];
  const options = { trackedTrainers: data.trainers, trackedJockeys: data.jockeys, knownTrainerKeyByHorse: W.nyraKnownTrainerKeyByHorse ? W.nyraKnownTrainerKeyByHorse(data.notes) : {}, knownHorseNames: KNOWN_HORSES, trace };
  try { return { result: await W.fetchNyraNews(a.track, options), articleHtml, trace }; }
  finally { globalThis.fetch = realFetch; }
}

// ---- Replay of extractNyraSections() Step 2, with reasons ----
// Mirrors the current code line for line; see the fidelity check below.
function replay(paragraphs, titleGuess) {
  const trainerNamePatterns = [
    /Trained by\s+(?:\S+\s+){0,6}?([A-Z][A-Za-z’']+(?:\s+[A-Z][A-Za-z’']+){0,2})[,.]/g,
    /Trained by\s+(?:\S+\s+){0,6}?([A-Z][A-Za-z’']+(?:\s+[A-Z][A-Za-z’']+){0,2})\s+for\b/g,
    /\b[Tt]rainer\s+([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){0,2})/g,
    /([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){0,2}),\s+trainer of\b/g,
    /([A-Z][A-Za-z’'-]+(?:\s+[A-Z][A-Za-z’'-]+){0,2})-trained\b/g,
  ];
  const byKey = {};
  for (const para of paragraphs) for (const re of trainerNamePatterns) for (const m of para.matchAll(re)) {
    const k = W.lastNameKey(m[1].trim());
    if (!byKey[k]) byKey[k] = m[1].trim();
  }
  const perPara = [];
  const sections = {};
  const noTrainers = !Object.keys(byKey).length;
  const titleIsTrainer = titleGuess && (byKey[W.lastNameKey(titleGuess)] || Object.values(byKey).some((n) => titleGuess.includes(n)));
  let currentHorse = titleIsTrainer ? null : titleGuess;
  for (const para of paragraphs) {
    const st = { currentHorse: null, attributed: null, key: null, fullName: null, spans: [], skip: null };
    perPara.push(st);
    if (noTrainers) { st.skip = "no-trainers"; continue; }
    if (W.NYRA_RETIRED_HORSE_SIGNAL_RE.test(para)) { st.skip = "retired"; continue; }
    const bh = W.extractNyraBracketHorse(para);
    if (bh) currentHorse = bh;
    st.currentHorse = currentHorse;
    if (!currentHorse) { st.skip = "no-horse"; continue; }
    const after = para.match(/\b([A-Z][A-Za-z’'-]+(?:\s[A-Z][A-Za-z’'-]+)?)\s+said\b/);
    const before = !after && para.match(/\bsaid\s+([A-Z][A-Za-z’'-]+(?:\s[A-Z][A-Za-z’'-]+)?)\b/);
    st.attributed = after ? after[1] : before ? before[1] : null;
    if (!st.attributed) { st.skip = "no-attribution"; continue; }
    st.key = W.lastNameKey(st.attributed);
    st.fullName = byKey[st.key] || null;
    if (!st.fullName) { st.skip = "unknown-key"; continue; }
    st.spans = [...para.matchAll(/[“"]([^”"]{4,600})[”"]/g)].map((m) => m[1].trim()).filter(Boolean);
    if (!st.spans.length) { st.skip = "no-spans"; continue; }
    const sk = `${st.key}|${currentHorse}`;
    if (!sections[sk]) sections[sk] = { trainerName: st.fullName, horseNames: [currentHorse], parts: [] };
    sections[sk].parts.push(st.spans.join(" "));
  }
  return {
    byKey, perPara, titleIsTrainer: !!titleIsTrainer,
    sections: Object.values(sections).map((s) => ({ trainerName: s.trainerName, horseNames: s.horseNames, text: s.parts.join(" ") })),
  };
}

const VERBS = "said|added|noted|explained|continued|remarked|offered|recalled|stated";
function whyNoAttribution(text, prevState) {
  if (new RegExp(`\\b(?:he|she)\\s+(?:${VERBS})\\b`, "i").test(text)) return "pronoun-only";
  if (/^[“"]/.test(text) && prevState && prevState.attributed && !new RegExp(`\\b(?:${VERBS})\\b`).test(text)) return "continuation paragraph";
  if (new RegExp(`,\\s*(?:Jr|Sr)\\.,?\\s+(?:${VERBS})\\b|\\b(?:II|III)\\s+(?:${VERBS})\\b`).test(text)) return "suffix mismatch (Jr./Sr.)";
  const m = text.match(new RegExp(`\\b([A-Z][A-Za-z’'-]+)\\s+(${VERBS})\\b|\\b(${VERBS})\\s+([A-Z][A-Za-z’'-]+)`));
  if (m) return `no attribution (verb "${m[2] || m[3]}" not recognized)`;
  return "no attribution";
}

// New extractor (has parseNyraArticle): judge from its own per-span trace,
// cross-checked against the sections it actually returned.
function classifyFromTrace(span, truth, trace, sections) {
  const key = norm(span.text).slice(0, 40);
  const t = trace.find((x) => !x.used && norm(x.text).slice(0, 40) === key);
  if (!t) return { ok: false, reason: "never seen by extractor (not parsed from body)" };
  t.used = true;
  if (t.decision !== "captured") return { ok: false, reason: t.decision };
  const filed = t.role === "jockey" ? t.jockeyName : t.trainerName;
  const res = { speaker: `${filed}${t.role === "assistant" ? ` (via ${t.speaker})` : ""}${t.role === "jockey" ? " [jockey]" : ""}`, horse: t.horse };
  const inOutput = sections.some((sec) => (sec.trainerName || sec.jockeyName) === filed && sec.horseNames.includes(t.horse) && norm(sec.text).includes(norm(span.text).slice(0, 40)));
  if (!inOutput) return { ok: false, captured: res, reason: "trace says captured but text missing from returned sections (BUG)" };
  if (truth.label === "exclude") return { ok: false, captured: res, reason: "captured an excluded span" };
  const want = truth.fileUnder || truth.speaker;
  if (W.lastNameKey(filed) !== W.lastNameKey(want)) return { ok: false, captured: res, reason: `captured under WRONG SPEAKER ${filed}` };
  if ((truth.role === "jockey") !== (t.role === "jockey")) return { ok: false, captured: res, reason: `WRONG ROLE (${t.role})` };
  if (!truth.horse.some((h) => norm(h) === norm(t.horse))) return { ok: false, captured: res, reason: `WRONG HORSE (filed as "${t.horse}")` };
  return { ok: true, captured: res };
}

function classify(span, truth, gtParas, rp, sliceCount) {
  const pi = span.para;
  if (!gtParas[pi].inSlice) return { ok: false, reason: "body truncated (Worker reads only first 20,000 chars)" };
  const st = rp.perPara[pi];
  const text = gtParas[pi].text;
  if (st.skip === "no-trainers") return { ok: false, reason: "no trainer intro anywhere (whole article yields nothing)" };
  if (st.skip === "retired") return { ok: false, reason: "retired-horse filter" };
  if (st.skip === "no-horse") return { ok: false, reason: "no currentHorse" };
  if (st.skip === "no-attribution") return { ok: false, reason: whyNoAttribution(text, rp.perPara[pi - 1]) };
  const truthKey = truth.speaker ? W.lastNameKey(truth.speaker) : null;
  if (st.skip === "unknown-key") {
    if (truthKey && st.key !== truthKey) return { ok: false, reason: `attributed to wrong name "${st.attributed}", then unknown key` };
    return { ok: false, reason: truth.role === "jockey" ? "unknown speaker key (jockey; no jockey support)" : `unknown speaker key ("${st.attributed}" never introduced as trainer)` };
  }
  // Paragraph captured. Did THIS span make it in?
  const inCaptured = st.spans.some((s) => norm(s).includes(norm(span.text).slice(0, 40)) || norm(span.text).includes(norm(s).slice(0, 40)));
  if (!inCaptured) return {
    ok: false,
    reason: span.text.length > 600 ? "span >600 chars"
      : span.unclosed ? "quote runs on into next paragraph (no closing mark; regex needs one)"
      : "quote regex missed span (mismatched marks)",
  };
  const res = { speaker: st.fullName, horse: st.currentHorse };
  if (truthKey && W.lastNameKey(st.fullName) !== truthKey) return { ok: false, captured: res, reason: `captured under WRONG SPEAKER ${st.fullName}` };
  if (truth.label !== "exclude" && !truth.horse.some((h) => norm(h) === norm(st.currentHorse))) return { ok: false, captured: res, reason: `WRONG HORSE (filed as "${st.currentHorse}")` };
  return { ok: true, captured: res };
}

let grand = { horse: 0, ok: 0, wrong: 0 };
const allReasons = {};
for (const a of articles.filter((x) => !onlyId || x.id === onlyId)) {
  const { result, articleHtml, trace } = await runRealWorker(a);
  const real = result.articles[0];
  const newMode = !!W.parseNyraArticle;
  const { paragraphs: gtParas } = fullBodyParagraphs(articleHtml, W.decodeEntities);
  const sliceParas = gtParas.filter((p) => p.inSlice).map((p) => p.text);
  const listTitle = real ? real.title : "(article produced no sections)";
  const titleGuess = newMode ? W.nyraTitleHorseGuess(real ? real.title : "") : W.extractNyraTitleHorse(real ? real.title : "");
  const rp = newMode ? { byKey: {}, titleIsTrainer: false, sections: [] } : replay(sliceParas, titleGuess);

  // Replay fidelity (old code only): replayed sections must equal the real output.
  const realSecs = JSON.stringify((real ? real.sections : []).map((s) => [s.trainerName, s.horseNames, s.text]));
  const repSecs = JSON.stringify(rp.sections.map((s) => [s.trainerName, s.horseNames, s.text]));
  const fidelity = newMode ? null : realSecs === repSecs;

  const truth = JSON.parse(fs.readFileSync(new URL(`./truth/${a.id}.json`, import.meta.url))).spans;
  const spans = findQuoteSpans(gtParas);
  const used = new Set();
  console.log(`\n${"=".repeat(100)}\n${a.id} — ${a.kind}\nhttps://www.nyra.com/${a.path}`);
  console.log(`listing title: "${listTitle}"  → headline horse guess: ${titleGuess ? `"${titleGuess}"` : "none"}${rp.titleIsTrainer ? " (rejected: matches a trainer)" : ""}`);
  if (newMode) console.log(`paragraphs: ${gtParas.length} in body | extractor saw ${trace.length} quote span(s)`);
  else console.log(`paragraphs: ${gtParas.length} in body, ${sliceParas.length} inside the Worker's 20k slice | trainers found: ${Object.values(rp.byKey).join(", ") || "none"}`);
  console.log(`real Worker output: ${real ? real.sections.length : 0} section(s) | ${newMode ? "judged from extractor trace + output" : `replay fidelity: ${fidelity ? "OK (replay == real output)" : "MISMATCH, reasons below are unreliable"}`}`);
  console.log("");
  let horse = 0, ok = 0, wrong = 0;
  for (const s of spans) {
    const t = truth.find((x, i) => !used.has(i) && x.p === s.para && norm(s.text).startsWith(norm(x.q)));
    if (!t) throw new Error(`${a.id}: unlabeled span p${s.para} "${short(s.text, 40)}" — add it to truth/${a.id}.json`);
    used.add(truth.indexOf(t));
    const c = newMode ? classifyFromTrace(s, t, trace, real ? real.sections : []) : classify(s, t, gtParas, rp);
    const who = t.label === "exclude" ? `(excluded: ${t.why})` : `${t.speaker}${t.fileUnder ? ` → ${t.fileUnder}` : ""} [${t.role}] / ${t.horse.join(" or ")}`;
    let verdict;
    if (t.label === "horse") {
      horse++;
      if (c.ok) { ok++; verdict = `CAPTURED → ${c.captured.speaker} / ${c.captured.horse}`; }
      else {
        if (c.captured) wrong++;
        verdict = `DROP: ${c.reason}`;
        allReasons[c.reason.replace(/".*?"/g, '"…"')] = (allReasons[c.reason.replace(/".*?"/g, '"…"')] || 0) + 1;
      }
    } else if (t.label === "optional") {
      verdict = c.ok ? `captured → ${c.captured.horse} (optional, fine)` : c.captured ? `optional, captured wrongly: ${c.reason}` : `optional, not captured (${c.reason})`;
    } else {
      verdict = c.captured ? `FALSE POSITIVE → filed as ${c.captured.speaker} / ${c.captured.horse}` : "not captured (correct)";
    }
    console.log(`p${String(s.para).padEnd(3)} ${String(s.text.length).padStart(4)}ch  ${short(s.text).padEnd(62)} | ${who}\n${" ".repeat(12)}→ ${verdict}`);
  }
  const unused = truth.filter((_, i) => !used.has(i));
  if (unused.length) console.log(`WARNING: ${unused.length} truth label(s) matched no span: ${unused.map((u) => `p${u.p} "${u.q}"`).join(", ")}`);
  console.log(`\nCOVERAGE: ${ok}/${horse} horse-specific quote spans captured correctly = ${((100 * ok) / horse).toFixed(1)}%   | misattributed (captured, wrong horse/speaker): ${wrong}`);

  // What the browser-side autoImportNyraNews() would then actually store.
  const tracked = data.trainers;
  console.log("\nClient-side filing of the real Worker output (resolveTrackedTrainer against /data's tracked list):");
  for (const sec of real ? real.sections : []) {
    if (sec.jockeyName) { console.log(`  [jockey] ${sec.jockeyName} / ${sec.horseNames.join(",")} → current browser import skips jockey sections (Stage 3 files them) | ${sec.text.length} chars: ${short(sec.text, 60)}`); continue; }
    const match = W.resolveTrackedTrainer(sec.trainerName, tracked);
    console.log(`  ${sec.trainerName}${sec.role === "assistant" ? ` (quotes by ${sec.speakerName})` : ""} / ${sec.horseNames.join(",")} → ${match ? `stored under "${match}"` : "DROPPED (untracked trainer)"} | ${sec.text.length} chars: ${short(sec.text, 60)}`);
  }
  if (!real || !real.sections.length) console.log("  (nothing to file)");
  grand.horse += horse; grand.ok += ok; grand.wrong += wrong;
}

console.log(`\n${"=".repeat(100)}\nALL ARTICLES: ${grand.ok}/${grand.horse} = ${((100 * grand.ok) / grand.horse).toFixed(1)}% coverage, ${grand.wrong} misattributed`);
console.log("Drop reasons (horse-specific spans):");
for (const [r, n] of Object.entries(allReasons).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(3)}  ${r}`);
