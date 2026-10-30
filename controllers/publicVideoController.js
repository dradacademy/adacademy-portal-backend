const https = require("https");

// "Popular videos" on the public website (2026-10-30).
// Shows the academy's YouTube videos automatically — no admin work needed.
//
// Which videos:
//   - If YOUTUBE_API_KEY is set on Railway (free key from Google Cloud →
//     "YouTube Data API v3"), the channel's MOST-VIEWED videos of all time.
//   - Otherwise, YouTube's public channel feed: the latest ~15 public
//     videos, sorted by views (most viewed first). Needs no key.
// Which channel: YOUTUBE_CHANNEL_ID if set, else it is looked up from the
// handle in YOUTUBE_HANDLE (default "@dradacademy") once and remembered.
// Pinned videos: YOUTUBE_PINNED on Railway (comma-separated links or IDs)
// puts chosen free classes FIRST. Empty by default.
// Showcase videos (2026-10-30): "Inside our classroom" — Dr. Dinesh's own
// videos of how classes are handled + student testimonials. They are NOT
// free classes: returned separately as `showcase` and kept out of `data`.
// Default = the two he shared; YOUTUBE_SHOWCASE on Railway replaces them.
// Unlisted videos (the paid recorded classes) are never in either list.
// Results are cached for 6 hours so the website stays fast and YouTube is
// asked rarely. If anything fails, the list is just empty and the website
// hides the section.

const CACHE_MS = 6 * 60 * 60 * 1000;
const FAIL_RETRY_MS = 15 * 60 * 1000;
let cache = { at: 0, data: null, source: null };
let channelIdCache = null;

const DEFAULT_PINNED = [];
const DEFAULT_SHOWCASE = ["gkjKBEDNNro", "ej97klfOlNQ"];
let showcaseCache = { at: 0, key: "", data: [] };
const HANDLE = () => (process.env.YOUTUBE_HANDLE || "@dradacademy").trim().replace(/^@?/, "@");

// Accepts a bare ID or any YouTube link (youtu.be/…, watch?v=…, /shorts/…, /live/…).
const toVideoId = (raw = "") => {
  const t = String(raw).trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  const m = t.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
};

const idList = (env, fallback) => {
  const list = env ? env.split(/[\s,]+/).map(toVideoId).filter(Boolean) : fallback;
  return [...new Set(list)];
};
const pinnedIds = () => idList(process.env.YOUTUBE_PINNED, DEFAULT_PINNED);
const showcaseIds = () => idList(process.env.YOUTUBE_SHOWCASE, DEFAULT_SHOWCASE);

// Title of one video, no key needed (YouTube's public oEmbed).
const fromOembed = async (id) => {
  try {
    const j = JSON.parse(await get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`));
    // A Short / vertical video comes back taller than wide.
    const portrait = Number(j.height) > Number(j.width);
    return { id, title: decode(j.title || ""), publishedAt: null, views: 0, isShort: false, portrait };
  } catch (e) {
    return { id, title: "", publishedAt: null, views: 0, isShort: false };
  }
};

// Showcase list (titles via oEmbed), cached like the main list.
const getShowcase = async () => {
  const ids = showcaseIds();
  const key = ids.join(",");
  const okAge = showcaseCache.data.some((v) => v.title) ? CACHE_MS : FAIL_RETRY_MS;
  if (showcaseCache.key === key && Date.now() - showcaseCache.at < okAge) return showcaseCache.data;
  const data = [];
  for (const id of ids) data.push(await fromOembed(id));
  showcaseCache = { at: Date.now(), key, data };
  return data;
};

// Pinned videos first (in the order given), then the rest without repeats.
const withPinned = async (list) => {
  const ids = pinnedIds();
  if (!ids.length) return list;
  const byId = new Map(list.map((v) => [v.id, v]));
  const pinned = [];
  for (const id of ids) {
    const v = byId.get(id) || (await fromOembed(id));
    pinned.push({ ...v, isShort: false, pinned: true });
  }
  return [...pinned, ...list.filter((v) => !ids.includes(v.id))];
};

const get = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; DrADAcademyBot/1.0)", "Accept-Language": "en" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString()));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 3_000_000) req.destroy(new Error("too big"));
        });
        res.on("end", () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });

const decode = (s = "") =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const resolveChannelId = async () => {
  if (process.env.YOUTUBE_CHANNEL_ID) return process.env.YOUTUBE_CHANNEL_ID.trim();
  if (channelIdCache) return channelIdCache;
  const handle = HANDLE();
  const html = await get(`https://www.youtube.com/${encodeURIComponent(handle).replace("%40", "@")}`);
  const m =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    html.match(/"externalId":"(UC[\w-]{22})"/) ||
    html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error("channel id not found");
  channelIdCache = m[1];
  return channelIdCache;
};

// Free public feed — latest public uploads with view counts.
const fromFeed = async (channelId) => {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  const entries = xml.split("<entry>").slice(1);
  return entries
    .map((e) => {
      const id = (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1];
      if (!id) return null;
      return {
        id,
        title: decode((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""),
        publishedAt: (e.match(/<published>([^<]+)<\/published>/) || [])[1] || null,
        views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1] || 0),
        isShort: /\/shorts\//.test(e),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.views - a.views);
};

// With an API key — most viewed of all time.
const fromApi = async (channelId, key) => {
  const search = JSON.parse(
    await get(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=viewCount&type=video&maxResults=12&key=${encodeURIComponent(key)}`
    )
  );
  const ids = (search.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const stats = JSON.parse(
    await get(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids.join(",")}&key=${encodeURIComponent(key)}`)
  );
  return (stats.items || [])
    .map((v) => ({
      id: v.id,
      title: decode(v.snippet?.title || ""),
      publishedAt: v.snippet?.publishedAt || null,
      views: Number(v.statistics?.viewCount || 0),
      isShort: false,
    }))
    .sort((a, b) => b.views - a.views);
};

// GET /api/public-videos — no login needed (public website).
const getPopularVideos = async (req, res) => {
  try {
    const fresh = cache.data && Date.now() - cache.at < (cache.data.length ? CACHE_MS : FAIL_RETRY_MS);
    if (!fresh) {
      try {
        const channelId = await resolveChannelId();
        const key = process.env.YOUTUBE_API_KEY;
        let list = [];
        let source = "feed";
        if (key) {
          try {
            list = await fromApi(channelId, key);
            source = "api";
          } catch (e) {
            console.error("publicVideos: API failed, using feed:", e.message);
          }
        }
        if (!list.length) list = await fromFeed(channelId);
        list = await withPinned(list);
        cache = { at: Date.now(), data: list.slice(0, 12), source, channelId };
      } catch (e) {
        console.error("publicVideos:", e.message);
        let fallback = cache.data && cache.data.length ? cache.data : [];
        if (!fallback.length) {
          try {
            fallback = await withPinned([]);
          } catch (_) {}
        }
        cache = { at: Date.now(), data: fallback, source: "error" };
      }
    }
    let showcase = [];
    try {
      showcase = await getShowcase();
    } catch (_) {}
    const showIds = new Set(showcase.map((v) => v.id));
    res.set("Cache-Control", "public, max-age=900");
    res.status(200).json({
      success: true,
      data: (cache.data || []).filter((v) => !showIds.has(v.id)),
      showcase,
      channelUrl: `https://www.youtube.com/${HANDLE()}`,
      source: cache.source,
    });
  } catch (error) {
    res.status(200).json({ success: true, data: [] });
  }
};

module.exports = { getPopularVideos, _test: { fromFeed, resolveChannelId, decode, toVideoId, pinnedIds, showcaseIds, withPinned, getShowcase } };
