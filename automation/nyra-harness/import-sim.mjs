// End-to-end simulation of runNyraNewsImport() and the scheduled() dispatch
// against a fake KV seeded from fixtures/data.json and NYRA pages served from
// fixtures/ (missing articles are fetched live once and cached). Counts every
// subrequest and KV operation. Local only.
import fs from "node:fs";
import path from "node:path";
import { loadWorker } from "./lib/load-worker.mjs";
import { fixturesDir } from "./lib/article.mjs";

const W = await loadWorker();
const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, "data.json"), "utf8"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const realFetch = globalThis.fetch;

function fakeEnv() {
  const store = new Map(Object.entries({
    notes: JSON.stringify(data.notes), trainers: JSON.stringify(data.trainers), jockeys: JSON.stringify(data.jockeys || []),
    jockeyMeta: "{}", trainerMeta: "{}", dataVersion: "1",
  }));
  const ops = { get: 0, put: 0, putKeys: {} };
  return {
    ops, store,
    env: { STABLE_KV: {
      get: async (k) => { ops.get++; return store.has(k) ? store.get(k) : null; },
      put: async (k, v) => { ops.put++; const g = k.replace(/:[^:]*$/, ":*"); ops.putKeys[g] = (ops.putKeys[g] || 0) + 1; store.set(k, v); },
      list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
      delete: async (k) => { store.delete(k); },
    } },
  };
}
const fetchLog = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  fetchLog.push(u.pathname);
  const flat = u.pathname.replace(/\//g, "_");
  const candidates = [path.join(fixturesDir, `${flat.replace(/^_/, "")}.html`), path.join(fixturesDir, "holdout", `${flat}.html`)];
  let f = candidates.find((c) => fs.existsSync(c));
  if (!f) {
    const res = await realFetch(u, { headers: { "User-Agent": UA } });
    f = candidates[1];
    fs.writeFileSync(f, res.ok ? await res.text() : "");
  }
  const body = fs.readFileSync(f, "utf8");
  return new Response(body, { status: body ? 200 : 404 });
};

const { env, ops, store } = fakeEnv();
const before = JSON.parse(store.get("notes")).length;
for (let run = 1; run <= 6; run++) {
  fetchLog.length = 0; ops.get = 0; ops.put = 0; ops.putKeys = {};
  const t0 = performance.now();
  const s = await W.runNyraNewsImport(env);
  const ms = performance.now() - t0;
  console.log(`run ${run}: subrequests=${fetchLog.length} | fetched=${s.fetched} sections=${s.sections} written=${s.written} dup=${s.duplicates} untracked=${s.untracked}${s.error ? " ERROR " + s.error : ""} | KV get=${ops.get} put=${ops.put} ${JSON.stringify(ops.putKeys)} | ${ms.toFixed(0)} ms wall`);
  console.log(`        per track: ${JSON.stringify(s.tracks)}`);
  if (!s.fetched) break;
}
const notes = JSON.parse(store.get("notes"));
const added = notes.slice(before);
console.log(`\nTOTAL notes added: ${added.length}`);
const byArticle = {};
for (const n of added) (byArticle[n.link.split("#")[0]] ||= []).push(n);
const primary = "https://www.nyra.com/belmont/news/notes-september-24-2026/";
console.log(`\nPrimary article (${primary}):`);
for (const n of byArticle[primary] || []) console.log(`  ${n.horse.padEnd(19)} ${(n.trainer || "[J] " + n.jockey).padEnd(18)} ${n.link.split("#")[1].padEnd(20)} | ${n.note.slice(0, 70)}…`);
console.log(`\nAll articles: ${Object.keys(byArticle).length} with new notes`);
for (const [l, ns] of Object.entries(byArticle)) console.log(`  ${l.replace("https://www.nyra.com", "").slice(0, 80).padEnd(81)} ${ns.length} note(s): ${ns.map((n) => n.horse).join(", ")}`);
// duplicates check
const keys = added.map((n) => `${n.trainer}|${n.jockey}|${n.horse}|${n.link.split("#")[0]}`);
console.log(`\nduplicate (trainer,jockey,horse,link) among added: ${keys.length - new Set(keys).size}`);
fetchLog.length = 0;
const forced = await W.runNyraNewsImport(env, { force: true });
console.log(`force re-run: fetched=${forced.fetched} written=${forced.written} duplicates=${forced.duplicates} (expect written=0)`);
const unt = JSON.parse(store.get("nyra:untracked") || "[]");
console.log(`\nnyra:untracked entries: ${unt.length}`); for (const u of unt.slice(0, 15)) console.log(`  ${u.role.padEnd(9)} ${String(u.name).padEnd(22)} / ${u.horse.padEnd(20)} ${u.link.replace("https://www.nyra.com", "")}`);

// scheduled() dispatch: NYRA cron at 7am ET runs the job; at 9am ET does nothing; other crons untouched
const RealDate = Date;
async function fireAt(iso, cron) {
  const fixed = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
  const waits = [];
  const e2 = fakeEnv();
  fetchLog.length = 0;
  try { await W.default.scheduled({ cron }, e2.env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); }
  finally { globalThis.Date = RealDate; }
  return { jobs: waits.length, subrequests: fetchLog.length };
}
console.log("\nscheduled() dispatch:");
for (const [iso, cron, label] of [
  ["2026-09-25T11:00:00Z", "0 11,12,19,20 * * *", "NYRA cron, 7am EDT"],
  ["2026-09-25T12:00:00Z", "0 11,12,19,20 * * *", "NYRA cron, 8am EDT (no-op)"],
  ["2026-09-25T19:00:00Z", "0 11,12,19,20 * * *", "NYRA cron, 3pm EDT"],
  ["2026-12-15T12:00:00Z", "0 11,12,19,20 * * *", "NYRA cron, 7am EST"],
  ["2026-12-15T11:00:00Z", "0 11,12,19,20 * * *", "NYRA cron, 6am EST (no-op)"],
]) { const r = await fireAt(iso, cron); console.log(`  ${label.padEnd(28)} → ${r.jobs} job(s) started, ${r.subrequests} subrequests`); }
globalThis.fetch = realFetch;
