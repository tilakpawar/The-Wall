# The Wall

A static, GitHub Pages–hosted wall of what's trending — memes, meme origins, viral stories, tech discourse — so you don't have to open the apps.

No framework, no build step, no npm dependencies. A GitHub Action refreshes the content on a schedule; the page itself is three files.

---

## How it actually works

```
GitHub Action (cron, every 4h)              GitHub Pages
  ├─ Lemmy (memes, viral, tech) ─┐
  ├─ Know Your Meme RSS         ─┤
  ├─ Wikipedia most-read        ─┼─► _site/ ─► uploaded as an artifact ─► the wall
  ├─ Bluesky What's Hot         ─┤   (html + css + js + feed.json)
  ├─ Hacker News                ─┤
  ├─ Imgur + Giphy              ─┤
  └─ 2× Haiku calls             ─┘
       clusters, blurbs, glossary
              │
              └─► memory.json ──► force-pushed to the `state` branch
                                   (always exactly one commit)
```

**Why this shape.** GitHub Pages serves static files only — there is no server to hide an API key in. So all keyed work happens inside the Action, where secrets are safe, and the browser only ever downloads a plain JSON file. The page loads in well under a second and costs nothing per view.

**Nothing generated is committed to `main`.** The site is uploaded straight to Pages as a build artifact, so `feed.json` never enters git. The only state that must survive between builds is the glossary, and that lives on an orphan `state` branch that gets force-pushed to a single commit each time. Net effect: repo size stays flat forever, the commit log stays readable, and `git pull` never conflicts on generated files.

The **refresh button** re-fetches `feed.json` (cache-busted) and picks up new Hacker News items live. Optionally it can also trigger a full rebuild — see *Force rebuild* below.

---

## Sources

| Source | Key | Gives you |
|---|---|---|
| **Lemmy** `/api/v3/post/list` | none | The Reddit replacement. Real memes with exact image dimensions, and pict-rs resizes on demand via `?thumbnail=` — so the bandwidth trick survives intact |
| **Know Your Meme** `/newsfeed.rss` | none | *Why* a format is everywhere — origin + explanation |
| **Wikipedia** most-read | none | What everyone suddenly looked up yesterday, each with a written explanation. A shockingly good "what happened" signal |
| **Bluesky** What's Hot | none | The closest thing to an X timeline with a public API |
| **Hacker News** Firebase | none | Tech discourse. No rate limit, CORS-enabled, so the browser can top up live |
| **Imgur** viral gallery | free client ID | Memes and GIFs, with its own thumbnail ladder via URL suffixes |
| **Giphy** trending | free API key | GIFs already transcoded to mp4 at several widths |

Five of the seven need no account at all. Nothing here blocks datacenter IPs.

### Why Reddit isn't in that list

It 403s **every** request from GitHub's IP ranges, on both `.json` and `.rss`, regardless of credentials. And you can't route around it with an API key: under the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) "approval is required" before API access, and `/prefs/apps` now fails silently when you click *create app* — no error, the captcha just resets. Solo-developer requests are reportedly rejected at a high rate. Don't spend an evening on it.

The fetcher still contains a working Reddit path, because a **residential** IP is fine. If you ever run the build from your own machine, add a `reddit: ['memes', ...]` array to any topic in `sources.mjs` and set `REDDIT_USER` / `REDDIT_FEED_TOKEN` from <https://www.reddit.com/prefs/feeds/>. Leave it empty for CI. Note the ~1 request/minute throttle: `REDDIT_GAP_MS` defaults to 65s, so each subreddit adds a minute to the build.

Instagram and X have no usable public API and block scrapers aggressively. Bluesky is the practical substitute, and most visual content resurfaces on Lemmy or Imgur anyway.

Edit `scripts/sources.mjs` to change topics or communities. Nothing else needs touching.

---

## Setup

