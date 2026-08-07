#!/usr/bin/env node
/**
 * Builds data/feed.json — the static payload GitHub Pages serves.
 * Zero npm dependencies. Node 20+ (needs global fetch).
 *
 * Every source degrades independently: a missing key logs a skip, a failure
 * logs a warning, and the build only aborts if NOTHING was fetched.
 *
 * Env (all optional):
 *   IMGUR_CLIENT_ID     imgur viral gallery      (free self-serve key)
 *   GIPHY_API_KEY       trending gifs            (free self-serve key)
 *   ANTHROPIC_API_KEY   clusters, blurbs, glossary
 *   REDDIT_USER / REDDIT_FEED_TOKEN   only works from a residential IP
 *   DRY_RUN=1           use fixtures, no network
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOPICS, PER_TOPIC_CAP,
  LEMMY_HOST, LEMMY_SORT, LEMMY_LIMIT, LEMMY_GAP_MS,
  IMGUR_PAGES, GIPHY_LIMIT, BLUESKY_FEED, BLUESKY_LIMIT,
  REDDIT_GAP_MS, REDDIT_WINDOW, REDDIT_LIMIT,
} from './sources.mjs';
import { loadMemory, saveMemory, enrich } from './llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/feed.json');
const MEM = resolve(ROOT, 'data/memory.json');
const UA = 'thewall/3.0 (personal reading dashboard; +https://github.com/)';

const log = (...a) => console.log('·', ...a);
const warn = (...a) => console.warn('  !', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (s = '') => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

const get = (url, headers = {}) => fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers } });

/** Stable short id from an arbitrary string (djb2). */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Every item in the feed has exactly this shape. */
const item = (o) => ({
  id: o.id, source: o.source, sourceUrl: o.sourceUrl, title: o.title,
  score: o.score ?? null, comments: o.comments ?? null, ts: o.ts || Math.floor(Date.now() / 1000),
  body: (o.body || '').slice(0, 900), blurb: null,
  kind: o.kind || 'text', src: o.src || null, srcset: o.srcset || null,
  w: o.w || null, h: o.h || null, video: o.video || null,
});

/* ===================================================================== lemmy
 * The Reddit replacement. Fully open API, no key, no IP blocking, and images
 * are served by pict-rs which resizes on demand via ?thumbnail= — so we keep
 * the same bandwidth trick: request only the width the column needs.
 */

const PICT_RUNGS = [320, 640, 1024];

function pictSrcset(url) {
  if (!url || !url.includes('/pictrs/image/')) return null;
  return PICT_RUNGS.map((w) => `${url}?thumbnail=${w}&format=webp ${w}w`).join(', ');
}

async function lemmy(community) {
  const url = `${LEMMY_HOST}/api/v3/post/list`
    + `?community_name=${encodeURIComponent(community)}`
    + `&sort=${LEMMY_SORT}&limit=${LEMMY_LIMIT}&type_=All`;
  let posts;
  try {
    const r = await get(url);
    if (!r.ok) { warn(`${community} -> ${r.status}`); return []; }
    posts = (await r.json())?.posts || [];
  } catch (e) { warn(`${community} failed:`, e.message); return []; }

  const out = [];
  for (const p of posts) {
    const post = p.post;
    if (!post || post.nsfw || post.deleted || post.removed) continue;

    const det = p.image_details || {};
    const thumb = post.thumbnail_url || det.link || null;
    const target = post.url || '';
    const isGif = /\.gif($|\?)/i.test(target) || det.content_type === 'image/gif';
    const isVid = /\.(mp4|webm)($|\?)/i.test(target);
    const hasImg = !!thumb;

    if (!hasImg && !post.body) continue;   // nothing to show

    out.push(item({
      id: 'lm_' + post.id,
      source: 'c/' + (p.community?.name || community.split('@')[0]),
      sourceUrl: post.ap_id || `${LEMMY_HOST}/post/${post.id}`,
      title: post.name,
      score: p.counts?.score,
      comments: p.counts?.comments,
      ts: Math.floor(new Date(post.published).getTime() / 1000),
      body: post.body || '',
      kind: hasImg ? (isGif || isVid ? 'video' : 'image') : 'text',
      src: thumb ? `${thumb}?thumbnail=640&format=webp` : null,
      srcset: pictSrcset(thumb),
      w: det.width || null,
      h: det.height || null,
      video: isVid ? target : (isGif ? target : null),
    }));
  }
  log(`  ${community}: ${out.length}`);
  return out;
}

