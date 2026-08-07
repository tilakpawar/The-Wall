/**
 * The news desk — a Ground News-ish reader.
 *
 * Method, and why:
 *   1. Pull recent articles per section from GDELT, which indexes thousands of
 *      outlets worldwide and needs no key.
 *   2. Cluster articles that are clearly the same story (title token overlap).
 *   3. Rank by HOW MANY DISTINCT OUTLETS covered it. Breadth of coverage is a
 *      far better importance signal than any single outlet's front page, and
 *      it can't be gamed by one publisher shouting loudly.
 *   4. Hand each cluster to the model with every headline and outlet, and ask
 *      for one plain-language paragraph describing only what the coverage
 *      agrees on — explicitly flagging where outlets diverge.
 *
 * Bias is surfaced as data (outlet count + names) rather than adjudicated.
 * Nobody's politics are being scored here, including mine.
 */

import { NEWS_SECTIONS, NEWS_PER_SECTION, NEWS_BLOCKED_DOMAINS, NEWS_TIMEOUT_MS } from './sources.mjs';

const UA = 'thewall/3.0 (personal reading dashboard)';
const log = (...a) => console.log('  news ·', ...a);
const warn = (...a) => console.warn('  !', ...a);

/* ------------------------------------------------------------------ utils */

const STOP = new Set(('a an the and or but of in on at to for from by with as is are was were '
  + 'be been being has have had will would can could may might said says say new after over '
  + 'amid into its it this that these those he she they them his her their you we not').split(' '));

/** Title → meaningful token set, for comparing whether two headlines match. */
export function tokens(title = '') {
  return new Set(
    String(title).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
}

export const domainOf = (url = '') => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

/** Fetch with a hard deadline — GDELT can hang, and a stuck build helps nobody. */
async function getJson(url, ms = NEWS_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- cluster */

/**
 * Greedy clustering: an article joins the first cluster whose seed headline it
 * substantially overlaps with, otherwise it starts a new one.
 * Returns clusters sorted by distinct-outlet count.
 */
export function clusterStories(articles, threshold = 0.42) {
  const clusters = [];

  for (const a of articles) {
    const tk = tokens(a.title);
    if (tk.size < 3) continue;

    let placed = false;
    for (const c of clusters) {
      if (jaccard(tk, c.tokens) >= threshold) {
        c.articles.push(a);
        c.outlets.add(a.domain);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ tokens: tk, articles: [a], outlets: new Set([a.domain]) });
  }

  return clusters
    .map((c) => ({
      title: c.articles[0].title,
      articles: c.articles,
      outlets: [...c.outlets].filter(Boolean),
      url: c.articles[0].url,
      image: c.articles.find((a) => a.image)?.image || null,
      ts: Math.max(...c.articles.map((a) => a.ts || 0)),
    }))
    .sort((a, b) => b.outlets.length - a.outlets.length || b.ts - a.ts);
}

/* ------------------------------------------------------------------ gdelt */

async function gdelt(query) {
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + `?query=${encodeURIComponent(query)}`
    + '&mode=artlist&maxrecords=250&format=json&timespan=36h&sort=hybridrel';
  const j = await getJson(url);
  return (j?.articles || []).map((a) => ({
    title: (a.title || '').trim(),
    url: a.url,
    domain: domainOf(a.url || a.domain),
    image: a.socialimage || null,
    ts: Math.floor(new Date(
      String(a.seendate || '').replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
    ).getTime() / 1000) || 0,
  })).filter((a) => a.title && a.url);
}

/* -------------------------------------------------------------- rss fallback */

async function rssArticles(feeds, parseRss) {
  const out = [];
  for (const [url, name] of feeds) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) { warn(`${name} -> ${r.status}`); continue; }
      for (const it of parseRss(await r.text(), name, 'nw_')) {
        out.push({ title: it.title, url: it.sourceUrl, domain: domainOf(it.sourceUrl) || name, image: it.src, ts: it.ts });
      }
    } catch (e) { warn(`${name} failed:`, e.message); }
  }
  return out;
}

/* ------------------------------------------------------------- summarise */

/**
 * One model call per section. Every cluster in that section goes in at once,
 * so a build costs four calls total regardless of story count.
 */
