// Independent article parsing for GROUND TRUTH. Deliberately does not reuse
// the Worker's 20,000-char body slice, so anything the Worker never sees
// shows up as a miss instead of silently vanishing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixturesDir = path.join(here, "../fixtures");
export const fixtureFile = (p) => path.join(fixturesDir, `${p.replace(/\//g, "_")}.html`);

// Same paragraph/entity handling as fetchNyraNews(), over the WHOLE body.
export function fullBodyParagraphs(html, decodeEntities) {
  const bodyIdx = html.indexOf('class="format-text"');
  if (bodyIdx === -1) return { paragraphs: [], inWorkerSlice: 0 };
  const all = [...html.slice(bodyIdx).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
  const clean = (m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const sliceEnd = bodyIdx + 20000;
  const paragraphs = [];
  let inWorkerSlice = 0;
  for (const m of all) {
    const text = clean(m);
    if (!text) continue;
    // A <p> the Worker's 20k slice fully contains (its closing tag included).
    const absEnd = bodyIdx + m.index + m[0].length;
    const inSlice = absEnd <= sliceEnd;
    if (inSlice) inWorkerSlice++;
    paragraphs.push({ text, inSlice });
  }
  return { paragraphs, inWorkerSlice };
}

// Every quoted span (curly or straight double quotes, >=4 chars inside).
// A curly quote left open at the end of a paragraph is a multi-paragraph
// quote (NYRA style: each continuing paragraph re-opens with “, only the
// last one closes); it's recorded per paragraph, flagged `unclosed`.
export function findQuoteSpans(paragraphs) {
  const spans = [];
  paragraphs.forEach(({ text }, pi) => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch !== "“" && ch !== '"') { i++; continue; }
      // NYRA mixes straight and curly marks within one paragraph ("…” and
      // “…"), so either closing mark ends a span, whichever comes first.
      const closers = ["”", '"'].map((c) => text.indexOf(c, i + 1)).filter((x) => x !== -1);
      const j = closers.length ? Math.min(...closers) : -1;
      const unclosed = j === -1;
      const end = unclosed ? text.length : j;
      const inner = text.slice(i + 1, end).trim();
      if (inner.length >= 4) spans.push({ para: pi, start: i, end, text: inner, unclosed });
      i = end + 1;
    }
  });
  return spans;
}
