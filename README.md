# The Wall

A static, GitHub Pages–hosted wall of what's trending — memes, meme origins, viral stories, tech discourse — so you don't have to open the apps.

No framework, no build step, no npm dependencies. A GitHub Action refreshes the content on a schedule; the page itself is three files.

---

## How it actually works

```
GitHub Action (cron, every 4h)          GitHub Pages (static)
  ├─ Reddit OAuth API  ──┐
  ├─ Hacker News API   ──┤                index.html
  ├─ Know Your Meme    ──┼─► feed.json ─► assets/app.js ─► the wall
  │    (via Firecrawl)   │      (~120 KB)      │
  └─ 1× Haiku call     ──┘                     └─ live top-up: HN API direct
       (adds context blurbs)
```

**Why this shape.** GitHub Pages serves static files only — there is no server to hide an API key in. So all keyed work happens inside the Action, where secrets are safe, and the browser only ever downloads a plain JSON file. Consequences: the page loads in well under a second, costs nothing per view, and works offline-ish from cache.

The **refresh button** re-fetches `feed.json` (cache-busted) and picks up new Hacker News items live. Optionally it can also trigger a full rebuild — see *Force rebuild* below.

---

## Sources

| Source | Cost | Key | Gives you |
|---|---|---|---|
| **Reddit** `oauth.reddit.com/r/{sub}/top` | free | free OAuth app | Memes, GIFs, stories — **plus pre-generated thumbnails at 5 widths and mp4 versions of every GIF** |
| **Hacker News** Firebase API | free | none | Tech discourse. No rate limit, CORS-enabled, so the browser can call it directly |
| **Know Your Meme** `/memes/popular` | Firecrawl credits | Firecrawl | *Why* a format is everywhere — origin + explanation |
| **r/OutOfTheLoop** | free | (Reddit) | Literally a subreddit of people asking "what happened" and getting answered |

Instagram and X have no usable public API and aggressively block scrapers. Almost everything that trends there is reposted to Reddit within hours, which is why Reddit is the spine of this. Reddit is also the only one of these that hands you a thumbnail ladder for free — that's worth more than the extra sources.

Edit `scripts/sources.mjs` to change topics or subreddits. Nothing else needs touching.

---

## Setup (about 10 minutes)

**1. Push this to a repo.** Settings → Pages → Source: *Deploy from a branch*, `main` / root.

**2. Reddit credentials (do not skip).**
The public `reddit.com/....json` endpoint works from your laptop but Reddit blocks datacenter IPs, so it fails from GitHub Actions runners. Get free OAuth creds instead:

- <https://www.reddit.com/prefs/apps> → *create another app* → type **script** → redirect URI `http://localhost`
- The string under the app name is your client ID; the `secret` field is the secret.
- Repo → Settings → Secrets and variables → Actions → add `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`.

**3. Optional secrets.**

- `FIRECRAWL_API_KEY` — enables the Know Your Meme tile source. Skip it and everything else still works.
- `ANTHROPIC_API_KEY` — enables the one-line "what is this" blurbs.

**4. Run it once.** Actions tab → *Refresh feed* → *Run workflow*. It commits `data/feed.json`. Open your Pages URL.

**Local dev:** `DRY_RUN=1 node scripts/build-feed.mjs` builds from fixtures, then `npx serve .`

---

## The LLM layer (`scripts/llm.mjs`)

Two Haiku calls per build, and a memory file that makes each build cheaper than the last.

**Pass 1 — understand.** Sends the new items as `index|source|title`, plus the *names* of glossary terms it already knows. Gets back three things: story clusters, a one-sentence blurb per item, and — the important bit — which glossary terms each post depends on, including kebab-case keys it invented for things it has never seen before.

**Pass 2 — learn.** Takes only the terms flagged as new, along with 2-3 example titles each, and writes proper definitions: what it is, where it came from, what kind of thing it is (format / person / event / joke / community). These go into `data/memory.json`, which the bot commits alongside the feed.

**Why this gets cheaper over time.** Every annotation is cached by post ID, so a build 4 hours after the last one only pays for genuinely new posts. And every meme format the glossary already knows costs zero tokens to explain again — it's just a dictionary lookup. The first week is the expensive week.

**What it forgets.** A term seen once and never again is dropped after 35 days; annotations expire after 14. Terms that keep recurring are kept and their `seen` count grows, which is also what drives the "Seen 14 times on your wall" line in the detail sheet. `memory.json` is capped at 300 glossary entries and stays a few tens of KB — it's committed to the repo, so you can read it, edit a definition by hand, or delete a bad one.

Prompts live at the bottom of `llm.mjs` and are worth tuning to your taste. The one instruction doing the most work is *"if the title fully explains itself, return an empty string rather than restating it"* — without it you get a wall of blurbs that say nothing.

### Cost

