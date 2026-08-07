#!/usr/bin/env node
/**
 * Builds data/feed.json — the static payload GitHub Pages serves.
 * Zero npm dependencies. Node 20+ (needs global fetch).
 *
 * Env (all optional — every source degrades gracefully if its key is absent):
 *   REDDIT_USER / REDDIT_FEED_TOKEN  personal RSS token from Reddit prefs
 *   IMGUR_CLIENT_ID                  imgur viral gallery
 *   GIPHY_API_KEY                    trending gifs
 *   FIRECRAWL_API_KEY                Know Your Meme
 *   ANTHROPIC_API_KEY                clustering, blurbs, glossary
 *   DRY_RUN=1                        use fixtures, no network
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOPICS, PER_TOPIC_CAP, REDDIT_GAP_MS, REDDIT_WINDOW, REDDIT_LIMIT,
  IMGUR_PAGES, GIPHY_LIMIT,
} from './sources.mjs';
import { loadMemory, saveMemory, enrich } from './llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/feed.json');
const MEM = resolve(ROOT, 'data/memory.json');
const UA = 'web:thewall:v2.0 (personal reading dashboard)';

const log = (...a) => console.log('·', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (s = '') => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');

/* ==================================================================== reddit
 * Self-serve app registration is gone (Responsible Builder Policy), so OAuth
 * is not an option for a solo project. What still works is the personal feed
 * token in your Reddit preferences. We attach it and try the JSON endpoint
 * first — it carries the pre-generated thumbnail ladder and mp4 GIF variants
 * that make this whole thing cheap to load — and fall back to parsing the RSS
 * feed, which always works but gives thinner data.
 */

function redditAuth() {
  const user = process.env.REDDIT_USER;
  const feed = process.env.REDDIT_FEED_TOKEN;
  return user && feed ? `user=${encodeURIComponent(user)}&feed=${encodeURIComponent(feed)}` : '';
}

async function grab(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    if (r.status === 429) { await sleep(REDDIT_GAP_MS); continue; }
    return r;
  }
  return null;
}

async function redditSub(sub) {
  const auth = redditAuth();
  const base = `/r/${sub}/top/?t=${REDDIT_WINDOW}&limit=${REDDIT_LIMIT}`;

  // Preferred: JSON. Richest data by far.
  const jsonUrl = `https://www.reddit.com${base.replace('/?', '.json?')}&raw_json=1${auth ? '&' + auth : ''}`;
  const rj = await grab(jsonUrl);
  if (rj?.ok) {
    try {
      const kids = (await rj.json())?.data?.children ?? [];
      if (kids.length) { log(`  r/${sub}: ${kids.length} (json)`); return kids.map((c) => fromJson(c.data)); }
    } catch { /* fall through to rss */ }
  }

  // Fallback: RSS. Always available, no auth strictly required.
  const rssUrl = `https://www.reddit.com${base}&rss=1`.replace('/?', '.rss?') + (auth ? '&' + auth : '');
  const rr = await grab(rssUrl);
  if (!rr?.ok) { console.warn(`  ! r/${sub} -> ${rr?.status ?? 'network error'}`); return []; }
  const items = fromRss(await rr.text(), sub);
  log(`  r/${sub}: ${items.length} (rss fallback)`);
  return items;
}

/** JSON path: harvest the whole thumbnail ladder + the mp4 version of any GIF. */
function fromJson(p) {
  if (p.over_18 || p.stickied || p.pinned) return null;
  const prev = p.preview?.images?.[0];
  const mp4 =
    p.preview?.reddit_video_preview?.fallback_url ||
    prev?.variants?.mp4?.source?.url ||
    p.secure_media?.reddit_video?.fallback_url ||
    p.media?.reddit_video?.fallback_url;

  let media = { kind: 'text', src: null, srcset: null, w: null, h: null, video: null };
  if (prev) {
    const ladder = (prev.resolutions || []).filter((r) => r.width >= 216)
      .map((r) => ({ url: dec(r.url), w: r.width, h: r.height }));
    const pick = ladder.find((r) => r.w >= 640) || ladder.at(-1)
      || { url: dec(prev.source.url), w: prev.source.width, h: prev.source.height };
    media = {
      kind: mp4 ? 'video' : 'image',
      src: pick.url,
      srcset: ladder.map((r) => `${r.url} ${r.w}w`).join(', ') || null,
      w: prev.source.width, h: prev.source.height,
      video: mp4 ? dec(mp4) : null,
    };
  } else if (p.thumbnail?.startsWith('http')) {
    media = { kind: 'image', src: dec(p.thumbnail), srcset: null, w: p.thumbnail_width, h: p.thumbnail_height, video: null };
  }

  const body = (p.selftext || '').slice(0, 900).trim();
  if (media.kind === 'text' && !body) return null;

  return {
    id: 'rd_' + p.id, source: 'r/' + p.subreddit,
    sourceUrl: 'https://reddit.com' + p.permalink,
    title: dec(p.title), score: p.score, comments: p.num_comments, ts: p.created_utc,
    body, blurb: null, ...media,
  };
}

