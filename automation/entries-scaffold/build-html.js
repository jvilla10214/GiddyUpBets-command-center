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

function buildEntriesHtml(trackDisplay, isoDate, data) {
  const races = [...data.races].sort((a, b) => a.raceNumber - b.raceNumber);

  // <style> is placed inside <body> (not <head>) because some lightweight HTML-to-Doc
  // importers only read body content and would silently drop a <head> block.
  let html = `<html><body><style>p,h1{border:none;border-width:0}</style><h1>${esc(trackDisplay)} Entries — ${esc(displayDate(isoDate))}</h1>`;

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

    for (const horse of horses) {
      const mlText = horse.mlOdds != null && horse.mlOdds !== '' ? horse.mlOdds : '—';
      const scrSuffix = horse.scratched ? ' (SCR)' : '';
      const jockey = horse.jockey || '—';
      const trainer = horse.trainer || '—';
      const pp = parseInt(horse.postPosition, 10);
      const color = COLORS[pp];

      let chicklet;
      if (color) {
        const bg = shortHex(color.bg);
        const style = color.fg === '000000'
          ? `background:#${bg}`
          : `background:#${bg};color:#${shortHex(color.fg)}`;
        chicklet = `<b><span style="${style}"> #${esc(horse.postPosition)} </span></b>`;
      } else {
        chicklet = `<b>#${esc(horse.postPosition)}</b>`;
      }

      html += `<p>${chicklet} ${esc(horse.name)}${scrSuffix} — <b>${esc(mlText)}</b> — ${esc(jockey)} / ${esc(trainer)}</p>`;
    }

    html += `<p>&nbsp;</p><p>&nbsp;</p>`;
  }

  html += `</body></html>`;
  return html;
}

module.exports = { buildEntriesHtml, displayDate, COLORS };
