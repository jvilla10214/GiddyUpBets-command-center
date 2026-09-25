// Debug aid: the people and horse registries the new extractor builds per article.
import fs from "node:fs";
import { loadWorker } from "./lib/load-worker.mjs";
import { fixtureFile } from "./lib/article.mjs";
const workerArg = process.argv.includes("--worker") ? process.argv[process.argv.indexOf("--worker") + 1] : undefined;
const W = await loadWorker(workerArg);
const data = JSON.parse(fs.readFileSync(new URL("./fixtures/data.json", import.meta.url)));
for (const a of JSON.parse(fs.readFileSync(new URL("./articles.json", import.meta.url)))) {
  const blocks = W.parseNyraArticle(fs.readFileSync(fixtureFile(a.path), "utf8"), a.track);
  const people = W.nyraPeopleInArticle(blocks.map((b) => b.text), data.jockeys);
  console.log(`\n== ${a.id}\nPEOPLE: ${Object.values(people).map((p) => `${p.name}[${p.role}${p.head ? "→" + p.head : ""}${p.ambiguous ? ",AMBIG" : ""}]`).join(", ")}`);
  console.log(`HORSES: ${W.nyraHorsesInArticle(blocks, people, [], null, { trainers: data.trainers, jockeys: data.jockeys }).join(" | ")}`);
}
