/**
 * Offline checks for the source parsers. No network, no keys.
 *   node scripts/test.mjs
 * Fixtures below are trimmed copies of real API responses.
 */
process.env.NO_MAIN = '1';
const M = await import('./build-feed.mjs');

let fails = 0;
const ok = (c, label, extra = '') => {
  console.log(`${c ? '  ok  ' : '  FAIL'} ${label}${extra ? '  ' + extra : ''}`);
  if (!c) fails++;
};
const realFetch = globalThis.fetch;
const mock = (payload, { okStatus = true, text = false } = {}) => {
  globalThis.fetch = async () => ({
    ok: okStatus, status: okStatus ? 200 : 500,
    json: async () => payload, text: async () => payload,
  });
};
const restore = () => { globalThis.fetch = realFetch; };

const REQUIRED = ['id', 'source', 'sourceUrl', 'title', 'score', 'comments', 'ts', 'body', 'blurb', 'kind', 'src', 'srcset', 'w', 'h', 'video'];
const shapeOk = (list) => list.every((i) => REQUIRED.every((k) => k in i));

/* ------------------------------------------------------------------ lemmy */

console.log('\nLemmy');
mock({ posts: [
  { post: { id: 50388050, name: 'Come on', url: 'https://media.piefed.zip/x.jpeg',
      thumbnail_url: 'https://lemmy.world/pictrs/image/95169d33.jpeg', ap_id: 'https://piefed.zip/c/memes/p/1714868',
      published: '2026-08-07T02:20:20.951262Z', nsfw: false, body: '' },
    community: { name: 'memes' }, counts: { score: 367, comments: 21 },
    image_details: { link: 'https://lemmy.world/pictrs/image/95169d33.jpeg', width: 467, height: 512, content_type: 'image/jpeg' } },
  { post: { id: 2, name: 'Animated', url: 'https://example.com/a.gif', thumbnail_url: 'https://lemmy.world/pictrs/image/b.jpeg',
      published: '2026-08-07T03:00:00Z', nsfw: false },
    community: { name: 'memes' }, counts: { score: 10, comments: 1 }, image_details: { width: 300, height: 300 } },
  { post: { id: 3, name: 'NSFW thing', nsfw: true, published: '2026-08-07T03:00:00Z' }, counts: {} },
  { post: { id: 4, name: 'Removed', removed: true, published: '2026-08-07T03:00:00Z' }, counts: {} },
  { post: { id: 5, name: 'Text post', body: 'a discussion', published: '2026-08-07T03:00:00Z', nsfw: false },
    community: { name: 'memes' }, counts: { score: 5, comments: 2 } },
  { post: { id: 6, name: 'No media no body', published: '2026-08-07T03:00:00Z', nsfw: false }, community: { name: 'memes' }, counts: {} },
]});
const lm = await M.lemmy('memes@lemmy.world');
restore();
ok(lm.length === 3, 'filters nsfw / removed / empty', `got ${lm.length}`);
ok(lm[0].id === 'lm_50388050', 'ids prefixed', lm[0].id);
ok(lm[0].w === 467 && lm[0].h === 512, 'exact dimensions for aspect-ratio');
ok(lm[0].src.includes('thumbnail=640'), 'requests a sized thumbnail, not the original', lm[0].src);
ok(lm[0].srcset.includes('320w') && lm[0].srcset.includes('1024w'), 'builds a pict-rs ladder');
ok(lm[0].srcset.includes('format=webp'), 'asks for webp');
ok(lm[0].sourceUrl.startsWith('https://piefed.zip'), 'uses federated permalink');
ok(lm[0].ts === Math.floor(Date.parse('2026-08-07T02:20:20.951Z') / 1000), 'parses timestamp');
ok(lm[1].kind === 'video' && lm[1].video.endsWith('.gif'), 'gif detected as video', lm[1].video);
ok(lm[2].kind === 'text' && lm[2].body === 'a discussion', 'text post kept');
ok(shapeOk(lm), 'schema');
ok(M.pictSrcset('https://cdn.example.com/x.jpg') === null, 'no ladder for non-pictrs urls');

/* -------------------------------------------------------------------- rss */

