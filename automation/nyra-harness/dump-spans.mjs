// Labeling aid: prints every quote span with its paragraph and the paragraph's
// non-quote text (where the attribution lives), to write truth/*.json by hand.
import fs from "node:fs";
import { loadWorker } from "./lib/load-worker.mjs";
import { fullBodyParagraphs, findQuoteSpans, fixtureFile } from "./lib/article.mjs";
const W = await loadWorker();
const articles = JSON.parse(fs.readFileSync(new URL("./articles.json", import.meta.url)));
for (const a of articles.filter((x) => !process.argv[2] || x.id === process.argv[2])) {
  const { paragraphs } = fullBodyParagraphs(fs.readFileSync(fixtureFile(a.path), "utf8"), W.decodeEntities);
  console.log(`\n=== ${a.id}`);
  findQuoteSpans(paragraphs).forEach((s, k) => {
    const p = paragraphs[s.para].text;
    const outside = p.replace(/“[^”]*”?|"[^"]*"?/g, "…").slice(0, 170);
    console.log(`#${k} p${s.para}${paragraphs[s.para].inSlice ? "" : " [beyond 20k]"}${s.unclosed ? " [unclosed]" : ""} len=${s.text.length} | ${s.text.slice(0, 60)}\n      ctx: ${outside}`);
  });
}