**1. Push to a repo**, then Settings → Pages → Source: **GitHub Actions** (not "Deploy from a branch"). Public repo — Actions minutes are unlimited there and metered on private.

**2. No keys needed for most of it.** Lemmy, Know Your Meme, Wikipedia, Bluesky and Hacker News work immediately. You can stop here and have a working wall.

**3. Imgur** (optional) — <https://api.imgur.com/oauth2/addclient> → *OAuth 2 without callback URL*. Copy the **Client ID** only. Secret: `IMGUR_CLIENT_ID`

**4. Giphy** (optional) — <https://developers.giphy.com/dashboard/> → Create an App → **API Key**. Secret: `GIPHY_API_KEY`

**5. Anthropic** (optional) — enables clusters, blurbs and the glossary. Secret: `ANTHROPIC_API_KEY`

**6. Secrets go in** repo → Settings → Secrets and variables → Actions → New repository secret. Names must match exactly:

```
IMGUR_CLIENT_ID    GIPHY_API_KEY    ANTHROPIC_API_KEY
```

**7. Run it once.** Actions → *Refresh feed* → Run workflow. Takes a couple of minutes. The log prints a line per source — `c/memes: 28` means it worked, `imgur: skipped (no IMGUR_CLIENT_ID)` means that secret is missing. Then open your Pages URL.

Every source is independently optional. Missing keys log a skip line; failures log a warning. The build only hard-fails if *nothing* was fetched, so a bad run can never blank your wall.

**Local dev**

```bash
node scripts/test.mjs                      # offline parser checks, no keys needed
DRY_RUN=1 node scripts/build-feed.mjs      # build from fixtures
npx serve .                                # look at it
```

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

1. **Never fetch the full-size image.** Every source hands you a way to ask for a smaller one. Lemmy's pict-rs resizes on demand (`?thumbnail=320&format=webp`), Imgur exposes sizes as URL suffixes (`{hash}m.jpg` = 320px, `l` = 640, `h` = 1024), Bluesky serves a `thumb` alongside `fullsize`, Giphy pre-renders several widths. The builder harvests all of them into a `srcset`, and `sizes="(min-width:1000px) 24vw, 46vw"` lets the browser pick the smallest rung that fits its column. On a phone you download the 320px WebP of a 4 MB image. This alone is the difference between a 40 MB page and a 3 MB page.

2. **GIFs are never GIFs.** Every animated post on Imgur and Giphy also exists as an mp4, at roughly 5–20× smaller. The wall shows a still frame; the mp4 is fetched **only on hover or tap**. Scrolling past a hundred GIF tiles costs you a hundred small stills, not a hundred videos.

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
scripts/test.mjs              offline parser checks (no network, no keys)
scripts/fixtures*.json        sample data for DRY_RUN=1
.github/workflows/refresh.yml the cron
data/feed.json                generated output (committed by the bot)
data/memory.json              the glossary that grows over time (committed)
```

## Notes

- The tile grid, chips, thread rail, sheet, and filtering are verified against fixture data; all rendered text is HTML-escaped. `scripts/test.mjs` covers the source parsers.
- `data/` is gitignored. Locally it holds whatever your last `DRY_RUN` produced; in CI it's rebuilt from scratch each time, with `memory.json` restored from the `state` branch.
- To read or hand-edit the glossary: `git show origin/state:memory.json`. To wipe it and start learning fresh, delete the `state` branch.
- If the page loads but shows an error card instead of tiles, it names the actual failure and the URL it tried — no guessing.
- If Reddit logs `rss fallback` for every subreddit, your feed token isn't being read — check the secret names. RSS still works, you just lose image quality and scores.
- If a build returns 429s, raise `REDDIT_GAP_MS` or cut subreddits from `sources.mjs`.
- GitHub's cron is best-effort: a `0 */4 * * *` schedule routinely fires 5–20 minutes late, and pauses entirely if the repo sees no activity for 60 days.
- `data/feed.json` ships with fixture data so the page renders before your first real build.
