/* The Wall — static client. No build step, no framework, no deps. */

const $ = (s) => document.querySelector(s);
const wall = $('#wall'), chips = $('#chips'), stamp = $('#stamp');
const LS = {
  topics: 'wall.topics',
  saver: 'wall.saver',
  seen: 'wall.lastSeen',
  pat: 'wall.pat', // optional GitHub token for the "force rebuild" action
};

let FEED = { items: [], topics: {}, clusters: [], glossary: {} };
let selected = new Set(JSON.parse(localStorage.getItem(LS.topics) || '[]'));
let activeThread = null;
let saver = localStorage.getItem(LS.saver) === '1';
let cursor = 0;
const PAGE = 24; // render in chunks — never build 200 DOM nodes at once

/* -------------------------------------------------- load (stale-while-revalidate) */

const BUILD = 'wall-2026-08-07d';

async function load({ bust = false } = {}) {
  console.log('[wall] client', BUILD);

  // 1. Paint instantly from the last payload we saw. This MUST be guarded:
  //    a cached payload in an older shape used to throw here, outside the
  //    try below, which rejected the promise and left the spinner up forever.
  let cached = sessionStorage.getItem('wall.feed');
  if (cached && !bust) {
    try { apply(JSON.parse(cached), { silent: true }); }
    catch (e) {
      console.warn('[wall] discarding unusable cached feed:', e);
      sessionStorage.removeItem('wall.feed');
      cached = null;
    }
  }
  if (!cached || bust) { $('#splash').hidden = false; cycleSplash(); }

  // 2. Then go get the real thing.
  const url = new URL('./data/feed.json' + (bust ? `?t=${Date.now()}` : ''), location.href).href;
  try {
    const r = await fetch(url, { cache: bust ? 'reload' : 'default' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);

    const text = await r.text();
    // A missing file on Pages returns the 404 *page*, not a 404 status, when a
    // custom 404 exists — so check we actually got JSON before trusting it.
    if (text.trimStart().startsWith('<')) throw new Error('got HTML, not JSON — data/feed.json is missing');

    const j = JSON.parse(text);
    if (!Array.isArray(j.items)) throw new Error('feed.json has no items array');

    sessionStorage.setItem('wall.feed', JSON.stringify(j));
    apply(j);
  } catch (e) {
    if (!cached) return fail(e, url);
    console.warn('feed refresh failed, showing cached copy:', e);
  }
  stopSplash();
  $('#splash').hidden = true;
}

// Nothing may fail silently. Any uncaught error or rejection anywhere in the
// app surfaces on screen rather than leaving the spinner running.
addEventListener('error', (e) => fail(e.error || new Error(e.message), location.href));
addEventListener('unhandledrejection', (e) => fail(e.reason || new Error('unhandled rejection'), location.href));

/** Show the real reason instead of spinning forever. */
function fail(err, url) {
  stopSplash();
  $('#splash').hidden = false;
  $('#splash').querySelector('.orb').style.display = 'none';
  $('#splashMsg').textContent = "Couldn't load the feed";
  $('#splash').querySelector('.sub').innerHTML =
    `<code>${esc(String(err.message || err))}</code><br><br>
     Tried: <code>${esc(url)}</code><br><br>
     Open that URL directly. If it 404s, the build hasn't committed
     <code>data/feed.json</code> yet — check the Actions tab.`;
  console.error('[wall] feed load failed:', err, url);
}

function apply(j, { silent } = {}) {
  FEED = j;
  const age = j.generatedAt ? relTime(new Date(j.generatedAt)) : '';
  stamp.textContent = age ? `updated ${age}` : '';
  drawChips();
  drawThreads();
  reset();
  if (!silent) topUpLive();
}

/* ---------------------------------------------------------------- threads */
/* Clusters the build step found — "here is the one story behind these six posts". */

function drawThreads() {
  const rail = $('#threads');
  const list = (FEED.clusters || []).filter((c) => {
    if (!selected.size) return true;
    return FEED.items.some((i) => i.cluster === c.id && selected.has(i.topic));
  });
  rail.hidden = !list.length;
  rail.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.className = 'thread';
    b.setAttribute('aria-pressed', String(activeThread === c.id));
    b.innerHTML = `<span class="k">Thread · ${c.count} posts</span>
      <span class="l">${esc(c.label)}</span>
      ${c.why ? `<span class="w">${esc(c.why)}</span>` : ''}`;
    b.onclick = () => { activeThread = activeThread === c.id ? null : c.id; drawThreads(); reset(); };
    rail.appendChild(b);
  }
}

