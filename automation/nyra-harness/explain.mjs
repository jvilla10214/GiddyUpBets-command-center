// Debug aid: for one held-out article, shows each filed quote with the two
// blocks before it, so a filing can be checked by eye.   node explain.mjs <worker> <slug> [horse]
import fs from "node:fs"; import path from "node:path";
import { loadWorker } from "./lib/load-worker.mjs"; import { fixturesDir } from "./lib/article.mjs";
const [workerPath, slug, horse] = process.argv.slice(2);
const W = await loadWorker(workerPath);
const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, "data.json"), "utf8"));
const KNOWN_HORSES = data.notes.map((n) => n.horse).filter(Boolean);
const f = fs.readdirSync(path.join(fixturesDir, "holdout")).find((x) => x.includes(slug));
const track = f.split("_")[1];
const blocks = W.parseNyraArticle(fs.readFileSync(path.join(fixturesDir, "holdout", f), "utf8"), track);
const trace = [];
const list = fs.readFileSync(path.join(fixturesDir, `${track}_news_.html`), "utf8"); const tm = list.match(new RegExp(`<a href="/${f.replace(/^_/, "").replace(/_/g, "/").replace(/\.html$/, "")}" class="block">[\\s\\S]*?<h2[^>]*>\\s*([\\s\\S]*?)\\s*</h2>`)); const title = tm ? W.decodeEntities(tm[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : ""; console.log("title:", title);
W.extractNyraSections(blocks, W.nyraTitleHorseGuess(title), { title, trackedTrainers: data.trainers, trackedJockeys: data.jockeys, knownTrainerKeyByHorse: W.nyraKnownTrainerKeyByHorse ? W.nyraKnownTrainerKeyByHorse(data.notes) : {}, knownHorseNames: KNOWN_HORSES, trace });
const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
for (const t of trace.filter((t) => t.decision === "captured" && (!horse || t.horse === horse))) {
  console.log(`\n>> ${t.jockeyName ? "[J] " + t.jockeyName : t.trainerName} / ${t.horse} (${t.how}; horse via ${t.via}) — "${cut(t.text, 70)}"`);
  for (let i = Math.max(0, t.block - 2); i <= t.block; i++) console.log(`   b${i}${blocks[i].heading ? "[H]" : ""}: ${cut(blocks[i].text, 230)}`);
}
