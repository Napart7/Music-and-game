'use strict';
// Platform lyric providers for GlassLyrics.
//
// Design rules:
//  - Text-only public endpoints. No account, no login, no cookie with credentials, no audio.
//  - Every provider returns the same shape (see `normalise`), so the renderer does not care
//    which platform the song came from.
//  - Netease `yrc` carries REAL per-character timestamps. QQ Music / LRCLIB only expose
//    line-level LRC, so those stay a visual approximation (the UI says so explicitly).
//  - No lyric text is bundled in this repository; everything is fetched at runtime and cached
//    in the user's own app-data directory.
//
// Note on the `appver`/`os` cookie sent to Netease: it is a public client-version marker
// required by their web API to return `yrc`, NOT an account credential. No MUSIC_U / token.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TIMEOUT_MS = 12000;

/* ------------------------------------------------------------------ helpers */

function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*\((?:explicit|clean|remaster(?:ed)?|live[^)]*|radio[^)]*|album[^)]*|deluxe[^)]*|bonus[^)]*|mono[^)]*|stereo[^)]*|feat\.?[^)]*|ft\.?[^)]*)\)\s*/gi, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*-\s*(?:remaster(?:ed)?|live|radio edit|explicit)\s*$/gi, '')
    .replace(/\s+/g, ' ').trim();
}

function cleanArtist(s) {
  return String(s || '').split(/[/,;&]|feat\.?|ft\.?|\bwith\b/i)[0].replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\-_'’.,!?()[\]:：·、，。！？]/g, '')
    .replace(/\b(official|video|audio|lyrics?|mv|hd|hq)\b/g, '');
}

async function request(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', ...(opts.headers || {}) },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).trim();
    // Some legacy FCG endpoints wrap JSON in a JSONP callback.
    const body = text.startsWith('callback(') ? text.slice(9).replace(/\)\s*;?$/, '') : text;
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse classic LRC into [{time, text}]. Multiple stamps per line supported. */
function parseLrc(raw) {
  const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(re)];
    if (!stamps.length) continue;
    const text = line.replace(re, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    for (const m of stamps) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
      out.push({ time: +(min * 60 + sec + frac).toFixed(3), text });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((l, i) => i === 0 || l.time !== out[i - 1].time || l.text !== out[i - 1].text);
}

/** Unsynchronised plain text: spread lines evenly over the known duration. */
function plainToLines(plain, duration) {
  const rows = String(plain || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!rows.length) return [];
  const total = duration > 10 ? duration : rows.length * 4;
  const step = total / (rows.length + 1);
  return rows.map((text, i) => ({ time: +((i + 1) * step).toFixed(3), text }));
}

/**
 * Parse Netease YRC (real per-character timing).
 *
 * Real lyric rows look like:
 *   [22310,4300](22310,2880,0)都 (25190,310,0)是(25500,290,0)勇(25790,230,0)敢(26020,590,0)的
 * Metadata rows are JSON objects ({"t":0,"c":[...]}) and are skipped.
 * A bracket can hold several characters ("MV ", "EAS "), so its duration is split evenly.
 *
 * @returns [{time, end, text, words:[{s,e}]}]  times are absolute seconds
 */
/** Find the next "(start,dur,flag)" timing brace, ignoring ordinary brackets in lyrics. */
function nextTiming(body, from) {
  let p = from;
  for (;;) {
    const o = body.indexOf('(', p);
    if (o < 0) return -1;
    const c = body.indexOf(')', o);
    if (c > o && /^\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(body.slice(o + 1, c))) return o;
    p = o + 1;
  }
}

