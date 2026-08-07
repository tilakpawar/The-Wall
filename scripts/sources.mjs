// Source definitions. Add/remove here — nothing else needs to change.
//
// Everything below is FREE and needs no key, except Imgur and Giphy (free
// self-serve keys). Nothing here is blocked from GitHub's IP ranges.
//
// Reddit is deliberately absent: it 403s every request from datacenter IPs
// regardless of credentials. The fetcher still supports it (see sources
// marked `reddit:` below) if you ever run the build from a home connection,
// but leave it empty for CI.

export const TOPICS = {
  memes: {
    label: 'Memes',
    emoji: '🗿',
    lemmy: ['memes@lemmy.world', 'lemmyshitpost@lemmy.world', 'memes@sopuli.xyz'],
    imgur: true,   // free key, has its own thumbnail ladder
    giphy: true,   // free key, gifs served as mp4
  },
  origins: {
    label: 'Meme origins',
    emoji: '📖',
    kym: true,     // Know Your Meme public RSS — no key, no Firecrawl
  },
  viral: {
    label: 'Viral & drama',
    emoji: '🔥',
    lemmy: ['showerthoughts@lemmy.world', 'todayilearned@lemmy.world', 'nottheonion@lemmy.world'],
    wikipedia: true,  // most-read articles = what everyone suddenly looked up
    bluesky: true,    // the closest thing to an X timeline that has a public API
  },
  tech: {
    label: 'Tech / X discourse',
    emoji: '⚡',
    lemmy: ['technology@lemmy.world'],
    hn: true,
  },
};

export const PER_TOPIC_CAP = 40;

/* -------------------------------------------------------------- lemmy */
// Any Lemmy instance can serve federated communities. lemmy.world is the
// largest and has no rate limit worth worrying about.
export const LEMMY_HOST = 'https://lemmy.world';
export const LEMMY_SORT = 'TopDay';   // TopDay | TopWeek | Hot | Active
export const LEMMY_LIMIT = 30;
export const LEMMY_GAP_MS = 300;

/* ------------------------------------------------------ other sources */
export const IMGUR_PAGES = 1;      // 60 items per page
export const GIPHY_LIMIT = 25;
export const BLUESKY_FEED = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
export const BLUESKY_LIMIT = 30;

/* ------------------------------------------------------------- reddit */
// Only usable from a residential IP. Leave the `reddit:` arrays empty above
// for CI builds; populate them if you run this locally.
export const REDDIT_GAP_MS = Number(process.env.REDDIT_GAP_MS || 65_000);
export const REDDIT_WINDOW = 'day';
export const REDDIT_LIMIT = 30;
