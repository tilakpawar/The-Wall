#!/usr/bin/env node
/**
 * Builds data/feed.json — the static payload GitHub Pages serves.
 * Zero npm dependencies. Node 20+ (needs global fetch).
 *
 * Env (all optional except where noted):
 *   REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET  -> use OAuth (STRONGLY recommended from CI)
 *   FIRECRAWL_API_KEY                        -> enables Know Your Meme scrape
 *   ANTHROPIC_API_KEY                        -> enables the single batched context call
 *   DRY_RUN=1                                -> use fixtures, no network
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS, PER_TOPIC_CAP, REDDIT_WINDOW, REDDIT_LIMIT } from './sources.mjs';
import { loadMemory, saveMemory, enrich } from './llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/feed.json');
const MEM = resolve(ROOT, 'data/memory.json');
const UA = 'web:memewall:v1.0 (personal dashboard)';

const log = (...a) => console.log('·', ...a);
const dec = (s = '') => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

/* ---------------------------------------------------------------- reddit */

let redditToken = null;
async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (redditToken) return redditToken;
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials&scope=read',
  });
  if (!r.ok) { console.warn('  ! reddit oauth failed', r.status); return null; }
  redditToken = (await r.json()).access_token;
  log('reddit: authed via oauth');
  return redditToken;
}

async function redditListing(sub) {
  const token = await getRedditToken();
  const path = `/r/${sub}/top?t=${REDDIT_WINDOW}&limit=${REDDIT_LIMIT}&raw_json=1`;
  const url = token ? `https://oauth.reddit.com${path}` : `https://www.reddit.com${path}`;
  const headers = { 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) return (await r.json())?.data?.children ?? [];
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    console.warn(`  ! r/${sub} -> ${r.status}`);
    return [];
  }
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The data-saving core: pull Reddit's PRE-GENERATED thumbnail ladder instead of
 * the full-size image, and prefer the mp4 variant of any GIF (5-20x smaller).
 */
function mediaFromPost(p) {
  const prev = p.preview?.images?.[0];
  const out = { kind: 'text', srcset: null, src: null, w: null, h: null, video: null };

  // Animated: always prefer mp4 over gif.
  const mp4 =
    p.preview?.reddit_video_preview?.fallback_url ||
    prev?.variants?.mp4?.source?.url ||
    p.secure_media?.reddit_video?.fallback_url ||
    p.media?.reddit_video?.fallback_url;

  if (prev) {
    const ladder = (prev.resolutions || [])
      .filter((r) => r.width >= 216)
      .map((r) => ({ url: dec(r.url), w: r.width, h: r.height }));
    const pick = ladder.find((r) => r.width >= 640) || ladder[ladder.length - 1] || {
      url: dec(prev.source.url), w: prev.source.width, h: prev.source.height,
    };
    out.src = pick.url;
    out.w = prev.source.width;
    out.h = prev.source.height;
    // srcset lets the browser download only what the column width needs.
    out.srcset = ladder.map((r) => `${r.url} ${r.w}w`).join(', ') || null;
    out.kind = mp4 ? 'video' : 'image';
    if (mp4) out.video = dec(mp4);
  }

  if (out.kind === 'text' && p.thumbnail?.startsWith('http')) {
    out.src = dec(p.thumbnail);
    out.w = p.thumbnail_width; out.h = p.thumbnail_height;
    out.kind = 'image';
  }
  return out;
}

function normalizeReddit(child, topic) {
  const p = child.data;
  if (p.over_18 || p.stickied || p.pinned) return null;
  const m = mediaFromPost(p);
  const body = (p.selftext || '').slice(0, 900).trim();
  if (m.kind === 'text' && !body) return null;

  return {
    id: 'rd_' + p.id,
    topic,
    source: 'r/' + p.subreddit,
    sourceUrl: 'https://reddit.com' + p.permalink,
    title: dec(p.title),
    score: p.score,
    comments: p.num_comments,
    ts: p.created_utc,
    body,                     // full context, shown on tap
    blurb: null,              // filled by the batched LLM pass
    ...m,
  };
}

/* -------------------------------------------------------------- hackernews */
// Firebase API: no key, no rate limit, CORS-enabled (so the browser can top-up live).

async function hackerNews(limit = 20) {
  const ids = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
  const items = await Promise.all(
    ids.slice(0, limit).map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)
    )
  );
  return items.filter(Boolean).map((it) => ({
    id: 'hn_' + it.id,
    topic: 'tech',
    source: 'Hacker News',
    sourceUrl: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
    title: it.title,
    score: it.score,
    comments: it.descendants || 0,
    ts: it.time,
    body: '',
    blurb: null,
    kind: 'text', src: null, srcset: null, w: null, h: null, video: null,
  }));
}

/* ------------------------------------------------------ know your meme */
// No public API -> this is where Firecrawl earns its keep. One scrape per run.

async function knowYourMeme() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) { log('kym: skipped (no FIRECRAWL_API_KEY)'); return []; }
  try {
    const r = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://knowyourmeme.com/memes/popular',
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
        onlyMainContent: true,
      }),
    });
    const j = await r.json();
    const memes = j?.data?.json?.memes || [];
    log(`kym: ${memes.length} entries`);
    return memes.slice(0, 18).map((m, i) => ({
      id: 'kym_' + i + '_' + Buffer.from(m.url).toString('base64url').slice(0, 8),
      topic: 'origins',
      source: 'Know Your Meme',
      sourceUrl: m.url,
      title: m.title,
      score: null, comments: null, ts: Math.floor(Date.now() / 1000),
      body: m.summary || '',
      blurb: null,
      kind: m.image ? 'image' : 'text',
      src: m.image || null, srcset: null, w: null, h: null, video: null,
    }));
  } catch (e) {
    console.warn('  ! kym failed:', e.message);
    return [];
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  if (process.env.DRY_RUN) return dryRun();

  const all = [];

  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const bucket = [];
    for (const sub of cfg.reddit || []) {
      const children = await redditListing(sub);
      bucket.push(...children.map((c) => normalizeReddit(c, topic)).filter(Boolean));
      await sleep(600); // be polite
    }
    if (cfg.hn) bucket.push(...(await hackerNews()));
    if (cfg.kym) bucket.push(...(await knowYourMeme()));

    bucket.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    log(`${topic}: ${bucket.length} items`);
    all.push(...bucket.slice(0, PER_TOPIC_CAP));
  }

  // Interleave topics so the wall looks varied before any filtering.
  const byTopic = {};
  for (const it of all) (byTopic[it.topic] ||= []).push(it);
  const woven = [];
  for (let i = 0; ; i++) {
    const row = Object.values(byTopic).map((l) => l[i]).filter(Boolean);
    if (!row.length) break;
    woven.push(...row);
  }

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
  log(`wrote ${OUT} — ${items.length} items, ${payload.clusters.length} clusters, ${kb} KB`);
}

async function dryRun() {
  const fx = JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.json'), 'utf8'));
  log('DRY_RUN: using fixtures');
  const memory = await loadMemory(MEM);
  const { clusters, glossary } = await enrich(fx, memory);   // no-ops without an API key
  await saveMemory(MEM, memory);
  await write(fx, {
    clusters: clusters.length ? clusters : JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.clusters.json'), 'utf8')).clusters,
    glossary: Object.keys(glossary).length ? glossary : JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures.clusters.json'), 'utf8')).glossary,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
