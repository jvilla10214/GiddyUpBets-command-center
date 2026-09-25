// Labeling aid: prints paragraphs (long quotes shortened) for one article.
import fs from "node:fs";
import { loadWorker } from "./lib/load-worker.mjs";
import { fullBodyParagraphs, fixtureFile } from "./lib/article.mjs";
const W = await loadWorker();
const a = JSON.parse(fs.readFileSync(new URL("./articles.json", import.meta.url))).find((x) => x.id === process.argv[2]);
const { paragraphs } = fullBodyParagraphs(fs.readFileSync(fixtureFile(a.path), "utf8"), W.decodeEntities);
const [from = 0, to = paragraphs.length - 1] = (process.argv[3] || "").split("-").filter(Boolean).map(Number);
for (let i = from; i <= to && i < paragraphs.length; i++) console.log(`p${i}: ${paragraphs[i].text.replace(/“[^”]{90,}”/g, (q) => q.slice(0, 60) + "…”")}`);
