// Builds the entries-scaffold HTML for one track/date. Pure function, no I/O —
// used by both run.js (production) and manual testing.

const COLORS = {
  1: { bg: 'e21f26', fg: 'ffffff' },
  2: { bg: 'ffffff', fg: '000000' },
  3: { bg: '1c4faa', fg: 'ffffff' },
  4: { bg: 'ffd400', fg: '000000' },
  5: { bg: '1a7a3c', fg: 'ffffff' },
  6: { bg: '000000', fg: 'ffd400' },
  7: { bg: 'f7941d', fg: '000000' },
  8: { bg: 'f2a7c3', fg: '000000' },
  9: { bg: '40e0d0', fg: '000000' },
  10: { bg: '7b2d8e', fg: 'ffffff' },
  11: { bg: '9a9a9a', fg: 'c1272d' },
  12: { bg: '9acd32', fg: '000000' },
};

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortHex(h) {
  if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5]) return h[0] + h[2] + h[4];
  return h;
}

function displayDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

// Bare chicklet only (post-position number, no name/odds) — used in the Pace: column.
// CSS classes do NOT survive Drive's HTML-to-Doc converter (tested 2026-09-07: colors
// silently failed to render even though the upload itself succeeded) — always use full
// inline style="background:#..." on every chicklet span, never a <style> class reference.
function chickletHtml(postPosition) {
  const pp = parseInt(postPosition, 10);
  const color = COLORS[pp];
  if (!color) return `<b>#${esc(postPosition)}</b>`;
  const bg = shortHex(color.bg);
  const style = color.fg === '000000'
    ? `background:#${bg}`
    : `background:#${bg};color:#${shortHex(color.fg)}`;
  return `<b><span style="${style}">#${esc(postPosition)}</span></b>`;
}

function buildEntriesHtml(trackDisplay, isoDate, data) {
  const races = [...data.races].sort((a, b) => a.raceNumber - b.raceNumber);

  // <style> is placed inside <body> (not <head>) because some lightweight HTML-to-Doc
  // importers only read body content and would silently drop a <head> block.
  // Title is a plain bold <p> at 16pt, not <h1> — Google Docs' default Heading 1 style
  // renders at 24pt, which is too big for what's just a document label (2026-09-07).
  let html = `<html><body><style>p,h1{border:none;border-width:0}</style>` +
    `<p><b style="font-size:16pt">${esc(trackDisplay)} Entries — ${esc(displayDate(isoDate))}</b></p>`;

  for (const race of races) {
    const classLabel = race.raceName ? race.raceName : race.raceType;
    // race.surface is "Dirt" or a turf course name ("Mellon Turf" / "Inner Turf" / "Widener
    // Turf", etc. — depends on the Worker's NYRA turf-course cross-reference being deployed;
    // falls back to a bare "Turf" otherwise). Any turf race gets a green title; the inner
    // course additionally gets "INNER" capitalized rather than "Inner".
    const isTurf = !!(race.surface && /turf/i.test(race.surface));
    const displaySurface = race.surface ? race.surface.replace(/^inner\b/i, 'INNER') : null;
    const middle = displaySurface
      ? `${esc(race.distanceLabel)} · ${esc(displaySurface)}`
      : esc(race.distanceLabel);
    const titleStyle = isTurf ? ' style="color:#1a7a3c"' : '';
    html += `<p><b${titleStyle}><u>R${race.raceNumber}: ${middle} – ${esc(classLabel)}</u></b></p>`;
    html += `<p>Pace:</p>`;

    const horses = [...race.horses].sort((a, b) => parseInt(a.postPosition, 10) - parseInt(b.postPosition, 10));

    // Pace column: bare chicklet per horse, joined with <br> (not separate <p> tags, to
    // keep payload size down — a big card's doubled chicklet count can otherwise approach
    // the upload's truncation ceiling), then a single blank line separating it from the
    // entries list below (2026-09-07).
    html += `<p>${horses.map((h) => chickletHtml(h.postPosition)).join('<br>')}</p>`;
    html += `<p>&nbsp;</p>`;

    for (const horse of horses) {
      const mlText = horse.mlOdds != null && horse.mlOdds !== '' ? horse.mlOdds : '—';
      const scrSuffix = horse.scratched ? ' (SCR)' : '';
      const jockey = horse.jockey || '—';
      const trainer = horse.trainer || '—';
      const chicklet = chickletHtml(horse.postPosition);

      // Odds are plain text, not bold — user preference (changed 2026-09-07).
      html += `<p>${chicklet} ${esc(horse.name)}${scrSuffix} — ${esc(mlText)} — ${esc(jockey)} / ${esc(trainer)}</p>`;
      // Two blank lines after EACH horse (not once per race) — deliberate space for
      // hand-written trip notes on that specific horse (changed 2026-09-07).
      html += `<p>&nbsp;</p><p>&nbsp;</p>`;
    }
  }

  html += `</body></html>`;
  return html;
}

module.exports = { buildEntriesHtml, displayDate, COLORS };
