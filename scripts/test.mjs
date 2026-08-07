/**
 * Offline checks for the source parsers. No network, no keys.
 *   NO_MAIN=1 node scripts/test.mjs
 */
process.env.NO_MAIN = '1';
const { fromRss, fromJson, imgur, giphy } = await import('./build-feed.mjs');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

/* ------------------------------------------------------------------- rss */

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <author><name>/u/someone</name></author>
  <content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;a href="https://i.redd.it/abc123.jpg"&gt;&lt;img src="https://b.thumbs.redditmedia.com/tiny.jpg" alt="thumb"&gt;&lt;/a&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
  <id>t3_zzz111</id>
  <link href="https://www.reddit.com/r/memes/comments/zzz111/a_post/" />
  <updated>2026-08-07T09:00:00+00:00</updated>
  <title>Caf&amp;#39;s &amp;amp; other places</title>
</entry>
<entry>
  <content type="html">&lt;a href="https://i.redd.it/moving.gif"&gt;&lt;img src="https://a.thumbs.redditmedia.com/t.jpg"&gt;&lt;/a&gt;</content>
  <id>t3_zzz222</id>
  <link href="https://www.reddit.com/r/memes/comments/zzz222/b/" />
  <updated>2026-08-07T08:00:00+00:00</updated>
  <title>An animated one</title>
</entry>
<entry>
  <content type="html">no media here</content>
  <id>t3_zzz333</id>
  <link href="https://www.reddit.com/r/memes/comments/zzz333/c/" />
  <updated>2026-08-07T07:00:00+00:00</updated>
  <title>Text only</title>
