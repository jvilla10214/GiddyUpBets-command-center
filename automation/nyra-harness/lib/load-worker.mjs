// Loads workers/stable-tour-feed.js UNMODIFIED, plus one appended export line,
// so the harness exercises exactly the code that gets pasted into Cloudflare.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

export async function loadWorker(workerPath = path.join(root, "workers/stable-tour-feed.js")) {
  const src = fs.readFileSync(workerPath, "utf8");
  // Exported only if defined, so old and new versions of the file both load.
  const wanted = [
    "fetchNyraNews", "extractNyraSections", "extractNyraTitleHorse", "extractNyraBracketHorse",
    "lastNameKey", "resolveTrackedTrainer", "decodeEntities", "NYRA_RETIRED_HORSE_SIGNAL_RE",
    "parseNyraArticle", "nyraIsRetrospective", "nyraTitleHorseGuess", "nyraPeopleInArticle", "nyraHorsesInArticle", "nyraHorsesMentioned", "nyraConnections", "runNyraNewsImport", "NYRA_NEWS_MAX_ARTICLES_PER_RUN", "nyraKnownTrainerKeyByHorse",
  ];
  const present = wanted.filter((n) => new RegExp(`\\b(?:async\\s+)?(?:function|const|let)\\s+${n}\\b`).test(src));
  const out = path.join(here, "../.cache", path.basename(workerPath).replace(/\.js$/, ".under-test.mjs"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${src}\nexport { ${present.join(", ")} };\n`);
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}