console.log('\nRSS (Know Your Meme)');
const RSS = `<rss><channel>
<item><title>The &amp;#39;six-seven&amp;#39; chant</title><link>https://knowyourmeme.com/memes/six-seven</link>
<description><![CDATA[<img src="https://i.kym-cdn.com/entries/icons/x.jpg" /><p>A number chant lifted from a rap lyric.</p>]]></description>
<pubDate>Fri, 07 Aug 2026 09:00:00 -0400</pubDate></item>
<item><title>No image entry</title><link>https://knowyourmeme.com/memes/b</link>
<description>Plain text only</description><pubDate>Fri, 07 Aug 2026 08:00:00 -0400</pubDate></item>
<item><title></title><link>https://knowyourmeme.com/c</link></item>
</channel></rss>`;
const rss = M.parseRss(RSS, 'Know Your Meme', 'kym_');
ok(rss.length === 2, 'skips entries with no title', `got ${rss.length}`);
ok(rss[0].title === "The 'six-seven' chant", 'decodes double-escaped entities', rss[0].title);
ok(rss[0].src === 'https://i.kym-cdn.com/entries/icons/x.jpg', 'pulls img out of CDATA description');
ok(rss[0].body === 'A number chant lifted from a rap lyric.', 'strips html from body', JSON.stringify(rss[0].body));
ok(rss[0].ts === Math.floor(Date.parse('Fri, 07 Aug 2026 09:00:00 -0400') / 1000), 'parses pubDate');
ok(rss[1].kind === 'text' && rss[1].src === null, 'handles image-less entry');
ok(new Set(rss.map((r) => r.id)).size === 2, 'ids are unique');
ok(shapeOk(rss), 'schema');

/* -------------------------------------------------------------- wikipedia */

