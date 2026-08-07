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

/* ------------------------------------------------------------- archive
 * These topics ACCUMULATE. Items are merged into data/archive.json and never
 * dropped, so the collection grows every build instead of rotating. Good for
 * things that don't expire: classic formats, film reaction GIFs, events.
 */
export const ARCHIVE_TOPICS = {
  classics: {
    label: 'Hall of fame',
    emoji: '🏛️',
    archive: true,
    imgflip: true,   // 100 canonical meme templates, no key
    giphySearch: [
      'distracted boyfriend meme', 'drake meme', 'this is fine', 'surprised pikachu',
      'roll safe', 'woman yelling at cat', 'galaxy brain', 'stonks',
      'confused math lady', 'side eye', 'mocking spongebob',
    ],
    imgurSearch: ['classic meme'],
  },
  bollywood: {
    label: 'Bollywood',
    emoji: '🎬',
    archive: true,
    giphySearch: [
      'bollywood', 'shah rukh khan', 'desi', 'bollywood dance', 'amitabh bachchan',
      'bollywood reaction', 'indian tv serial', 'nawazuddin', 'kapoor',
    ],
    rss: [
      ['https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms', 'Times of India · Entertainment'],
    ],
  },
  india: {
    label: 'India',
    emoji: '🇮🇳',
    archive: true,
    rss: [
      ['https://timesofindia.indiatimes.com/rssfeedstopstories.cms', 'Times of India'],
      ['https://feeds.feedburner.com/ndtvnews-top-stories', 'NDTV'],
      ['https://www.thehindu.com/news/national/feeder/default.rss', 'The Hindu'],
    ],
  },
};

/* ---------------------------------------------------------------- news
 * Stories are ranked by how many distinct outlets covered them, not by any
 * single publisher's judgement. GDELT indexes thousands of outlets globally
 * and needs no key; the RSS lists are a fallback for when it's slow.
 */
export const NEWS_SECTIONS = {
  world: {
    label: 'Geopolitics',
    emoji: '🌍',
    query: '(sanctions OR ceasefire OR treaty OR summit OR "security council" OR tariffs OR "peace talks" OR airstrike OR diplomacy) sourcelang:eng',
    rss: [
      ['https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC World'],
      ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
      ['https://feeds.npr.org/1004/rss.xml', 'NPR World'],
    ],
  },
  india: {
    label: 'India',
    emoji: '🇮🇳',
    query: 'sourcecountry:IN sourcelang:eng',
    rss: [
      ['https://www.thehindu.com/news/national/feeder/default.rss', 'The Hindu'],
      ['https://indianexpress.com/section/india/feed/', 'Indian Express'],
      ['https://scroll.in/feed', 'Scroll.in'],
    ],
  },
  us: {
    label: 'United States',
    emoji: '🇺🇸',
    query: 'sourcecountry:US sourcelang:eng',
    rss: [
      ['https://feeds.npr.org/1001/rss.xml', 'NPR'],
      ['https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', 'BBC US & Canada'],
    ],
  },
  brief: {
    label: 'Briefing',
    emoji: '📰',
    query: '(science OR economy OR climate OR health OR technology OR court OR election) sourcelang:eng',
    rss: [
      ['https://feeds.bbci.co.uk/news/rss.xml', 'BBC'],
      ['https://feeds.npr.org/1002/rss.xml', 'NPR'],
    ],
  },
};

export const NEWS_PER_SECTION = 10;
export const NEWS_TIMEOUT_MS = 25_000;

// Your call, not mine. Add any domain you don't want in the mix.
export const NEWS_BLOCKED_DOMAINS = [];

export const PER_TOPIC_CAP = 40;

// Archive caps. Nothing is removed until the collection passes MAX, and even
// then only the oldest additions go.
export const ARCHIVE_MAX = 1500;
export const ARCHIVE_PER_QUERY = 12;

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