/* ------------------------------------------------------------------ chips */

function drawChips() {
  const t = FEED.topics || {};
  const counts = {};
  for (const it of FEED.items) counts[it.topic] = (counts[it.topic] || 0) + 1;

  chips.innerHTML = '';
  const mk = (key, label, n, arch) => {
    const b = document.createElement('button');
    b.className = 'chip' + (arch ? ' arc' : '');
    b.setAttribute('aria-pressed', key === '*' ? selected.size === 0 : selected.has(key));
    b.innerHTML = `${label}${n != null ? `<span class="n">${n}</span>` : ''}`;
    b.onclick = () => {
      if (key === '*') selected.clear();
      else selected.has(key) ? selected.delete(key) : selected.add(key);
      activeThread = null;
      localStorage.setItem(LS.topics, JSON.stringify([...selected]));
      drawChips(); drawThreads(); reset();
    };
    chips.appendChild(b);
  };
  const live = Object.entries(t).filter(([, v]) => !v.archive);
  const arch = Object.entries(t).filter(([, v]) => v.archive);

  mk('*', 'Everything', FEED.items.filter((i) => !isArchive(i.topic)).length);
  for (const [k, v] of live) mk(k, `${v.emoji || ''} ${v.label}`.trim(), counts[k] || 0);
  for (const [k, v] of arch) mk(k, `${v.emoji || ''} ${v.label}`.trim(), counts[k] || 0, true);
}

/* ----------------------------------------------------------------- render */

const isArchive = (topic) => !!FEED.topics?.[topic]?.archive;

function visible() {
  let l = FEED.items;
  if (selected.size) {
    l = l.filter((i) => selected.has(i.topic));
  } else {
    // "Everything" means everything *current*. The archive holds hundreds of
    // evergreen items and would swamp today's wall — it's opt-in per tab.
    l = l.filter((i) => !isArchive(i.topic));
  }
  if (activeThread) l = l.filter((i) => i.cluster === activeThread);
  return l;
}

function reset() {
  wall.innerHTML = ''; cursor = 0;
  const list = visible();
  $('#empty').hidden = list.length > 0;
  const terms = Object.keys(FEED.glossary || {}).length;
  $('#foot').innerHTML = list.length
    ? `<b>${list.length}</b> things you missed${terms ? ` &nbsp;·&nbsp; <b>${terms}</b> formats explained from memory` : ''}`
    : '';
  more();
}

function more() {
  const list = visible();
  const slice = list.slice(cursor, cursor + PAGE);
  const frag = document.createDocumentFragment();
  slice.forEach((it, n) => frag.appendChild(tile(it, n)));
  wall.appendChild(frag);
  cursor += slice.length;
  if (cursor < list.length) sentinel();
}

let sentinelEl;
function sentinel() {
  sentinelEl?.remove();
  sentinelEl = document.createElement('div');
  sentinelEl.style.cssText = 'height:1px;grid-column:1/-1';
  wall.appendChild(sentinelEl);
  const io = new IntersectionObserver((es) => {
    if (es[0].isIntersecting) { io.disconnect(); sentinelEl.remove(); more(); }
  }, { rootMargin: '1200px' });
  io.observe(sentinelEl);
}

