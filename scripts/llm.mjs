/**
 * The LLM layer: clustering, context blurbs, and a glossary that grows over time.
 * Entirely optional — without a key the wall still shows the human-written
 * context that context.mjs gathers for free.
 *
 * Two calls per build:
 *   Pass 1 — cluster the new items into story threads + write per-item blurbs,
 *            and flag which known glossary terms apply.
 *   Pass 2 — teach the glossary: define anything new that showed up, and
 *            refine definitions for terms that keep recurring.
 *
 * Everything the model has already explained is cached in data/memory.json, so
 * the marginal cost of a build drops as the file learns. A meme format that
 * showed up last week costs zero tokens to explain this week.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Provider selection. Groq's free tier is the default: no credit card, 30
 * requests/minute, and this build uses ~5k tokens against a six-figure daily
 * allowance. Anthropic is used only if you explicitly supply that key instead.
 * With neither, everything still works — items keep the human-written context
 * from context.mjs, they just don't get clusters or a glossary.
 */
function provider() {
  if (process.env.GROQ_API_KEY) return {
    name: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    key: process.env.GROQ_API_KEY,
  };
  if (process.env.ANTHROPIC_API_KEY) return {
    name: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    key: process.env.ANTHROPIC_API_KEY,
  };
  return null;
}

const DAY = 86400e3;
const MAX_ANNOTATED = 900;     // rolling cache of already-explained post ids
const MAX_GLOSSARY = 300;      // hard cap so memory.json stays small
const ANNOTATION_TTL = 14;     // days
const GLOSSARY_TTL = 35;       // days without a sighting before a one-off is dropped

const log = (...a) => console.log('  llm ·', ...a);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ memory */

export const EMPTY_MEMORY = { version: 1, updatedAt: null, glossary: {}, annotated: {} };

export async function loadMemory(path) {
  try {
    const m = JSON.parse(await readFile(path, 'utf8'));
    return { ...EMPTY_MEMORY, ...m };
  } catch {
    log('no memory file yet — starting fresh');
    return structuredClone(EMPTY_MEMORY);
  }
}

export async function saveMemory(path, mem) {
  mem.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(mem, null, 1));
  const kb = (Buffer.byteLength(JSON.stringify(mem)) / 1024).toFixed(1);
  log(`memory: ${Object.keys(mem.glossary).length} glossary entries, ${Object.keys(mem.annotated).length} cached, ${kb} KB`);
}

/** Forget one-offs; keep anything that keeps coming back. */
function prune(mem) {
  const now = Date.now();
  let dropped = 0;

  for (const [k, v] of Object.entries(mem.annotated)) {
    if (now - new Date(v.at || 0).getTime() > ANNOTATION_TTL * DAY) { delete mem.annotated[k]; dropped++; }
  }
  const ann = Object.entries(mem.annotated);
  if (ann.length > MAX_ANNOTATED) {
    ann.sort((a, b) => new Date(a[1].at || 0) - new Date(b[1].at || 0));
    for (const [k] of ann.slice(0, ann.length - MAX_ANNOTATED)) delete mem.annotated[k];
  }

  for (const [k, v] of Object.entries(mem.glossary)) {
    const stale = now - new Date(v.last || 0).getTime() > GLOSSARY_TTL * DAY;
    if (stale && (v.seen || 0) < 3) { delete mem.glossary[k]; dropped++; }
  }
  const gl = Object.entries(mem.glossary);
  if (gl.length > MAX_GLOSSARY) {
    // Keep the most-seen, then the most-recent.
    gl.sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0) || new Date(b[1].last) - new Date(a[1].last));
    for (const [k] of gl.slice(MAX_GLOSSARY)) delete mem.glossary[k];
  }
  if (dropped) log(`pruned ${dropped} stale entries`);
}

/* --------------------------------------------------------------- transport */

