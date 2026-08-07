/**
 * Free context enrichment. No API keys, no model, no cost.
 *
 * The best explanation of why something is funny or what actually happened is
 * usually already written by a human in the comments. This pulls the top one
 * for Lemmy and Hacker News posts and attaches it to the item, so the expanded
 * panel has real content even with every LLM switched off.
 *
 * Wikipedia extracts and Know Your Meme summaries already arrive as `body`
 * from their own sources, so nothing extra is needed for those.
 */

import { LEMMY_HOST } from './sources.mjs';

const UA = 'thewall/3.0 (personal reading dashboard)';
const log = (...a) => console.log('  ctx ·', ...a);

// How many posts per source get a comment lookup. Each is one cheap request.
export const COMMENT_BUDGET = { lemmy: 14, hn: 10 };
const MAX_LEN = 320;
const MIN_LEN = 25;

const get = (u) => fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });

/** Strip HTML/markdown down to readable plain text. */
export function clean(s = '') {
  return String(s)
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/^>+\s*/gm, '')                 // quoted replies
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links/images
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is this comment worth showing? */
export function usable(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < MIN_LEN) return false;
  if (/^(\[deleted\]|\[removed\]|deleted by creator)/i.test(t)) return false;
  // A wall of pure punctuation/emoji says nothing.
  if (!/[a-z]{3}/i.test(t)) return false;
  return true;
}

export const truncate = (s) =>
  s.length <= MAX_LEN ? s : s.slice(0, MAX_LEN - 1).replace(/\s+\S*$/, '') + '…';

/* ------------------------------------------------------------------ lemmy */

export async function lemmyTopComment(postId) {
  const url = `${LEMMY_HOST}/api/v3/comment/list`
    + `?post_id=${postId}&sort=Top&limit=5&max_depth=1&type_=All`;
  try {
    const r = await get(url);
    if (!r.ok) return null;
    const list = (await r.json())?.comments || [];
    for (const c of list) {
      if (c.comment?.deleted || c.comment?.removed) continue;
      const text = truncate(clean(c.comment?.content));
      if (usable(text)) return { text, by: c.creator?.name || null, score: c.counts?.score ?? null };
    }
  } catch { /* free extra — never fail the build over it */ }
  return null;
}

/* ------------------------------------------------------------- hackernews */

export async function hnTopComment(itemId) {
  try {
    const r = await get(`https://hacker-news.firebaseio.com/v0/item/${itemId}.json`);
    if (!r.ok) return null;
    const kids = (await r.json())?.kids || [];
    for (const kid of kids.slice(0, 3)) {          // already rank-ordered
      const c = await (await get(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`)).json();
      if (!c || c.deleted || c.dead) continue;
      const text = truncate(clean(c.text));
      if (usable(text)) return { text, by: c.by || null, score: null };
    }
  } catch { /* ignore */ }
  return null;
}

/* ------------------------------------------------------------- orchestrate */

/** Run promises with bounded concurrency so we don't hammer either host. */
async function pool(jobs, size = 5) {
  const out = [];
  for (let i = 0; i < jobs.length; i += size) {
    out.push(...await Promise.all(jobs.slice(i, i + size).map((j) => j())));
  }
  return out;
}

/**
 * Attach `comment` / `commentBy` to the highest-scoring items that have
 * discussion behind them. Mutates in place.
 */
export async function addComments(items) {
  const pick = (prefix, n) => items
    .filter((i) => i.id.startsWith(prefix) && (i.comments ?? 0) >= 3)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, n);

  const lemmyItems = pick('lm_', COMMENT_BUDGET.lemmy);
  const hnItems = pick('hn_', COMMENT_BUDGET.hn);

  const jobs = [
    ...lemmyItems.map((it) => async () => {
      const c = await lemmyTopComment(it.id.slice(3));
      if (c) { it.comment = c.text; it.commentBy = c.by; it.commentScore = c.score; }
      return !!c;
    }),
    ...hnItems.map((it) => async () => {
      const c = await hnTopComment(it.id.slice(3));
      if (c) { it.comment = c.text; it.commentBy = c.by; }
      return !!c;
    }),
  ];

  const got = (await pool(jobs)).filter(Boolean).length;
  log(`top comments: ${got}/${jobs.length} fetched (free)`);

  const withContext = items.filter((i) => i.body || i.comment).length;
  log(`${withContext}/${items.length} items now have human-written context`);
  return items;
}