async function summarise(ask, sectionLabel, clusters) {
  const brief = clusters.map((c, i) => {
    const heads = c.articles.slice(0, 8).map((a) => `    - ${a.domain}: ${a.title.slice(0, 140)}`).join('\n');
    return `${i}. [${c.outlets.length} outlets]\n${heads}`;
  }).join('\n\n');

  const prompt =
`You are writing a neutral daily briefing for the "${sectionLabel}" section. Each numbered item below is ONE story, listed as the headlines several different outlets published about it.

For each story write:
- "h": a plain, factual headline of 6-12 words. No clickbait, no question marks, no colons.
- "p": ONE paragraph of 110-150 words in clear, everyday language, for a reader who has not followed this story at all. Explain what happened, the essential background needed to understand it, and why it is being widely covered right now. Write flowing prose, not a list.

Hard rules:
- State only what the headlines across outlets actually support. Do not invent numbers, quotes, dates or outcomes.
- If outlets clearly characterise the story differently, say so plainly in one sentence, e.g. "Coverage differs on whether X was a cause or a consequence."
- No adjectives that take a side (devastating, heroic, disastrous, brave). Attribute contested claims rather than asserting them.
- If the headlines are too thin to write 110 words honestly, write a shorter paragraph instead of padding. Never speculate to reach a length.

Reply with ONLY: {"stories":[{"i":0,"h":"...","p":"..."}]}

${brief}`;

  const { text, usage } = await ask(prompt, 6000);
  return { text, usage };
}

/* ------------------------------------------------------------------- main */

/**
 * @param ask       async (prompt, maxTokens) => {text, usage}   — or null
 * @param parseJson (text, fallback) => any
 * @param parseRss  the shared RSS parser from build-feed.mjs
 */
export async function buildNews({ ask, parseJson, parseRss }) {
  const out = [];

  for (const [key, cfg] of Object.entries(NEWS_SECTIONS)) {
    let articles = [];

    try {
      articles = await gdelt(cfg.query);
      log(`${key}: ${articles.length} articles from gdelt`);
    } catch (e) {
      warn(`gdelt ${key} failed (${e.name === 'AbortError' ? 'timeout' : e.message}) — trying rss`);
    }

    if (articles.length < 20 && cfg.rss?.length) {
      const extra = await rssArticles(cfg.rss, parseRss);
      log(`${key}: +${extra.length} from rss fallback`);
      articles = articles.concat(extra);
    }

    // Drop anything the user has explicitly blocked, then dedupe by URL.
    const seen = new Set();
    articles = articles.filter((a) => {
      if (!a.domain || NEWS_BLOCKED_DOMAINS.includes(a.domain)) return false;
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });

    if (!articles.length) { warn(`${key}: no articles, skipping section`); continue; }

    const clusters = clusterStories(articles)
      .filter((c) => c.outlets.length >= 2)      // one outlet is not a story yet
      .slice(0, NEWS_PER_SECTION);

    if (!clusters.length) { warn(`${key}: nothing covered by 2+ outlets`); continue; }
    log(`${key}: ${clusters.length} stories (top has ${clusters[0].outlets.length} outlets)`);

    // Write-ups. Without a model the item still carries the headline and the
    // outlet list, which is most of the value.
    let written = [];
    if (ask) {
      try {
        const { text, usage } = await summarise(ask, cfg.label, clusters);
        written = parseJson(text, {})?.stories || [];
        log(`${key}: summarised (in≈${usage.input_tokens} out≈${usage.output_tokens})`);
      } catch (e) { warn(`${key} summary failed:`, e.message); }
    }

    clusters.forEach((c, i) => {
      const w = written.find((s) => s.i === i);
      out.push({
        id: 'nw_' + key + '_' + hash(c.title),
        topic: key,
        source: `${c.outlets.length} outlets`,
        sourceUrl: c.url,
        title: (w?.h || c.title).trim(),
        score: c.outlets.length,
        comments: null,
        ts: c.ts || Math.floor(Date.now() / 1000),
        body: '',
        blurb: null,
        comment: null, commentBy: null,
        article: (w?.p || '').trim() || null,      // the read-on-the-wall paragraph
        outlets: c.outlets.slice(0, 12),
        kind: c.image ? 'image' : 'text',
        src: c.image, srcset: null, w: null, h: null, video: null,
      });
    });
  }

  log(`${out.length} stories total`);
  return out;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
