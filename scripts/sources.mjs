// Source definitions. Each topic maps to fetchers.
// Add/remove subs here — nothing else needs to change.

export const TOPICS = {
  memes: {
    label: 'Memes',
    emoji: '🗿',
    reddit: ['memes', 'dankmemes', 'me_irl', 'MemeVideos', 'PeterExplainsTheJoke'],
  },
  origins: {
    label: 'Meme origins',
    emoji: '📖',
    reddit: ['OutOfTheLoop'],
    kym: true, // Know Your Meme via Firecrawl (optional)
  },
  viral: {
    label: 'Viral & drama',
    emoji: '🔥',
    reddit: ['interestingasfuck', 'Damnthatsinteresting', 'nextfuckinglevel', 'todayilearned'],
  },
  tech: {
    label: 'Tech / X discourse',
    emoji: '⚡',
    reddit: ['technology', 'singularity'],
    hn: true,
  },
};

// How many items to keep per topic in the final feed.
export const PER_TOPIC_CAP = 40;

// Reddit listing window. 'day' = freshest, 'week' = higher quality.
export const REDDIT_WINDOW = 'day';
export const REDDIT_LIMIT = 30;