/** One request, either provider, same return shape. */
async function ask(p, prompt, maxTokens) {
  const isGroq = p.name === 'groq';

  const headers = isGroq
    ? { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' }
    : { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

  const body = isGroq
    ? {
        model: p.model, max_tokens: maxTokens, temperature: 0.3,
        // JSON mode removes the "here is your JSON:" preamble entirely.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You reply with a single valid JSON object and nothing else.' },
          { role: 'user', content: prompt },
        ],
      }
    : { model: p.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };

  const r = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p.name} ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();

  const text = isGroq ? (j.choices?.[0]?.message?.content || '') : (j.content?.[0]?.text || '');
  const usage = isGroq
    ? { input_tokens: j.usage?.prompt_tokens, output_tokens: j.usage?.completion_tokens }
    : (j.usage || {});
  return { text, usage };
}

function parseJson(text, fallback) {
  try {
    const a = text.indexOf('{'), b = text.indexOf('[');
    const start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.warn('  ! could not parse model output:', e.message);
    return fallback;
  }
}

/* ------------------------------------------------------ pass 1: understand */

async function passCluster(p, fresh, mem) {
  const known = Object.entries(mem.glossary)
    .sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0))
    .slice(0, 90)
    .map(([k, v]) => `${k}: ${v.name}`)
    .join('\n');

  const lines = fresh.map((it, i) => `${i}|${it.source}|${it.title.slice(0, 120)}`).join('\n');

  const prompt =
`You curate a personal dashboard for someone who has deliberately stopped using social media but wants to stay culturally literate. They are smart and do not need things dumbed down; they just have no idea what is currently going around.

Below are today's trending posts as "index|source|title".

${known ? `You already have a glossary of recurring formats, people and running jokes. Reference these by key when one applies:\n${known}\n` : ''}
Do three things.

1. CLUSTER. Group posts that are about the same underlying story, event, or joke format into threads. Only make a cluster when 2+ posts genuinely belong together — do not force it. Most posts will be unclustered, and that is fine. Give each cluster a short human label (3-6 words) and one sentence on why it is happening right now.

2. ANNOTATE. For each post, write one sentence (max 22 words) explaining what it is or why it is being shared. Be specific and additive. If the title fully explains itself and you have nothing to add, use an empty string rather than restating it. Never write "this post shows" or "users are reacting to". Add 1-3 lowercase tags.

3. LINK. If a post relies on a glossary term listed above, put that key in "g". If a post relies on a recurring format, person, or running joke that is NOT in the glossary and looks like it will recur, invent a kebab-case key and put it in "n" so it can be defined later.

Reply with ONLY this JSON, no prose:
{"clusters":[{"id":"kebab-case","label":"...","why":"..."}],
 "items":[{"i":0,"b":"blurb","t":["tag"],"c":"cluster-id-or-null","g":["known-key"],"n":["new-key"]}]}

${lines}`;

  const { text, usage } = await ask(p, prompt, 6000);
  log(`pass 1: in≈${usage.input_tokens} out≈${usage.output_tokens}`);
  return parseJson(text, { clusters: [], items: [] });
}

/* ---------------------------------------------------------- pass 2: learn */