</entry>
</feed>`;

console.log('\nRSS fallback');
const rss = fromRss(RSS, 'memes');
ok(rss.length === 3, 'parses every entry', `got ${rss.length}`);
ok(rss[0].id === 'rd_zzz111', 'extracts t3_ id', rss[0].id);
ok(rss[0].src === 'https://i.redd.it/abc123.jpg', 'prefers full image over tiny thumb', rss[0].src);
ok(rss[0].title === "Caf's & other places", 'decodes double-escaped entities', JSON.stringify(rss[0].title));
ok(rss[0].sourceUrl.includes('/comments/zzz111/'), 'keeps permalink');
ok(rss[0].ts === Math.floor(Date.parse('2026-08-07T09:00:00Z') / 1000), 'parses timestamp');
ok(rss[1].kind === 'video' && rss[1].video === 'https://i.redd.it/moving.mp4', 'gif -> mp4', rss[1].video);
ok(rss[2].kind === 'text' && rss[2].src === null, 'handles media-less entry');
ok(fromRss('<feed></feed>', 'x').length === 0, 'empty feed is not a crash');

/* ------------------------------------------------------------------ json */

console.log('\nJSON path');
const post = (over) => ({
  id: 'aaa', subreddit: 'memes', permalink: '/r/memes/comments/aaa/x/',
  title: 'Tom &amp; Jerry', score: 1234, num_comments: 56, created_utc: 1754500000, selftext: '',
  preview: {
    images: [{
      source: { url: 'https://preview.redd.it/full.jpg?a=1&amp;b=2', width: 1200, height: 800 },
      resolutions: [
        { url: 'https://preview.redd.it/w108.jpg?s=x&amp;y=z', width: 108, height: 72 },
        { url: 'https://preview.redd.it/w320.jpg?s=x&amp;y=z', width: 320, height: 213 },
        { url: 'https://preview.redd.it/w640.jpg?s=x&amp;y=z', width: 640, height: 427 },
      ],
      variants: {},
    }],
  },
  ...over,
});

const j = fromJson(post());
ok(j.title === 'Tom & Jerry', 'decodes title', j.title);
ok(j.w === 1200 && j.h === 800, 'keeps source dimensions for aspect-ratio');
ok(!j.src.includes('&amp;'), 'unescapes url entities', j.src);
ok(j.src.includes('w640'), 'picks the >=640 rung', j.src);
ok(!j.srcset.includes('108w'), 'drops sub-216px rungs from srcset');
ok(j.srcset.split(',').length === 2, 'srcset has the useful rungs', j.srcset.split(',').length + '');
ok(j.kind === 'image' && j.video === null, 'still image');

const anim = fromJson(post({ preview: { images: [post().preview.images[0]], reddit_video_preview: { fallback_url: 'https://v.redd.it/x/DASH_480.mp4' } } }));
ok(anim.kind === 'video' && anim.video.endsWith('.mp4'), 'animated post exposes mp4', anim.video);

ok(fromJson(post({ over_18: true })) === null, 'nsfw filtered');
ok(fromJson(post({ stickied: true })) === null, 'stickied filtered');
ok(fromJson({ id: 'b', subreddit: 's', permalink: '/p', title: 't', selftext: '' }) === null, 'media-less, body-less post dropped');
ok(fromJson({ id: 'c', subreddit: 's', permalink: '/p', title: 't', selftext: 'a story' })?.kind === 'text', 'self-post kept as text');

/* ----------------------------------------------------------------- imgur */

console.log('\nImgur');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: [
      { id: 'aaa111', title: 'Still one', ups: 900, comment_count: 12, datetime: 1754500000, type: 'image/jpeg', width: 800, height: 600, animated: false, link: 'https://imgur.com/gallery/aaa111' },
      { id: 'bbb222', title: 'Moving one', ups: 500, datetime: 1754500001, animated: true, mp4: 'https://i.imgur.com/bbb222.mp4', width: 640, height: 640 },
      { id: 'ccc333', title: 'Album', is_album: true, cover: 'covhash', cover_width: 500, cover_height: 700, ups: 300, datetime: 1754500002 },
      { id: 'ddd444', title: 'Bad', nsfw: true, ups: 1 },
      { id: 'eee555', title: '', ups: 5, datetime: 1754500003, width: 10, height: 10 },
    ],
  }),
});
process.env.IMGUR_CLIENT_ID = 'test';
const im = await imgur();
ok(im.length === 3, 'filters nsfw and untitled', `got ${im.length}`);
ok(im[0].src === 'https://i.imgur.com/aaa111l.jpg', 'builds large URL from hash', im[0].src);
ok(im[0].srcset.includes('320w') && im[0].srcset.includes('1024w'), 'builds the suffix ladder');
ok(im[1].kind === 'video' && im[1].video.endsWith('.mp4'), 'animated -> mp4');
ok(im[2].src.includes('covhash'), 'album uses cover hash', im[2].src);
ok(im[2].w === 500 && im[2].h === 700, 'album uses cover dimensions');

/* ----------------------------------------------------------------- giphy */

console.log('\nGiphy');
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: [
      { id: 'g1', url: 'https://giphy.com/g1', title: 'Excited Dog GIF', trending_datetime: '2026-08-07 09:00:00',
        images: {
          fixed_width_still: { url: 'https://media.giphy.com/g1/200w_s.gif', width: '200', height: '150' },
          fixed_width_small_still: { url: 'https://media.giphy.com/g1/100w_s.gif', width: '100', height: '75' },
          fixed_width: { mp4: 'https://media.giphy.com/g1/200w.mp4' },
        } },
      { id: 'g2', url: 'https://giphy.com/g2', title: 'No mp4', images: { fixed_width_still: { url: 'x', width: '200' } } },
    ],
  }),
});
process.env.GIPHY_API_KEY = 'test';
const gp = await giphy();
ok(gp.length === 1, 'drops entries without an mp4', `got ${gp.length}`);
ok(gp[0].title === 'Excited Dog', 'strips trailing "GIF" from title', gp[0].title);
ok(gp[0].w === 200 && gp[0].h === 150, 'coerces string dimensions to numbers');
ok(gp[0].srcset.includes('100w') && gp[0].srcset.includes('200w'), 'builds srcset');
ok(gp[0].video.endsWith('.mp4'), 'serves mp4 not gif');

globalThis.fetch = realFetch;

/* ------------------------------------------------------------ shape check */

console.log('\nShape');
const REQUIRED = ['id', 'source', 'sourceUrl', 'title', 'score', 'comments', 'ts', 'body', 'blurb', 'kind', 'src', 'srcset', 'w', 'h', 'video'];
for (const [label, list] of [['rss', rss], ['imgur', im], ['giphy', gp], ['json', [j]]]) {
  const bad = list.filter((it) => REQUIRED.some((k) => !(k in it)));
  ok(bad.length === 0, `${label} items match the feed schema`, bad.length ? JSON.stringify(bad[0]) : '');
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