function tile(it, n) {
  const el = document.createElement('article');
  el.className = 'tile' + (it.kind === 'text' ? ' text' : '');
  el.style.animationDelay = Math.min(n * 18, 320) + 'ms';
  el.tabIndex = 0;

  let media = '';
  if (it.kind !== 'text' && it.src) {
    // Reserve exact space up front -> no layout shift, no jank on scroll.
    const ar = it.w && it.h ? (it.w / it.h).toFixed(4) : '1';
    media = `<div class="media" style="aspect-ratio:${ar}">
      ${it.kind === 'video' ? '<span class="badge gif">GIF</span>' : ''}
      <img alt="" loading="lazy" decoding="async" fetchpriority="${n < 4 ? 'high' : 'low'}"
           src="${esc(it.src)}" ${it.srcset ? `srcset="${esc(it.srcset)}" sizes="(min-width:1000px) 24vw, 46vw"` : ''}>
    </div>`;
  }

  const thread = !activeThread && it.cluster
    ? (FEED.clusters || []).find((c) => c.id === it.cluster) : null;

  el.innerHTML = `${media}
    <div class="body">
      ${thread ? `<span class="thchip">${esc(thread.label)}</span>` : ''}
      <p class="ttl">${esc(it.title)}</p>
      ${it.blurb ? `<p class="blurb">${esc(it.blurb)}</p>` : ''}
      <div class="meta">
        <span class="src">${esc(it.source)}</span>
        ${it.score != null ? `<span class="sep">·</span><span>${kfmt(it.score)}</span>` : ''}
        ${it.comments ? `<span class="sep">·</span><span>${kfmt(it.comments)} 💬</span>` : ''}
      </div>
      ${(it.body || it.blurb || it.comment || it.terms?.length) ? '<span class="more">What is this? →</span>' : ''}
    </div>`;

  const img = el.querySelector('img');
  if (img) {
    const box = img.parentElement;
    img.addEventListener('load', () => { img.classList.add('in'); box.classList.add('done'); }, { once: true });
    img.addEventListener('error', () => { box.remove(); el.classList.add('text'); }, { once: true });
    if (img.complete) img.dispatchEvent(new Event('load'));
    if (it.kind === 'video' && it.video && !saver) attachVideo(el, box, it);
  }

  el.onclick = () => openSheet(it);
  el.onkeydown = (e) => { if (e.key === 'Enter') openSheet(it); };
  return el;
}

/**
 * Animation plays where you're looking, and nowhere else.
 *
 * A single observer plays the mp4 for tiles that are properly on screen and
 * pauses everything else, so you never have to click through to see what a
 * GIF actually does. Bandwidth stays sane because only visible tiles ever
 * fetch a video, and data saver turns the whole thing off.
 */
const PLAY_LIMIT = 6;   // most browsers stall past ~8 concurrent videos
const playing = new Set();

const playObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (e.isIntersecting && e.intersectionRatio > 0.55) startVideo(el);
    else stopVideo(el);
  }
}, { threshold: [0, 0.55, 1], rootMargin: '-8% 0px -8% 0px' });

function startVideo(el) {
  if (saver || el._v || playing.size >= PLAY_LIMIT) return;
  const { box, item } = el._media || {};
  if (!item?.video) return;

  const v = document.createElement('video');
  Object.assign(v, { src: item.video, muted: true, loop: true, playsInline: true, preload: 'auto', autoplay: true });
  v.setAttribute('aria-hidden', 'true');
  v.style.cssText = 'position:absolute;inset:0;opacity:0;transition:opacity .3s var(--ease,ease)';
  v.addEventListener('playing', () => { v.style.opacity = '1'; el.classList.add('is-playing'); }, { once: true });
  box.appendChild(v);
  v.play().catch(() => {});      // autoplay can still be refused; the still stays
  el._v = v;
  playing.add(el);
}

function stopVideo(el) {
  if (!el._v) return;
  el._v.pause();
  el._v.remove();
  el._v = null;
  el.classList.remove('is-playing');
  playing.delete(el);
}