/* ============================================================ know your meme
 * Public RSS. No key, no Firecrawl, no scraping.
 */

async function knowYourMeme() {
  try {
    const r = await get('https://knowyourmeme.com/newsfeed.rss');
    if (!r.ok) { warn(`kym -> ${r.status}`); return []; }
    const out = parseRss(await r.text(), 'Know Your Meme', 'kym_');
    log(`kym: ${out.length} items`);
    return out.slice(0, 20);
  } catch (e) { warn('kym failed:', e.message); return []; }
}

/** Generic RSS 2.0 parser — title, link, description, pubDate, first <img>. */
function parseRss(xml, sourceName, prefix) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const e = m[1];
    const pick = (tag) => {
      const r = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return r ? r[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
    };
    const title = dec(pick('title'));
    const link = dec(pick('link'));
    if (!title || !link) continue;

    const desc = dec(pick('description'));
    const img = (desc.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || null;
    const text = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const date = Date.parse(pick('pubDate'));

    out.push(item({
      // Hash the WHOLE url — slicing an encoded prefix collides, because every
      // entry from one site shares the same leading path.
      id: prefix + hash(link),
      source: sourceName, sourceUrl: link, title,
      ts: Number.isFinite(date) ? Math.floor(date / 1000) : undefined,
      body: text,
      kind: img ? 'image' : 'text',
      src: img,
    }));
  }
  return out;
}

/* ================================================================= wikipedia
 * "Most read yesterday" is a startlingly good proxy for what the internet is
 * collectively reacting to — and every entry comes with a written explanation.
 */

