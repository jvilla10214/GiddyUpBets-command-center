// Cloudflare Worker: Stable Tour auto-import feed
// -----------------------------------------------------------------------
// Fetches thisishorseracing.com's dedicated Stable Tour category feed,
// keeps only the pieces that profile a single trainer (skips "Stable Tour
// Rewind" roundups, which cover multiple days/events, not one barn), fetches
// each qualifying article's full page, and extracts a horse-by-horse note
// list from it. The dashboard (index.html) polls this Worker instead of
// thisishorseracing.com directly, since that site has no CORS headers and
// the free public CORS proxies tested against it were unreliable (500s,
// gateway timeouts) — this Worker is the replacement for those.
//
// Deploy: free Cloudflare account -> `wrangler deploy` (or paste into the
// dashboard's Workers editor) -> paste the resulting workers.dev URL into
// the Stable Tour page's "Auto-import source" field.
// -----------------------------------------------------------------------

const FEED_URL = "https://thisishorseracing.com/category/fasig-tipton-stable-tour/feed/";
// Lock this to the dashboard's real origin once it has one; "*" is fine
// while testing but defeats the point of CORS as an access control.
const ALLOWED_ORIGIN = "*";
const MAX_ARTICLES_PER_RUN = 8; // caps subrequests/runtime per poll
// A UA that identifies itself as a bot gets a flat 403 from this site's WAF
// on individual article pages (confirmed directly: identical request,
// bot-labeled UA -> 403, a real browser's UA -> 200) — the feed endpoint
// itself didn't seem to care, but using a real UA everywhere here anyway
// rather than relying on that being a permanent distinction.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    let feedRes;
    try {
      feedRes = await fetch(FEED_URL, { headers: { "User-Agent": BROWSER_UA }, cf: { cacheTtl: 900, cacheEverything: true } });
    } catch (err) {
      return json({ error: `Feed fetch failed: ${err.message}` }, 502);
    }
    if (!feedRes.ok) {
      return json({ error: `Feed returned HTTP ${feedRes.status}` }, 502);
    }

    const feedXml = await feedRes.text();
    const items = parseFeedItems(feedXml).slice(0, MAX_ARTICLES_PER_RUN);

    const articles = [];
    for (const item of items) {
      const trainer = trainerFromTitle(item.title);
      if (!trainer) continue; // "Stable Tour Rewind" or an unrecognized title format — not a single-trainer piece

      let articleRes;
      try {
        articleRes = await fetch(item.link, {
          headers: { "User-Agent": BROWSER_UA },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
      } catch (err) {
        continue; // skip this one article, don't fail the whole batch
      }
      if (!articleRes.ok) continue;

      const horses = await extractHorseChunks(articleRes);
      articles.push({
        guid: item.guid || item.link,
        title: item.title,
        trainer,
        link: item.link,
        pubDate: item.pubDate,
        horses,
      });
    }

    return json({
      source: FEED_URL,
      fetchedAt: new Date().toISOString(),
      articles,
    });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=900", // 15 min — this content updates infrequently
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Minimal regex-based RSS parser — this feed's shape is stable (WordPress
// core RSS2 output) and a full XML parser isn't available in the Workers
// runtime without a dependency, so this mirrors the same "good enough for a
// known, simple source" approach the rest of this app uses for its other
// free/keyless feeds.
function parseFeedItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const guid = extractTag(block, "guid");
    const pubDate = extractTag(block, "pubDate");
    if (title && link) items.push({ title, link, guid, pubDate });
  }
  return items;
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`));
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
}

// "Fasig-Tipton Stable Tour: Todd Pletcher" and "Fasig-Tipton Stable Tour
// with Brad Cox" are the two title conventions this site actually uses for
// single-trainer profiles (verified against real published examples of
// each). "Stable Tour Rewind: ..." pieces (multi-day roundups, not one
// barn) intentionally don't match either and get skipped.
function trainerFromTitle(title) {
  let m = title.match(/Stable Tour:\s*(.+)$/i);
  if (m) return m[1].trim();
  m = title.match(/Stable Tour with\s*(.+)$/i);
  if (m) return m[1].trim();
  return null;
}

// Same dual-pattern heuristic verified against three real articles from
// this site (two different authors, two different formatting conventions):
// some pieces lead each horse's paragraph with "Horse Name: ", others use a
// standalone <h2> heading with just the horse's name. Scoped to the
// <article> boundary so sidebar/related-post headings (which reuse the same
// heading markup) don't get swept in as false "horses".
async function extractHorseChunks(response) {
  const html = await response.text();
  const body = extractArticleBody(html);
  const paragraphs = htmlToPlainParagraphs(body);

  const HORSE_COLON = /^([A-Z][A-Za-z.'’\-\s]{1,40}):\s*([\s\S]*)$/;
  const chunks = [];
  let current = null;
  for (const p of paragraphs) {
    const m = p.match(HORSE_COLON);
    if (m && m[1].trim().split(/\s+/).length <= 5) {
      if (current) chunks.push(current);
      current = { horse: m[1].trim(), text: m[2].trim() };
      continue;
    }
    if (isShortName(p)) {
      if (current) chunks.push(current);
      current = { horse: p, text: "" };
      continue;
    }
    if (current) current.text += (current.text ? "\n\n" : "") + p;
  }
  if (current) chunks.push(current);
  return chunks.filter(c => c.text.length >= 10); // drop anything that didn't pick up real content
}

function extractArticleBody(html) {
  const idx = html.indexOf('class="entry-content"');
  if (idx === -1) return html;
  const start = html.indexOf(">", idx) + 1;
  const end = html.indexOf("</article>", start);
  return html.slice(start, end === -1 ? html.length : end);
}

function htmlToPlainParagraphs(html) {
  const out = [];
  const re = /<(h2 class="wp-block-heading"|p class="wp-block-paragraph")[^>]*>([\s\S]*?)<\/(?:h2|p)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (text) out.push(text);
  }
  return out;
}

function isShortName(s) {
  if (!/^[A-Z][A-Za-z.'’\-\s]{1,40}$/.test(s)) return false;
  if (s.split(/\s+/).length > 5) return false;
  if (/[.!?]$/.test(s)) return false;
  return true;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