/** RSS path: Atom entries. No score, no dimensions, no ladder — but it works. */
function fromRss(xml, sub) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (tag) => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    const id = (pick('id').match(/t3_(\w+)/) || [])[1];
    const link = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    // Reddit escapes HTML *inside* XML, so entities arrive double-encoded:
    // "&amp;#39;" -> "&#39;" -> "'". One pass is not enough.
    const title = dec(dec(pick('title').replace(/<!\[CDATA\[|\]\]>/g, ''))).trim();
    if (!id || !title) continue;

    const content = dec(dec(pick('content')));
    // The full-size image is linked in the entry body; the thumbnail is tiny.
    const full = (content.match(/href="(https:\/\/i\.redd\.it\/[^"]+)"/) || [])[1];
    const thumb = (content.match(/<img src="(https:\/\/[ab]\.thumbs\.redditmedia\.com\/[^"]+)"/) || [])[1];
    const src = full || thumb || null;
    const gif = src && /\.gif$/i.test(src);

    out.push({
      id: 'rd_' + id, source: 'r/' + sub, sourceUrl: link,
      title, score: null, comments: null,
      ts: Math.floor(new Date(pick('updated') || Date.now()).getTime() / 1000),
      body: '', blurb: null,
      kind: src ? (gif ? 'video' : 'image') : 'text',
      src, srcset: null, w: null, h: null,
      video: gif ? src.replace(/\.gif$/i, '.mp4') : null,
    });
  }
  return out;
}

/* ===================================================================== imgur
 * Self-serve client IDs still work. Imgur exposes a thumbnail ladder through
 * URL suffixes — i.imgur.com/{id}{size}.jpg — so we get the same bandwidth
 * trick as Reddit for free, plus native mp4 for every animated post.
 */

const IMGUR_SIZES = [['m', 320], ['l', 640], ['h', 1024]];

async function imgur() {
  const id = process.env.IMGUR_CLIENT_ID;
  if (!id) { log('imgur: skipped (no IMGUR_CLIENT_ID)'); return []; }
  const out = [];
  for (let page = 0; page < IMGUR_PAGES; page++) {
    const r = await fetch(`https://api.imgur.com/3/gallery/hot/viral/${page}.json`, {
      headers: { Authorization: `Client-ID ${id}`, 'User-Agent': UA },
    });
    if (!r.ok) { console.warn('  ! imgur ->', r.status); break; }
    const items = (await r.json())?.data || [];
    for (const it of items) {
      if (it.nsfw || it.is_album && !it.cover) continue;
      const hash = it.is_album ? it.cover : it.id;
      const w = it.is_album ? it.cover_width : it.width;
      const h = it.is_album ? it.cover_height : it.height;
      if (!hash) continue;
      const ext = it.animated ? 'jpg' : (it.type === 'image/png' ? 'png' : 'jpg');
      out.push({
        id: 'im_' + it.id, source: 'Imgur',
        sourceUrl: it.link || `https://imgur.com/gallery/${it.id}`,
        title: (it.title || '').trim(), score: it.ups ?? it.points, comments: it.comment_count,
        ts: it.datetime, body: (it.description || '').slice(0, 600), blurb: null,
        kind: it.animated ? 'video' : 'image',
        src: `https://i.imgur.com/${hash}l.${ext}`,
        srcset: IMGUR_SIZES.map(([s, px]) => `https://i.imgur.com/${hash}${s}.${ext} ${px}w`).join(', '),
        w: w || null, h: h || null,
        video: it.animated ? (it.mp4 || `https://i.imgur.com/${hash}.mp4`) : null,
      });
    }
    await sleep(400);
  }
  log(`imgur: ${out.length} items`);
  return out.filter((i) => i.title);
}

/* ===================================================================== giphy
 * Trending GIFs, already transcoded to mp4 at several widths. Free key.
 */

