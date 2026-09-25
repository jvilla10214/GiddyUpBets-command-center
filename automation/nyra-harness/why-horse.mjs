// Debug aid: which rule registered each horse, for chosen held-out articles.
import fs from "node:fs"; import path from "node:path";
import { loadWorker } from "./lib/load-worker.mjs"; import { fixturesDir } from "./lib/article.mjs";
const W = await loadWorker(process.argv[2]);
const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, "data.json"), "utf8"));
for (const slug of process.argv.slice(3)) {
  const f = fs.readdirSync(path.join(fixturesDir, "holdout")).find((x) => x.includes(slug));
  const track = f.split("_")[1];
  const blocks = W.parseNyraArticle(fs.readFileSync(path.join(fixturesDir, "holdout", f), "utf8"), track);
  const people = W.nyraPeopleInArticle(blocks.map((b) => b.text), data.jockeys);
  const why = {}; W.nyraHorsesInArticle(blocks, people, [], why, { trainers: data.trainers, jockeys: data.jockeys, knownHorseNames: data.notes.map((n) => n.horse).filter(Boolean) });
  console.log(`\n== ${slug}\nPEOPLE: ${Object.values(people).map((p) => `${p.name}[${p.role}]`).join(", ")}`);
  for (const [h, w] of Object.entries(why)) console.log(`  ${h.padEnd(30)} ← ${w}`);
}