async function passLearn(p, newKeys, mem, contextByKey) {
  if (!newKeys.length) { log('pass 2: skipped (nothing new to define)'); return {}; }

  const asks = newKeys.slice(0, 25).map((k) => {
    const existing = mem.glossary[k];
    const ex = (contextByKey[k] || []).slice(0, 3).map((t) => `   e.g. "${t.slice(0, 90)}"`).join('\n');
    return `${k}${existing ? ` (existing: "${existing.what}" — refine only if today's examples show you had it wrong or incomplete)` : ' (NEW)'}\n${ex}`;
  }).join('\n\n');

  const prompt =
`You maintain a small glossary of internet culture for someone who does not use social media. Define the following terms based on the example posts shown, plus what you already know about them.

For each: give a display name, a "what" of 1-2 sentences covering what it is AND where it came from, and a kind from: format (a meme template or joke structure), person (a creator, public figure or account), event (a specific thing that happened), joke (a recurring bit or catchphrase), community (a subculture or fandom).

If you do not actually know what something is, set "what" to "" rather than guessing — a wrong explanation is worse than none.

Reply with ONLY JSON: {"key":{"name":"...","what":"...","kind":"format"}, ...}

${asks}`;

  const { text, usage } = await ask(p, prompt, 3000);
  log(`pass 2: in≈${usage.input_tokens} out≈${usage.output_tokens}`);
  return parseJson(text, {});
}

/* -------------------------------------------------------------- orchestrate */

export async function enrich(items, mem) {
  const p = provider();
  const stamp = new Date().toISOString();

  // 1. Reuse anything we've already explained. This is the main cost control:
  //    a repost, or a build that runs 4h after the last one, is nearly free.
  const fresh = [];
  let reused = 0;
  for (const it of items) {
    const c = mem.annotated[it.id];
    if (c) {
      it.blurb = c.b || null; it.tags = c.t || []; it.cluster = c.c || null; it.terms = c.g || [];
      reused++;
    } else fresh.push(it);
  }
  log(`${reused} reused from memory, ${fresh.length} new`);

  if (!p) { log('skipped (no GROQ_API_KEY or ANTHROPIC_API_KEY) — items keep their free source context'); prune(mem); return { clusters: [], glossary: {} }; }
  log(`using ${p.name} (${p.model})`);
  if (!fresh.length) { prune(mem); return { clusters: [], glossary: refGlossary(items, mem) }; }

  let clusters = [];
  const newKeys = new Set();
  const contextByKey = {};

  try {
    const r = await passCluster(p, fresh, mem);
    clusters = (r.clusters || []).map((c) => ({ id: slug(c.id || c.label), label: c.label, why: c.why || '' }));
    const valid = new Set(clusters.map((c) => c.id));

    for (const row of r.items || []) {
      const it = fresh[row.i];
      if (!it) continue;
      it.blurb = (row.b || '').trim() || null;
      it.tags = (row.t || []).slice(0, 3);
      it.cluster = row.c && valid.has(slug(row.c)) ? slug(row.c) : null;
      it.terms = [...(row.g || []), ...(row.n || [])].map(slug).filter(Boolean).slice(0, 3);

      for (const k of row.n || []) { newKeys.add(slug(k)); }
      for (const k of it.terms) (contextByKey[k] ||= []).push(it.title);
    }
  } catch (e) {
    console.warn('  ! pass 1 failed, continuing without clusters/blurbs:', e.message);
  }

  // Also refresh definitions for known terms seen many times but never refined.
  for (const [k, v] of Object.entries(mem.glossary)) {
    if (contextByKey[k] && !v.what) newKeys.add(k);
  }

  try {
    const defs = await passLearn(p, [...newKeys], mem, contextByKey);
    for (const [k, d] of Object.entries(defs)) {
      const key2 = slug(k);
      const prev = mem.glossary[key2];
      mem.glossary[key2] = {
        name: d.name || prev?.name || key2,
        what: (d.what || prev?.what || '').trim(),
        kind: d.kind || prev?.kind || 'format',
        seen: prev?.seen || 0,
        first: prev?.first || today(),
        last: today(),
      };
    }
  } catch (e) {
    console.warn('  ! pass 2 failed, glossary not updated:', e.message);
  }

  // Bump sighting counts for every term referenced this run.
  const bumped = new Set();
  for (const it of items) for (const k of it.terms || []) {
    if (bumped.has(k)) continue;
    bumped.add(k);
    const g = (mem.glossary[k] ||= { name: k, what: '', kind: 'format', seen: 0, first: today() });
    g.seen = (g.seen || 0) + 1;
    g.last = today();
  }

  // Cache the annotations so the next build doesn't pay for them again.
  for (const it of fresh) {
    mem.annotated[it.id] = { b: it.blurb, t: it.tags, c: it.cluster, g: it.terms, at: stamp };
  }

  prune(mem);

  const counted = clusters
    .map((c) => ({ ...c, count: items.filter((i) => i.cluster === c.id).length }))
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count);

  log(`${counted.length} clusters, ${bumped.size} terms referenced`);
  return { clusters: counted, glossary: refGlossary(items, mem) };
}

/** Only ship glossary entries the feed actually references — keeps feed.json small. */
function refGlossary(items, mem) {
  const out = {};
  for (const it of items) for (const k of it.terms || []) {
    const g = mem.glossary[k];
    if (g?.what) out[k] = { name: g.name, what: g.what, kind: g.kind, seen: g.seen };
  }
  return out;
}