function parseYrc(raw) {
  const out = [];
  for (const row of String(raw || '').split(/\r?\n/)) {
    const head = row.match(/^\[(\d+),\s*(\d+)\](.*)$/);
    if (!head) continue;                       // metadata JSON line, not a lyric row
    const lineStart = Number(head[1]);
    const lineDur = Number(head[2]);
    const body = head[3];
    const words = [];
    let text = '';
    let i = 0;
    while (i < body.length) {
      const open = nextTiming(body, i);
      if (open < 0) { text += body.slice(i); break; }
      if (open > i) text += body.slice(i, open);   // plain text before a timing brace
      const close = body.indexOf(')', open);
      const parts = body.slice(open + 1, close).split(',').map((x) => Number(x.trim()));
      const next = nextTiming(body, close + 1);
      const seg = body.slice(close + 1, next < 0 ? body.length : next);
      text += seg;                                 // characters covered by this brace
      const chars = [...seg];
      for (let k = 0; k < chars.length; k++) {
        const s = parts[0] + Math.round((parts[1] * k) / chars.length);
        const e = parts[0] + Math.round((parts[1] * (k + 1)) / chars.length);
        words.push({ s: +(s / 1000).toFixed(3), e: +(e / 1000).toFixed(3) });
      }
      i = next < 0 ? body.length : next;
    }
    if (!words.length || !text.trim()) continue;
    out.push({
      time: +(lineStart / 1000).toFixed(3),
      end: +((lineStart + lineDur) / 1000).toFixed(3),
      text,                                     // never trimmed: 1 char === 1 word entry
      words
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((l, i) => i === 0 || l.time !== out[i - 1].time);
}

/** Attach translated lines to their nearest original line by timestamp. */
function attachTranslations(lines, trans) {
  if (!Array.isArray(trans) || !trans.length) return lines;
  for (const l of lines) {
    let best = null, dist = Infinity;
    for (const t of trans) {
      const d = Math.abs(t.time - l.time);
      if (d < dist) { dist = d; best = t; }
    }
    if (best && dist <= 1.5) l.tr = best.text;
  }
  return lines;
}

/** Drop production credits / title header lines that platforms prepend to lyrics. */
const CREDIT = /(作词|作曲|编曲|制作人|混音|母带|吉他|贝斯|鼓|人声|和声|录音|版权|出品|发行|词版权|曲版权|未经|不得|词：|曲：|vocal|edite?|engineer|studio|record(ing)?|mix(ing|ed)?|master(ing|ed)?|producer|arrang|guitar|bass|drum|copyright|©|℗|@|\bop\b|\bsp\b|publish|label|ltd\b|co\.?\s*ltd)/i;
function stripCredits(lines) {
  return lines.filter((l, i) => {
    const t = l.text;
    if (i < 25 && CREDIT.test(t)) return false;
    // ASCII-only credit lines in the intro ("Vocal edite: ...", "MS Beijing", ...).
    if (l.time < 20 && /^[\x20-\x7E]{2,40}$/.test(t)) return false;
    // "Song Title - Artist" header usually sits at 0-5s on QQ Music LRC.
    if (l.time < 5 && /\s[-–—]\s/.test(t) && t.length > 12) return false;
    return true;
  });
}

/** Pick the best search hit by name similarity and duration proximity. */
function pickBest(list, map, track) {
  if (!Array.isArray(list) || !list.length) return null;
  const wantTitle = fold(cleanTitle(track.title));
  const wantArtist = fold(cleanArtist(track.artist));
  const dur = Number(track.duration) || 0;
  let best = null, bestScore = -Infinity;
  for (const raw of list.slice(0, 12)) {
    const s = map(raw);
    const name = fold(s.name);
    if (!name) continue;
    let score = 0;
    if (name === wantTitle) score += 6;
    else if (name.includes(wantTitle) || wantTitle.includes(name)) score += 3;
    else continue;                        // reject clearly unrelated results
    const artist = fold(s.artist || '');
    if (wantArtist && artist && (artist.includes(wantArtist) || wantArtist.includes(artist))) score += 3;
    if (dur > 0 && s.dur > 0) score += Math.max(0, 3 - Math.abs(dur - s.dur) / 8);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function normalise(r) {
  return {
    ok: true,
    provider: r.provider,
    source: r.source,
    platformId: r.platformId,
    wordSync: !!r.wordSync,
    synced: !!r.synced,
    lines: r.lines,
    cached: false,
    cover: r.cover || null,     // album art URL from the same platform (optional)
    title: r.title,
    artist: r.artist
  };
}

/* ------------------------------------------------------------- QQ Music */

async function qqmusic(track) {
  const q = [cleanTitle(track.title), cleanArtist(track.artist)].filter(Boolean).join(' ');
  if (!q) return null;
  const search = await request(
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${encodeURIComponent(q)}&format=json`,
    { headers: { Referer: 'https://y.qq.com/' } }
  );
  const hit = pickBest(search?.data?.song?.list, (s) => ({
    name: s.songname,
    mid: s.songmid,
    dur: Number(s.interval) || 0,
    artist: (s.singer || []).map((x) => x.name).join('/'),
    albumMid: s.albummid || ''
  }), track);
  if (!hit || !hit.mid) return null;
  // Standard public QQ album-art CDN pattern (no login, no cookie).
  const cover = hit.albumMid
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${hit.albumMid}.jpg` : null;

  const ly = await request(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(hit.mid)}` +
    `&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&platform=yqq`,
    { headers: { Referer: 'https://y.qq.com/portal/player.html' } }
  );
  if (Number(ly?.retcode) !== 0 || !ly.lyric) return null;
  let lines = stripCredits(parseLrc(ly.lyric));
  if (!lines.length) return null;
  if (ly.trans) attachTranslations(lines, parseLrc(ly.trans));
  return normalise({
    provider: 'QQ音乐', source: 'qqmusic-lrc', platformId: 'qqmusic',
    wordSync: false, synced: true, lines, cover,
    title: hit.name, artist: hit.artist
  });
}

/* --------------------------------------------------------- Netease Cloud */

async function netease(track) {
  const q = [cleanTitle(track.title), cleanArtist(track.artist)].filter(Boolean).join(' ');
  if (!q) return null;
  const NE = { Referer: 'https://music.163.com' };
  const search = await request(
    `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&limit=10`,
    { headers: NE }
  );
  const hit = pickBest(search?.result?.songs, (s) => ({
    name: s.name,
    id: s.id,
    dur: Math.round((Number(s.duration) || 0) / 1000),
    artist: (s.artists || []).map((x) => x.name).join('/')
  }), track);
  if (!hit || !hit.id) return null;

  // yv=1 + a public client-version cookie is required for `yrc` (real per-character timing).
  // `song/detail` supplies the album art (the search endpoint omits picUrl).
  const [a, b, c] = await Promise.allSettled([
    request(`https://music.163.com/api/song/lyric/v1?id=${hit.id}&level=ex&yv=1`,
      { headers: { ...NE, Cookie: 'appver=3.1.39; os=pc' } }),
    request(`https://music.163.com/api/song/lyric?id=${hit.id}&lv=1&kv=1&tv=-1`, { headers: NE }),
    request(`https://music.163.com/api/song/detail?id=${hit.id}&ids=${encodeURIComponent(`[${hit.id}]`)}`,
      { headers: NE })
  ]);
  const v1 = a.status === 'fulfilled' ? a.value : {};
  const old = b.status === 'fulfilled' ? b.value : {};
  const det = c.status === 'fulfilled' ? c.value : {};
  // ?param=300y300 asks the netease image CDN for a 300px thumbnail, not the 6MB original.
  const rawPic = det?.songs?.[0]?.album?.picUrl || '';
  const cover = rawPic ? `${rawPic}?param=300y300` : null;
  const yrc = stripCredits(parseYrc(v1?.yrc?.lyric));
  let lines = yrc.length ? yrc : stripCredits(parseLrc(old?.lrc?.lyric));
  if (!lines.length) return null;
  const trans = parseLrc(v1?.ytlrc?.lyric || v1?.tlyric?.lyric || old?.tlyric?.lyric || '');
  attachTranslations(lines, trans);
  return normalise({
    provider: '网易云音乐', source: yrc.length ? 'netease-yrc' : 'netease-lrc',
    platformId: 'netease', wordSync: yrc.length > 0, synced: true, lines,
    cover,
    title: hit.name, artist: hit.artist
  });
}

/* --------------------------------------------------------------- LRCLIB */

async function lrclib(track) {
  const t = { title: cleanTitle(track.title), artist: cleanArtist(track.artist),
              album: cleanTitle(track.album), duration: Number(track.duration) || 0 };
  if (!t.title) return null;
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const build = (d, source) => {
    const synced = typeof d?.syncedLyrics === 'string' ? parseLrc(d.syncedLyrics) : [];
    const plain = typeof d?.plainLyrics === 'string' ? d.plainLyrics : '';
    const lines = synced.length ? synced : plainToLines(plain, t.duration);
    if (!lines.length) return null;
    return normalise({
      provider: 'LRCLIB', source: synced.length ? 'lrclib-synced' : 'lrclib-plain-unSynced',
      platformId: 'lrclib', wordSync: false, synced: synced.length > 0, lines,
      title: d.trackName || t.title, artist: d.artistName || t.artist
    });
  };

  try {
    const d = await request(`${'https://lrclib.net/api'}/get?${q({
      track_name: t.title, artist_name: t.artist, album_name: t.album,
      duration: t.duration ? Math.round(t.duration) : ''
    })}`, { headers: { 'User-Agent': 'GlassLyrics/0.2 (personal desktop lyric overlay)', Accept: 'application/json' } });
    const r = build(d, 'lrclib');
    if (r) return r;
  } catch { /* fall through to search */ }

  const arr = await request(`${'https://lrclib.net/api'}/search?${q({
    track_name: t.title, artist_name: t.artist
  })}`, { headers: { 'User-Agent': 'GlassLyrics/0.2 (personal desktop lyric overlay)', Accept: 'application/json' } });
  if (!Array.isArray(arr) || !arr.length) return null;
  const sorted = t.duration > 0
    ? [...arr].sort((x, y) => Math.abs((x.duration || 0) - t.duration) - Math.abs((y.duration || 0) - t.duration))
    : arr;
  for (const d of sorted.slice(0, 3)) {
    const r = build(d, 'lrclib-search');
    if (r) return r;
  }
  return null;
}

/* --------------------------------------------------------------- Kugou */

/** Kugou: public mobile search → krcs candidate search → plain-text LRC download.
 *  No account, no KRC decryption (KRC word-level is proprietary and encrypted). */
async function kugou(track) {
  const q = [cleanTitle(track.title), cleanArtist(track.artist)].filter(Boolean).join(' ');
  if (!q) return null;
  const search = await request(
    `https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(q)}&page=1&pagesize=10&showtype=1`,
    { headers: { Referer: 'https://www.kugou.com/' } });
  const hit = pickBest(search?.data?.info, (s) => ({
    name: s.songname,
    hash: s.hash,
    dur: Number(s.duration) || 0,
    artist: s.singername || '',
    album: s.album_name || '',
    albumId: s.album_id || ''
  }), track);
  if (!hit || !hit.hash) return null;

  const cands = await request(
    `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=${encodeURIComponent(hit.name + ' - ' + hit.artist)}` +
    `&duration=${Math.round(hit.dur * 1000)}&hash=${encodeURIComponent(hit.hash)}`,
    { headers: { Referer: 'https://www.kugou.com/' } });
  const cand = (cands?.candidates || [])[0];
  if (!cand || !cand.id) return null;

  const dl = await request(
    `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(cand.id)}` +
    `&accesskey=${encodeURIComponent(cand.accesskey)}&fmt=lrc&charset=utf8`,
    { headers: { Referer: 'https://www.kugou.com/' } });
  const raw = Buffer.from(String(dl?.content || ''), 'base64').toString('utf8');
  const lines = stripCredits(parseLrc(raw));
  if (!lines.length) return null;
  const cover = hit.albumId
    ? `https://imge.kugou.com/stdmusic/480/${hit.albumId}.jpg` : null;
  return normalise({
    provider: '酷狗音乐', source: 'kugou-lrc', platformId: 'kugou',
    wordSync: false, synced: true, lines, cover,
    title: hit.name, artist: hit.artist
  });
}

/* ------------------------------------------------------ iTunes / Apple Music */

/** Apple Music has no public lyric endpoint. iTunes Search gives real metadata + artwork
 *  (public, no auth), which we use for Apple Music sessions and for cover fallbacks. */
async function itunesMeta(track) {
  const term = [cleanTitle(track.title), cleanArtist(track.artist)].filter(Boolean).join(' ');
  if (!term) return null;
  for (const country of ['us', 'hk', 'tw', 'jp']) {
    try {
      const j = await request(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5&country=${country}`,
        { headers: { Accept: 'application/json' } });
      const hit = pickBest(j?.results, (r) => ({
        name: r.trackName,
        id: r.trackId,
        dur: Math.round((Number(r.trackTimeMillis) || 0) / 1000),
        artist: r.artistName || '',
        album: r.collectionName || '',
        cover: (r.artworkUrl100 || '').replace('100x100bb', '600x600bb')
      }), track);
      if (hit) return hit;
    } catch { /* try next storefront */ }
  }
  return null;
}

/* --------------------------------------------------------------- Spotify */

let spotifyToken = null;   // { token, exp }
/**
 * Spotify Web API (client credentials). Users bring their OWN app credentials in the
 * settings page — we never ship a shared secret. Grants catalogue search + playlist
 * metadata; playback itself is controlled through SMTC like every other client.
 */
async function spotifyTokenFor(id, secret) {
  if (!id || !secret) return null;
  const now = Date.now();
  if (spotifyToken && spotifyToken.id === id && spotifyToken.exp > now + 30000) return spotifyToken.token;
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('spotify-token-' + res.status);
  const j = await res.json();
  spotifyToken = { id, token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  return spotifyToken.token;
}

async function spotifySearch(query, creds) {
  const token = await spotifyTokenFor(creds?.clientId, creds?.clientSecret);
  if (!token) return [];
  const j = await request(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } });
  return (j?.tracks?.items || []).map((t) => ({
    platform: 'spotify', id: t.id,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join('/'),
    album: t.album?.name || '',
    duration: Math.round((Number(t.duration_ms) || 0) / 1000),
    cover: t.album?.images?.[0]?.url || null
  }));
}

/** Spotify as a LYRIC provider: no public lyrics API, so metadata only. Returning null
 *  lets fetchLyrics fall through to LRCLIB / Netease / QQ for the same song. */
async function spotify(track) {
  return null;
}

/* --------------------------------------------------------- song search (pick page) */

/**
 * Search songs on a platform for the "选歌" page. Text + album art only; playback is
 * handed back to the platform's own client (URL scheme + clipboard fallback in main.js).
 * @returns [{platform, id, title, artist, album, duration, cover}]
 */
async function searchSongs(query, platform, creds) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (platform === 'netease') {
    const j = await request(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&limit=15`,
      { headers: { Referer: 'https://music.163.com' } });
    return (j?.result?.songs || []).map((s) => ({
      platform: 'netease', id: s.id,
      title: s.name,
      artist: (s.artists || []).map((x) => x.name).join('/'),
      album: s.album?.name || '',
      duration: Math.round((Number(s.duration) || 0) / 1000),
      cover: null    // filled lazily per row is too chatty; cover shown only in the play card
    }));
  }
  if (platform === 'kugou') {
    const j = await request(
      `https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(q)}&page=1&pagesize=15&showtype=1`,
      { headers: { Referer: 'https://www.kugou.com/' } });
    return (j?.data?.info || []).map((s) => ({
      platform: 'kugou', id: s.hash,
      title: s.songname,
      artist: s.singername || '',
      album: s.album_name || '',
      duration: Number(s.duration) || 0,
      cover: s.album_id ? `https://imge.kugou.com/stdmusic/240/${s.album_id}.jpg` : null
    }));
  }
  if (platform === 'qishui') {
    // Qishui (ByteDance Soda Music) has no public catalogue API; its library overlaps
    // heavily with Netease for Chinese tracks, so we search there and hand playback back
    // to the Qishui client (title copied to clipboard).
    const j = await request(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&limit=15`,
      { headers: { Referer: 'https://music.163.com' } });
    return (j?.result?.songs || []).map((s) => ({
      platform: 'qishui', id: s.id,
      title: s.name,
      artist: (s.artists || []).map((x) => x.name).join('/'),
      album: s.album?.name || '',
      duration: Math.round((Number(s.duration) || 0) / 1000),
      cover: (s.album && s.album.picUrl) ? `${s.album.picUrl}?param=240y240` : null,
      matchedVia: 'netease'
    }));
  }
  if (platform === 'applemusic') {
    const j = await request(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=15&country=us`,
      { headers: { Accept: 'application/json' } });
    return (j?.results || []).map((r) => ({
      platform: 'applemusic', id: r.trackId,
      title: r.trackName,
      artist: r.artistName || '',
      album: r.collectionName || '',
      duration: Math.round((Number(r.trackTimeMillis) || 0) / 1000),
      cover: (r.artworkUrl100 || '').replace('100x100bb', '240x240bb')
    }));
  }
  if (platform === 'spotify') {
    return spotifySearch(q, creds);
  }
  // default: QQ Music
  const j = await request(
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=15&w=${encodeURIComponent(q)}&format=json`,
    { headers: { Referer: 'https://y.qq.com/' } });
  return (j?.data?.song?.list || []).map((s) => ({
    platform: 'qqmusic', id: s.songmid,
    title: s.songname,
    artist: (s.singer || []).map((x) => x.name).join('/'),
    album: s.albumname || '',
    duration: Number(s.interval) || 0,
    cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R68x68M000${s.albummid}.jpg` : null
  }));
}

module.exports = {
  qqmusic, netease, lrclib, kugou, spotify, spotifySearch, itunesMeta, searchSongs,
  parseLrc, parseYrc, plainToLines, attachTranslations, stripCredits,
  cleanTitle, cleanArtist, fold, pickBest
};