function attachVideo(el, box, it) {
  el._media = { box, item: it };
  playObserver.observe(el);
  // Desktop hover still forces playback even if the tile is only half visible.
  el.addEventListener('pointerenter', () => startVideo(el));
}

/* ------------------------------------------------------------------ sheet */

const sheet = $('#sheet');
$('#sheetClose').onclick = () => sheet.close();
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

/* Browse without closing: ← → , swipe, or the on-screen arrows. */
let sheetIndex = -1;

function step(delta) {
  const list = visible();
  const next = sheetIndex + delta;
  if (next < 0 || next >= list.length) return;
  openSheet(list[next], next);
}

addEventListener('keydown', (e) => {
  if (!sheet.open) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
});

let touchX = null;
sheet.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
sheet.addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
}, { passive: true });

function openSheet(it, index) {
  const list = visible();
  sheetIndex = index ?? list.indexOf(it);
  const thread = (FEED.clusters || []).find((c) => c.id === it.cluster);

  // Glossary entries the build has learned. A format seen many times has a
  // better explanation than one seen once — that's the memory paying off.
  const terms = (it.terms || []).map((k) => FEED.glossary?.[k]).filter(Boolean);
  const glossHtml = terms.length ? `
    <div class="gloss">
      <h3>You may need to know</h3>
      ${terms.map((g) => `<div class="gterm">
        <span class="kind">${esc(g.kind || 'format')}</span>
        <b>${esc(g.name)}</b>
        <p>${esc(g.what)}</p>
        ${g.seen > 2 ? `<div class="seen">Seen ${g.seen} times on your wall</div>` : ''}
      </div>`).join('')}
    </div>` : '';

  $('#sheetBody').innerHTML = `
    ${thread ? `<span class="thchip">${esc(thread.label)}</span>` : ''}
    <h2>${esc(it.title)}</h2>
    ${thread?.why ? `<p class="blurb">${esc(thread.why)}</p>` : ''}
    <div class="meta"><span class="src">${esc(it.source)}</span>
      ${it.score != null ? `<span class="sep">·</span><span>${kfmt(it.score)} points</span>` : ''}
      ${it.ts ? `<span class="sep">·</span><span>${relTime(new Date(it.ts * 1000))}</span>` : ''}
    </div>
    ${it.kind === 'video' && it.video
      ? `<video src="${esc(it.video)}" autoplay muted loop playsinline controls></video>`
      : it.src ? `<img src="${esc(it.srcFull || it.src)}" alt="" loading="eager">` : ''}
    ${(it.body || it.blurb) ? `<p class="ctx">${esc(it.body || it.blurb)}</p>` : ''}
    ${it.comment ? `<figure class="says">
      <blockquote>${esc(it.comment)}</blockquote>
      <figcaption>top comment${it.commentBy ? ` · ${esc(it.commentBy)}` : ''}</figcaption>
    </figure>` : ''}
    ${glossHtml}
    ${it.tags?.length ? `<div class="tags">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <a class="go" href="${esc(it.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`;

  // Navigation lives outside the scrolling body so it stays put.
  let nav = sheet.querySelector('.nav');
  if (!nav) {
    nav = document.createElement('nav');   // not a <div>: `.sheet > div` is the card
    nav.className = 'nav';
    nav.innerHTML = `<button data-d="-1" aria-label="Previous">‹</button>
                     <span class="pos"></span>
                     <button data-d="1" aria-label="Next">›</button>`;
    nav.onclick = (e) => { const b = e.target.closest('button'); if (b) step(+b.dataset.d); };
    sheet.appendChild(nav);
  }
  nav.querySelector('.pos').textContent = `${sheetIndex + 1} / ${list.length}`;
  nav.querySelector('[data-d="-1"]').disabled = sheetIndex <= 0;
  nav.querySelector('[data-d="1"]').disabled = sheetIndex >= list.length - 1;

  if (!sheet.open) sheet.showModal();
  sheet.querySelector('div').scrollTop = 0;
}