| | Per run | Per month (6 runs/day) |
|---|---|---|
| Pass 1 | ~5k in / ~3k out | |
| Pass 2 | ~1.5k in / ~1k out (often skipped) | |
| **Claude Haiku total** | under a cent | **roughly $1–3** |
| GitHub Actions | ~50s | free tier (public repo = unlimited) |
| Firecrawl | 1 scrape | ~180 credits/mo — inside the free tier |

Titles only. Never image data, never post bodies, never URLs. Output is compact JSON, not prose.

**Don't run a local model for this.** Not because quality is insufficient — the job is easy — but because it would run on your machine while you wait, whereas this runs on GitHub's machine while you sleep. Latency isn't the constraint; *who is waiting* is.

**Zero-LLM mode:** don't set `ANTHROPIC_API_KEY`. You lose clusters, blurbs, and the glossary; tiles still render, and Know Your Meme summaries still carry context. Every LLM step is individually wrapped so a failed call degrades the feed rather than failing the build.

---

## The data-usage tricks (the social-media playbook)

These are the actual techniques, and why each one matters:

1. **Never fetch the full-size image.** Reddit pre-renders every upload at 108/216/320/640/960/1080 px and hands you the whole ladder in the API response. The builder harvests it into a `srcset`, and `sizes="(min-width:1000px) 24vw, 46vw"` lets the browser pick the smallest one that fits its column. On a phone you download the 320px version of a 4 MB image. This alone is the difference between a 40 MB page and a 3 MB page.

2. **GIFs are never GIFs.** Every animated Reddit post also exists as an mp4 (`preview.reddit_video_preview.fallback_url`) at roughly 5–20× smaller. The wall shows a still frame; the mp4 is fetched **only on hover or tap**. Scrolling past a hundred GIF tiles costs you a hundred small JPEGs, not a hundred videos.

3. **Reserve the space before the pixels arrive.** Each tile ships `width`/`height` from the API and sets `aspect-ratio` on an empty box. Nothing on the page ever jumps as images load — no cumulative layout shift, no reflow storms while you scroll. This is the single biggest contributor to *feeling* fast.

4. **Render in chunks, not all at once.** 24 tiles at a time; an `IntersectionObserver` sentinel 1200px below the fold appends the next batch. The DOM stays small even with 200 items in memory.

5. **`loading="lazy"` + `decoding="async"` + `fetchpriority`.** The first four tiles get `high`; everything else gets `low` so the browser doesn't fight itself over bandwidth above the fold.

6. **Stale-while-revalidate.** The last `feed.json` is kept in `sessionStorage` and painted instantly on load, then quietly replaced when the network copy arrives. Reopening the tab feels like nothing loaded at all.

7. **Preconnect + preload.** TLS handshakes with `preview.redd.it` start before the JSON has even parsed, and `feed.json` is preloaded from the HTML.

8. **CSS columns for masonry.** True non-uniform tiling with zero JavaScript layout work — no measure/position pass, no thrash on resize.

9. **Data saver toggle** (top-right). Suppresses all video loading. It defaults on if `navigator.connection.saveData` is set by the OS.

Result: a cold load is a ~120 KB JSON file plus whatever thumbnails are actually on screen. Roughly 1–2 MB for a full first screen, versus the 15–30 MB a social feed spends on the same content.

---

## Force rebuild from the page (optional)

The refresh button can also kick off the Action. This needs a token, and a token must never live in the repo — so it lives only in your own browser:

1. Create a **fine-grained PAT** scoped to this repo only, permission *Actions: Read and write*.
2. Open the page → devtools console → `localStorage.setItem('wall.pat','github_pat_...')`

Refresh now dispatches `refresh.yml` and the new feed lands ~2 minutes later. Anyone else visiting your page has no token, so the button just re-fetches the JSON. If this feels like more risk than it's worth, skip it — the 4-hour cron is genuinely enough for content that isn't time-sensitive.

---

## Files

```
index.html                    markup + preconnect hints
assets/style.css              the whole design system
assets/app.js                 rendering, threads, filtering, lazy media, refresh
scripts/sources.mjs           ← edit this to change topics/subreddits
scripts/build-feed.mjs        the fetcher (no dependencies)
scripts/llm.mjs               ← clustering, blurbs, glossary memory + prompts
scripts/fixtures*.json        sample data for DRY_RUN=1
.github/workflows/refresh.yml the cron
data/feed.json                generated output (committed by the bot)
data/memory.json              the glossary that grows over time (committed)
```

## Notes

- The tile grid, chips, sheet, and filtering are verified working against the fixture data; all rendered text is HTML-escaped.
- If Reddit starts returning 403s, it's almost always the OAuth secrets — the builder falls back to the public endpoint and logs a warning rather than failing the run.
- `data/feed.json` currently holds fixture data so the page renders before your first real build.