async function giphy() {
  const key = process.env.GIPHY_API_KEY;
  if (!key) { log('giphy: skipped (no GIPHY_API_KEY)'); return []; }
  const r = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=${GIPHY_LIMIT}&rating=pg-13`);
  if (!r.ok) { console.warn('  ! giphy ->', r.status); return []; }
  const data = (await r.json())?.data || [];
  const out = data.map((g) => {
    const still = g.images?.fixed_width_still || g.images?.['480w_still'];
    const small = g.images?.fixed_width_small_still;
    return {
      id: 'gp_' + g.id, source: 'Giphy',
      sourceUrl: g.url,
      title: (g.title || '').replace(/\s*GIF\s*$/i, '').trim() || 'Trending GIF',
      score: null, comments: null,
      ts: Math.floor(new Date(g.trending_datetime || g.import_datetime || Date.now()).getTime() / 1000),
      body: '', blurb: null,
      kind: 'video',
      src: still?.url || null,
      srcset: [small && `${small.url} ${small.width}w`, still && `${still.url} ${still.width}w`].filter(Boolean).join(', ') || null,
      w: Number(still?.width) || null, h: Number(still?.height) || null,
      video: g.images?.fixed_width?.mp4 || g.images?.original_mp4?.mp4 || null,
    };
  }).filter((g) => g.src && g.video);
  log(`giphy: ${out.length} items`);
  return out;
}

/* =============================================================== hackernews */

async function hackerNews(limit = 20) {
  const ids = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
  const items = await Promise.all(ids.slice(0, limit).map((id) =>
    fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)));
  const out = items.filter(Boolean).map((it) => ({
    id: 'hn_' + it.id, source: 'Hacker News',
    sourceUrl: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
    title: it.title, score: it.score, comments: it.descendants || 0, ts: it.time,
    body: '', blurb: null, kind: 'text', src: null, srcset: null, w: null, h: null, video: null,
  }));
  log(`hn: ${out.length} items`);
  return out;
}

/* ========================================================== know your meme */

async function knowYourMeme() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) { log('kym: skipped (no FIRECRAWL_API_KEY)'); return []; }
  try {
    const r = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://knowyourmeme.com/memes/popular',
        onlyMainContent: true,
        formats: [{
          type: 'json',
          schema: {
            type: 'object',
            properties: {
              memes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' },
                    image: { type: 'string' },
                    summary: { type: 'string', description: 'one or two sentences on what this meme is and where it came from' },
                  },
                  required: ['title', 'url'],
                },
              },
            },
          },
        }],
      }),
    });
    const memes = (await r.json())?.data?.json?.memes || [];
    log(`kym: ${memes.length} entries`);
    return memes.slice(0, 18).map((m, i) => ({
      id: 'kym_' + i + '_' + Buffer.from(String(m.url)).toString('base64url').slice(0, 8),
      source: 'Know Your Meme', sourceUrl: m.url, title: m.title,
      score: null, comments: null, ts: Math.floor(Date.now() / 1000),
      body: m.summary || '', blurb: null,
      kind: m.image ? 'image' : 'text',
      src: m.image || null, srcset: null, w: null, h: null, video: null,
    }));
  } catch (e) {
    console.warn('  ! kym failed:', e.message);
    return [];
  }
}

/* ====================================================================== main */

async function main() {
  if (process.env.DRY_RUN) return dryRun();

  const auth = redditAuth();
  log(auth ? 'reddit: using personal feed token' : 'reddit: anonymous (expect heavy throttling)');

  const all = [];
  let firstReddit = true;

  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const bucket = [];

    for (const sub of cfg.reddit || []) {
      if (!firstReddit) await sleep(REDDIT_GAP_MS);   // ~1 req/min ceiling
      firstReddit = false;
      bucket.push(...(await redditSub(sub)).filter(Boolean));
    }

    if (cfg.imgur) bucket.push(...(await imgur()));
    if (cfg.giphy) bucket.push(...(await giphy()));
    if (cfg.hn) bucket.push(...(await hackerNews()));
    if (cfg.kym) bucket.push(...(await knowYourMeme()));

    for (const it of bucket) it.topic = topic;
    bucket.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    log(`${topic}: ${bucket.length} items`);
    all.push(...bucket.slice(0, PER_TOPIC_CAP));
  }

  // Drop anything that slipped through twice, then interleave topics so the
  // wall looks varied before the user filters anything.
  const seen = new Set();
  const unique = all.filter((i) => !seen.has(i.id) && seen.add(i.id));

  const byTopic = {};
  for (const it of unique) (byTopic[it.topic] ||= []).push(it);
  const woven = [];
  for (let i = 0; ; i++) {
    const row = Object.values(byTopic).map((l) => l[i]).filter(Boolean);
    if (!row.length) break;
    woven.push(...row);
  }

  if (!woven.length) { console.error('No items fetched — refusing to overwrite feed.json'); process.exit(1); }

  const memory = await loadMemory(MEM);
  const { clusters, glossary } = await enrich(woven, memory);
  await saveMemory(MEM, memory);
  await write(woven, { clusters, glossary });
}

async function write(items, extra = {}) {
  await mkdir(dirname(OUT), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    topics: Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, { label: v.label, emoji: v.emoji }])),
    clusters: extra.clusters || [],
    glossary: extra.glossary || {},
    count: items.length,
    items,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
  log(`wrote data/feed.json — ${items.length} items, ${payload.clusters.length} clusters, ${kb} KB`);
}

async function dryRun() {
  log('DRY_RUN: using fixtures');
  const fx = JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.json'), 'utf8'));
  const seed = JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.clusters.json'), 'utf8'));
  const memory = await loadMemory(MEM);
  const { clusters, glossary } = await enrich(fx, memory);   // no-ops without an API key
  await saveMemory(MEM, memory);
  await write(fx, {
    clusters: clusters.length ? clusters : seed.clusters,
    glossary: Object.keys(glossary).length ? glossary : seed.glossary,
  });
}

// NO_MAIN lets scripts/test.mjs import the parsers without kicking off a build.
if (!process.env.NO_MAIN) main().catch((e) => { console.error(e); process.exit(1); });

export { fromRss, fromJson, imgur, giphy };