/* --------------------------------------------------- live top-up + refresh */

/**
 * The cached feed is the base. This adds anything that broke in the last
 * few minutes from a CORS-friendly, key-free endpoint. Costs nothing.
 */
async function topUpLive() {
  try {
    const ids = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
    const have = new Set(FEED.items.map((i) => i.id));
    const fresh = ids.slice(0, 12).map((id) => 'hn_' + id).filter((id) => !have.has(id));
    if (!fresh.length) return;
    const got = await Promise.all(fresh.slice(0, 8).map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id.slice(3)}.json`).then((r) => r.json()).catch(() => null)));
    const add = got.filter(Boolean).map((it) => ({
      id: 'hn_' + it.id, topic: 'tech', source: 'Hacker News · live',
      sourceUrl: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      title: it.title, score: it.score, comments: it.descendants || 0, ts: it.time,
      body: '', blurb: null, kind: 'text', src: null, srcset: null, w: null, h: null, video: null,
    }));
    if (!add.length) return;
    FEED.items = [...add, ...FEED.items];
    drawChips(); reset();
  } catch {}
}

$('#refresh').onclick = async (e) => {
  const b = e.currentTarget;
  b.classList.add('spin');
  await load({ bust: true });
  await forceRebuild();      // no-op unless you've saved a token
  b.classList.remove('spin');
};

/**
 * Optional: trigger the GitHub Action from the page.
 * The token lives in YOUR browser's localStorage only — never in the repo.
 * Set it once from devtools:  localStorage.setItem('wall.pat','github_pat_...')
 * Use a fine-grained PAT scoped to this repo with Actions: read+write.
 */
async function forceRebuild() {
  const pat = localStorage.getItem(LS.pat);
  const repo = document.location.hostname.split('.')[0] + '/' + (location.pathname.split('/')[1] || '');
  if (!pat || !repo.includes('/')) return;
  try {
    await fetch(`https://api.github.com/repos/${repo}/actions/workflows/refresh.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    stamp.textContent = 'rebuilding… check back in ~2 min';
  } catch {}
}

/* ------------------------------------------------------------ data saver */

const saverBtn = $('#saver');
const syncSaver = () => saverBtn.setAttribute('aria-pressed', String(saver));
saverBtn.onclick = () => {
  saver = !saver;
  localStorage.setItem(LS.saver, saver ? '1' : '0');
  syncSaver(); reset();
};
// Respect the OS/browser data-saver hint on first visit.
if (localStorage.getItem(LS.saver) === null && navigator.connection?.saveData) saver = true;
syncSaver();

/* ------------------------------------------------------------------ utils */

function esc(s = '') { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function kfmt(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
function relTime(d) {
  const s = (Date.now() - d) / 1000;
  const u = [[60, 'sec'], [3600, 'min'], [86400, 'hr'], [604800, 'day']];
  if (s < 60) return 'just now';
  for (let i = 1; i < u.length; i++) if (s < u[i][0]) return Math.floor(s / u[i - 1][0]) + ' ' + u[i][1] + 's ago';
  return Math.floor(s / 86400) + ' days ago';
}

const MSGS = ['Gathering the internet…', 'Reading the group chats…', 'Sorting jokes from news…', 'Almost there…'];
let splashTimer, splashGuard;

function cycleSplash() {
  stopSplash();
  let i = 0;
  splashTimer = setInterval(() => {
    if ($('#splash').hidden) return stopSplash();
    $('#splashMsg').textContent = MSGS[++i % MSGS.length];
  }, 2200);
  // Never spin forever. If the fetch hasn't resolved in 15s, something is wrong.
  splashGuard = setTimeout(() => {
    if (!$('#splash').hidden) fail(new Error('timed out after 15s'), './data/feed.json');
  }, 15000);
}

function stopSplash() {
  clearInterval(splashTimer);
  clearTimeout(splashGuard);
}

load();
