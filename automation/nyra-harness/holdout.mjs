// Held-out check: runs the extractor on recent NYRA articles that are NOT in
// the labeled test set, and prints every filed section for a human to review.
// Pages are cached under fixtures/holdout/ (gitignored).
//   node holdout.mjs [--worker path] [--limit N]
import fs from "node:fs";
import path from "node:path";
import { loadWorker } from "./lib/load-worker.mjs";
import { fixtureFile, fixturesDir } from "./lib/article.mjs";
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const W = await loadWorker(opt("--worker"));
const limit = Number(opt("--limit") || 20);
const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, "data.json"), "utf8"));
const KNOWN_HORSES = data.notes.map((n) => n.horse).filter(Boolean);
const tested = new Set(JSON.parse(fs.readFileSync(new URL("./articles.json", import.meta.url))).map((a) => `/${a.path}`));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const dir = path.join(fixturesDir, "holdout");
fs.mkdirSync(dir, { recursive: true });
const short = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
let totalSecs = 0, totalSpans = 0, totalCaptured = 0;
for (const track of ["belmont", "saratoga"]) {
  const list = fs.readFileSync(fixtureFile(`${track}/news/`), "utf8");
  const re = new RegExp(`<a href="(/${track}/news/[^"]+/)" class="block">[\\s\\S]*?<h2[^>]*>\\s*([\\s\\S]*?)\\s*</h2>`, "g");
  const items = [...new Map([...list.matchAll(re)].map((m) => [m[1], W.decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()])).entries()]
    .filter(([href, title]) => !tested.has(href) && !W.NYRA_RETIRED_HORSE_SIGNAL_RE.test(title)).slice(0, limit);
  for (const [href, title] of items) {
    const f = path.join(dir, href.replace(/\//g, "_") + ".html");
    if (!fs.existsSync(f)) {
      const res = await fetch(`https://www.nyra.com${href}`, { headers: { "User-Agent": UA } });
      fs.writeFileSync(f, res.ok ? await res.text() : "");
    }
    const blocks = W.parseNyraArticle(fs.readFileSync(f, "utf8"), track);
    if (W.nyraIsRetrospective && W.nyraIsRetrospective(blocks)) { console.log(`\n## ${href}  "${short(title, 70)}"  — skipped: retrospective article`); continue; }
    const trace = [];
    const secs = W.extractNyraSections(blocks, W.nyraTitleHorseGuess(title), { trackedTrainers: data.trainers, trackedJockeys: data.jockeys, knownTrainerKeyByHorse: W.nyraKnownTrainerKeyByHorse ? W.nyraKnownTrainerKeyByHorse(data.notes) : {}, knownHorseNames: KNOWN_HORSES, title, trace });
    const cap = trace.filter((t) => t.decision === "captured").length;
    totalSecs += secs.length; totalSpans += trace.length; totalCaptured += cap;
    console.log(`\n## ${href}  "${short(title, 70)}"  — ${trace.length} quote spans, ${cap} filed, ${secs.length} notes`);
    for (const s of secs) console.log(`   ${(s.jockeyName ? `[J] ${s.jockeyName}` : s.trainerName + (s.role === "assistant" ? ` (via ${s.speakerName})` : "")).padEnd(34)} / ${s.horseNames[0].padEnd(22)} | ${short(s.text, 70)}`);
    const drops = {};
    for (const t of trace.filter((t) => t.decision !== "captured")) drops[t.decision] = (drops[t.decision] || 0) + 1;
    if (Object.keys(drops).length) console.log(`   dropped: ${Object.entries(drops).map(([k, v]) => `${v}× ${k}`).join("; ")}`);
  }
}
console.log(`\nHELD-OUT TOTAL: ${totalSpans} quote spans (incl. non-horse phrases), ${totalCaptured} filed into ${totalSecs} notes`);