async function wikipedia() {
  const d = new Date(Date.now() - 36e5 * 30);           // yesterday, UTC-safe
  const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  try {
    const r = await get(`https://en.wikipedia.org/api/rest_v1/feed/featured/${path}`);
    if (!r.ok) { warn(`wikipedia -> ${r.status}`); return []; }
    const arts = (await r.json())?.mostread?.articles || [];
    const out = arts
      .filter((a) => a.type !== 'disambiguation' && !/^(Main_Page|Special:|Wikipedia:)/.test(a.titles?.canonical || ''))
      .slice(0, 14)
      .map((a) => item({
        id: 'wk_' + (a.titles?.canonical || a.title),
        source: 'Most read on Wikipedia',
        sourceUrl: a.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${a.titles?.canonical}`,
        title: (a.titles?.normalized || a.title || '').replace(/_/g, ' '),
        score: a.views,
        body: a.extract || '',
        kind: a.thumbnail?.source ? 'image' : 'text',
        src: a.thumbnail?.source || null,
        w: a.thumbnail?.width, h: a.thumbnail?.height,
      }));
    log(`wikipedia: ${out.length} items`);
    return out;
  } catch (e) { warn('wikipedia failed:', e.message); return []; }
}

/* =================================================================== bluesky
 * The "What's Hot" feed via the public AppView. No auth, no key.
 */

async function bluesky() {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed`
    + `?feed=${encodeURIComponent(BLUESKY_FEED)}&limit=${BLUESKY_LIMIT}`;
  try {
    const r = await get(url);
    if (!r.ok) { warn(`bluesky -> ${r.status}`); return []; }
    const feed = (await r.json())?.feed || [];
    const out = [];
    for (const entry of feed) {
      const p = entry.post;
      const text = (p?.record?.text || '').trim();
      if (!text || p?.record?.reply) continue;

      const img = p.embed?.images?.[0] || p.embed?.media?.images?.[0];
      const ar = img?.aspectRatio;
      out.push(item({
        id: 'bs_' + (p.cid || p.uri).slice(-16),
        source: '@' + (p.author?.handle || 'bluesky'),
        sourceUrl: `https://bsky.app/profile/${p.author?.handle}/post/${String(p.uri).split('/').pop()}`,
        title: text.length > 200 ? text.slice(0, 197) + '…' : text,
        score: p.likeCount, comments: p.replyCount,
        ts: Math.floor(new Date(p.indexedAt || Date.now()).getTime() / 1000),
        kind: img ? 'image' : 'text',
        src: img?.thumb || null,
        srcset: img ? [img.thumb && `${img.thumb} 320w`, img.fullsize && `${img.fullsize} 1000w`].filter(Boolean).join(', ') : null,
        w: ar?.width, h: ar?.height,
      }));
    }
    log(`bluesky: ${out.length} items`);
    return out;
  } catch (e) { warn('bluesky failed:', e.message); return []; }
}

/* ===================================================================== imgur */

const IMGUR_SIZES = [['m', 320], ['l', 640], ['h', 1024]];

async function imgur() {
  const id = process.env.IMGUR_CLIENT_ID;
  if (!id) { log('imgur: skipped (no IMGUR_CLIENT_ID)'); return []; }
  const out = [];
  for (let page = 0; page < IMGUR_PAGES; page++) {
    let items;
    try {
      const r = await get(`https://api.imgur.com/3/gallery/hot/viral/${page}.json`, { Authorization: `Client-ID ${id}` });
      if (!r.ok) { warn(`imgur -> ${r.status}`); break; }
      items = (await r.json())?.data || [];
    } catch (e) { warn('imgur failed:', e.message); break; }

    for (const it of items) {
      if (it.nsfw || (it.is_album && !it.cover)) continue;
      const hash = it.is_album ? it.cover : it.id;
      if (!hash || !it.title) continue;
      const ext = it.type === 'image/png' ? 'png' : 'jpg';
      out.push(item({
        id: 'im_' + it.id, source: 'Imgur',
        sourceUrl: it.link || `https://imgur.com/gallery/${it.id}`,
        title: it.title.trim(), score: it.ups ?? it.points, comments: it.comment_count,
        ts: it.datetime, body: it.description || '',
        kind: it.animated ? 'video' : 'image',
        src: `https://i.imgur.com/${hash}l.${ext}`,
        srcset: IMGUR_SIZES.map(([s, px]) => `https://i.imgur.com/${hash}${s}.${ext} ${px}w`).join(', '),
        w: it.is_album ? it.cover_width : it.width,
        h: it.is_album ? it.cover_height : it.height,
        video: it.animated ? (it.mp4 || `https://i.imgur.com/${hash}.mp4`) : null,
      }));
    }
    await sleep(400);
  }
  log(`imgur: ${out.length} items`);
  return out;
}

/* ===================================================================== giphy */

async function giphy() {
  const key = process.env.GIPHY_API_KEY;
  if (!key) { log('giphy: skipped (no GIPHY_API_KEY)'); return []; }
  try {
    const r = await get(`https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=${GIPHY_LIMIT}&rating=pg-13`);
    if (!r.ok) { warn(`giphy -> ${r.status}`); return []; }
    const data = (await r.json())?.data || [];
    const out = data.map((g) => {
      const i = g.images || {};
      // Use a 480px rung as the display size — 200px looks soft on a desktop wall.
      const still = i.downsized_still || i['480w_still'] || i.fixed_width_still;
      const small = i.fixed_width_small_still;
      const mp4 = i.downsized_small?.mp4 || i.fixed_width?.mp4 || i.original_mp4?.mp4;
      return item({
        id: 'gp_' + g.id, source: 'Giphy', sourceUrl: g.url,
        title: (g.title || '').replace(/\s*GIF\s*(by .+)?$/i, '').trim() || 'Trending GIF',
        ts: Math.floor(new Date(g.trending_datetime || g.import_datetime || Date.now()).getTime() / 1000) || undefined,
        kind: 'video',
        src: still?.url || null,
        srcset: [small && `${small.url} ${small.width}w`, still?.width && `${still.url} ${still.width}w`].filter(Boolean).join(', ') || null,
        w: Number(still?.width) || null, h: Number(still?.height) || null,
        video: mp4 || null,
      });
    }).filter((g) => g.src && g.video);
    log(`giphy: ${out.length} items`);
    return out;
  } catch (e) { warn('giphy failed:', e.message); return []; }
}

/* =============================================================== hackernews */

async function hackerNews(limit = 20) {
  try {
    const ids = await (await get('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
    const raw = await Promise.all(ids.slice(0, limit).map((id) =>
      get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)));
    const out = raw.filter(Boolean).map((it) => item({
      id: 'hn_' + it.id, source: 'Hacker News',
      sourceUrl: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      title: it.title, score: it.score, comments: it.descendants || 0, ts: it.time,
    }));
    log(`hn: ${out.length} items`);
    return out;
  } catch (e) { warn('hn failed:', e.message); return []; }
}

/* ==================================================================== reddit
 * Kept for local runs only — 403s from every datacenter IP.
 */

async function redditSub(sub) {
  const user = process.env.REDDIT_USER, tok = process.env.REDDIT_FEED_TOKEN;
  const auth = user && tok ? `&user=${encodeURIComponent(user)}&feed=${encodeURIComponent(tok)}` : '';
  try {
    const r = await get(`https://www.reddit.com/r/${sub}/top.json?t=${REDDIT_WINDOW}&limit=${REDDIT_LIMIT}&raw_json=1${auth}`);
    if (!r.ok) { warn(`r/${sub} -> ${r.status}${r.status === 403 ? ' (datacenter IP blocked — expected in CI)' : ''}`); return []; }
    const kids = (await r.json())?.data?.children ?? [];
    const out = kids.map((c) => fromRedditJson(c.data)).filter(Boolean);
    log(`  r/${sub}: ${out.length}`);
    return out;
  } catch (e) { warn(`r/${sub} failed:`, e.message); return []; }
}

function fromRedditJson(p) {
  if (!p || p.over_18 || p.stickied) return null;
  const prev = p.preview?.images?.[0];
  const mp4 = p.preview?.reddit_video_preview?.fallback_url || prev?.variants?.mp4?.source?.url;
  let media = { kind: 'text' };
  if (prev) {
    const ladder = (prev.resolutions || []).filter((r) => r.width >= 216)
      .map((r) => ({ url: dec(r.url), w: r.width }));
    const pick = ladder.find((r) => r.w >= 640) || ladder.at(-1) || { url: dec(prev.source.url) };
    media = {
      kind: mp4 ? 'video' : 'image', src: pick.url,
      srcset: ladder.map((r) => `${r.url} ${r.w}w`).join(', ') || null,
      w: prev.source.width, h: prev.source.height, video: mp4 ? dec(mp4) : null,
    };
  }
  if (media.kind === 'text' && !p.selftext) return null;
  return item({
    id: 'rd_' + p.id, source: 'r/' + p.subreddit,
    sourceUrl: 'https://reddit.com' + p.permalink, title: dec(p.title),
    score: p.score, comments: p.num_comments, ts: p.created_utc, body: p.selftext || '',
    ...media,
  });
}

/* ====================================================================== main */

async function main() {
  if (process.env.DRY_RUN) return dryRun();
  const all = [];

  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const bucket = [];

    for (const c of cfg.lemmy || []) { bucket.push(...(await lemmy(c))); await sleep(LEMMY_GAP_MS); }
    for (const s of cfg.reddit || []) { bucket.push(...(await redditSub(s))); await sleep(REDDIT_GAP_MS); }
    if (cfg.imgur) bucket.push(...(await imgur()));
    if (cfg.giphy) bucket.push(...(await giphy()));
    if (cfg.kym) bucket.push(...(await knowYourMeme()));
    if (cfg.wikipedia) bucket.push(...(await wikipedia()));
    if (cfg.bluesky) bucket.push(...(await bluesky()));
    if (cfg.hn) bucket.push(...(await hackerNews()));

    for (const it of bucket) it.topic = topic;
    bucket.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    log(`${topic}: ${bucket.length} items`);
    all.push(...bucket.slice(0, PER_TOPIC_CAP));
  }

  const seen = new Set();
  const unique = all.filter((i) => !seen.has(i.id) && seen.add(i.id));

  // Interleave topics so the wall looks varied before any filtering.
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
    clusters: extra.clusters || [], glossary: extra.glossary || {},
    count: items.length, items,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
  const withImg = items.filter((i) => i.src).length;
  log(`wrote data/feed.json — ${items.length} items (${withImg} with images), ${payload.clusters.length} clusters, ${kb} KB`);
}

async function dryRun() {
  log('DRY_RUN: using fixtures');
  const fx = JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.json'), 'utf8'));
  const seed = JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.clusters.json'), 'utf8'));
  const memory = await loadMemory(MEM);
  const { clusters, glossary } = await enrich(fx, memory);
  await saveMemory(MEM, memory);
  await write(fx, {
    clusters: clusters.length ? clusters : seed.clusters,
    glossary: Object.keys(glossary).length ? glossary : seed.glossary,
  });
}

if (!process.env.NO_MAIN) main().catch((e) => { console.error(e); process.exit(1); });

export { lemmy, parseRss, wikipedia, bluesky, imgur, giphy, fromRedditJson, pictSrcset };
