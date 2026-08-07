// Source definitions. Add/remove here — nothing else needs to change.

export const TOPICS = {
  memes: {
    label: 'Memes',
    emoji: '🗿',
    reddit: ['memes', 'dankmemes', 'me_irl'],
    imgur: true,   // viral gallery — memes + gifs, has its own thumbnail ladder
    giphy: true,   // trending gifs, served as mp4
  },
  origins: {
    label: 'Meme origins',
    emoji: '📖',
    reddit: ['PeterExplainsTheJoke'],
    kym: true,     // Know Your Meme via Firecrawl
  },
  viral: {
    label: 'Viral & drama',
    emoji: '🔥',
    reddit: ['interestingasfuck', 'OutOfTheLoop', 'nextfuckinglevel'],
  },
  tech: {
    label: 'Tech / X discourse',
    emoji: '⚡',
    reddit: ['technology'],
    hn: true,      // free, no key, no rate limit
  },
};

export const PER_TOPIC_CAP = 40;

/* -------------------------------------------------------------- reddit */
// Reddit throttles unauthenticated feed reads to roughly 1 request/minute.
// With a personal RSS token you get more headroom, but we stay polite either
// way — this job runs unattended, so a slow build costs nothing.
export const REDDIT_GAP_MS = Number(process.env.REDDIT_GAP_MS || 65_000);
export const REDDIT_WINDOW = 'day';   // day | week | month
export const REDDIT_LIMIT = 30;

/* ------------------------------------------------------- other sources */
export const IMGUR_PAGES = 1;         // 60 items per page
export const GIPHY_LIMIT = 25;