console.log('\nWikipedia most-read');
mock({ mostread: { articles: [
  { titles: { canonical: 'Kelvin–Helmholtz_instability', normalized: 'Kelvin–Helmholtz instability' },
    views: 240000, extract: 'A fluid instability.', thumbnail: { source: 'https://upload.wikimedia.org/x.jpg', width: 320, height: 200 },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Kelvin–Helmholtz_instability' } } },
  { titles: { canonical: 'Main_Page' }, views: 9e9 },
  { titles: { canonical: 'Foo_(disambiguation)' }, type: 'disambiguation', views: 100 },
  { titles: { canonical: 'No_Image', normalized: 'No Image' }, views: 5000, extract: 'text only' },
]}});
const wk = await M.wikipedia();
restore();
ok(wk.length === 2, 'drops Main_Page and disambiguations', `got ${wk.length}`);
ok(wk[0].score === 240000, 'uses view count as score');
ok(wk[0].body === 'A fluid instability.', 'keeps the extract as context');
ok(wk[0].kind === 'image' && wk[0].w === 320, 'thumbnail + dimensions');
ok(wk[1].kind === 'text', 'image-less article still included');
ok(shapeOk(wk), 'schema');

/* ---------------------------------------------------------------- bluesky */

console.log('\nBluesky');
mock({ feed: [
  { post: { cid: 'bafyreiabcdefghijklmnop', uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz',
      author: { handle: 'someone.bsky.social' }, record: { text: 'the wall is real' },
      likeCount: 500, replyCount: 12, indexedAt: '2026-08-07T12:00:00Z',
      embed: { images: [{ thumb: 'https://cdn.bsky.app/t.jpg', fullsize: 'https://cdn.bsky.app/f.jpg', aspectRatio: { width: 1000, height: 750 } }] } } },
  { post: { cid: 'b2', uri: 'at://x/y/2', author: { handle: 'a.bsky.social' }, record: { text: 'a reply', reply: {} }, indexedAt: '2026-08-07T12:00:00Z' } },
  { post: { cid: 'b3', uri: 'at://x/y/3', author: { handle: 'b.bsky.social' }, record: { text: '' }, indexedAt: '2026-08-07T12:00:00Z' } },
  { post: { cid: 'b4', uri: 'at://x/y/4', author: { handle: 'c.bsky.social' }, record: { text: 'x'.repeat(400) }, indexedAt: '2026-08-07T12:00:00Z' } },
]});
const bs = await M.bluesky();
restore();
ok(bs.length === 2, 'drops replies and empty posts', `got ${bs.length}`);
ok(bs[0].source === '@someone.bsky.social', 'attributes the author');
ok(bs[0].sourceUrl === 'https://bsky.app/profile/someone.bsky.social/post/3kxyz', 'builds a real permalink', bs[0].sourceUrl);
ok(bs[0].w === 1000 && bs[0].h === 750, 'uses aspectRatio');
ok(bs[0].srcset.includes('320w') && bs[0].srcset.includes('1000w'), 'thumb + fullsize srcset');
ok(bs[1].title.length === 198 && bs[1].title.endsWith('…'), 'truncates long posts', String(bs[1].title.length));
ok(shapeOk(bs), 'schema');

/* ------------------------------------------------------------------ giphy */

console.log('\nGiphy');
process.env.GIPHY_API_KEY = 'test';
mock({ data: [
  { id: 'g1', url: 'https://giphy.com/gifs/g1', title: 'Excited Dog GIF by Someone', trending_datetime: '2026-08-07 09:00:00',
    images: { downsized_still: { url: 'https://m.giphy.com/480_s.gif', width: '480', height: '360' },
      fixed_width_small_still: { url: 'https://m.giphy.com/100_s.gif', width: '100', height: '75' },
      downsized_small: { mp4: 'https://m.giphy.com/small.mp4' } } },
  { id: 'g2', url: 'https://giphy.com/gifs/g2', title: 'No mp4', images: { downsized_still: { url: 'x', width: '200' } } },
]});
const gp = await M.giphy();
restore();
ok(gp.length === 1, 'drops entries with no mp4', `got ${gp.length}`);
ok(gp[0].title === 'Excited Dog', 'strips "GIF by ..." suffix', gp[0].title);
ok(gp[0].w === 480, 'uses the 480px rung, not 200px', String(gp[0].w));
ok(gp[0].video.endsWith('.mp4'), 'serves mp4 not gif');
ok(shapeOk(gp), 'schema');

/* ------------------------------------------------------------------ imgur */

console.log('\nImgur');
process.env.IMGUR_CLIENT_ID = 'test';
mock({ data: [
  { id: 'aaa111', title: 'Still', ups: 900, comment_count: 12, datetime: 1754500000, type: 'image/jpeg', width: 800, height: 600, animated: false },
  { id: 'bbb222', title: 'Moving', ups: 500, datetime: 1, animated: true, mp4: 'https://i.imgur.com/bbb222.mp4', width: 640, height: 640 },
  { id: 'ccc333', title: 'Album', is_album: true, cover: 'covhash', cover_width: 500, cover_height: 700, ups: 300, datetime: 2 },
  { id: 'ddd444', title: 'Bad', nsfw: true, ups: 1 },
  { id: 'eee555', title: '', ups: 5, datetime: 3, width: 10, height: 10 },
]});
const im = await M.imgur();
restore();
ok(im.length === 3, 'filters nsfw and untitled', `got ${im.length}`);
ok(im[0].src === 'https://i.imgur.com/aaa111l.jpg', 'builds the large URL', im[0].src);
ok(im[0].srcset.includes('320w') && im[0].srcset.includes('1024w'), 'suffix ladder');
ok(im[2].src.includes('covhash') && im[2].w === 500, 'album uses cover');
ok(shapeOk(im), 'schema');

/* ----------------------------------------------------------------- reddit */

console.log('\nReddit (local-only path)');
const rd = M.fromRedditJson({ id: 'aaa', subreddit: 'memes', permalink: '/r/memes/comments/aaa/x/',
  title: 'Tom &amp; Jerry', score: 1234, num_comments: 56, created_utc: 1754500000, selftext: '',
  preview: { images: [{ source: { url: 'https://preview.redd.it/full.jpg?a=1&amp;b=2', width: 1200, height: 800 },
    resolutions: [{ url: 'https://p.redd.it/w108.jpg?s=x&amp;y=z', width: 108 }, { url: 'https://p.redd.it/w640.jpg?s=x&amp;y=z', width: 640 }],
    variants: {} }] } });
ok(rd.title === 'Tom & Jerry', 'decodes title');
ok(!rd.src.includes('&amp;'), 'unescapes urls');
ok(!rd.srcset.includes('108w'), 'drops sub-216px rungs');
ok(M.fromRedditJson({ over_18: true }) === null, 'nsfw filtered');
ok(shapeOk([rd]), 'schema');

/* ------------------------------------------------------------- resilience */

console.log('\nFailure handling');
mock(null, { okStatus: false });
const dead = await Promise.all([M.lemmy('x@y'), M.wikipedia(), M.bluesky(), M.giphy(), M.imgur()]);
restore();
ok(dead.every((r) => Array.isArray(r) && r.length === 0), 'every source returns [] on HTTP error, never throws');

globalThis.fetch = async () => { throw new Error('network down'); };
const thrown = await Promise.all([M.lemmy('x@y'), M.wikipedia(), M.bluesky(), M.giphy()]);
restore();
ok(thrown.every((r) => Array.isArray(r) && r.length === 0), 'every source survives a thrown network error');

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
