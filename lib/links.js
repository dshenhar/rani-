'use strict';

// Links in a memory. YouTube links become embedded videos; anything else is
// shown as a plain link.

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** "90", "90s", "1m30s", "1h2m3s" → seconds (0 when absent or odd). */
function parseStart(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
}

/** { videoId, start } for a YouTube video address, otherwise null. */
function youtubeInfo(url) {
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  let id = null;
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    id = url.pathname.split('/')[1];
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
    id = m && m[1];
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  return { videoId: id, start: parseStart(url.searchParams.get('t') || url.searchParams.get('start')) };
}

/** Accepts only http(s) addresses of reasonable length. Returns a URL or null. */
function parseUrl(raw) {
  let text = String(raw || '').trim();
  if (!text || text.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Validates links sent by the browser: [{ id?, url, caption? }].
 * Returns null when any of them is not a web address.
 */
function parseLinks(input, { newId, cleanText, captionMax }) {
  const links = [];
  for (const l of Array.isArray(input) ? input.slice(0, 20) : []) {
    const url = parseUrl(l && l.url);
    if (!url) return null;
    const yt = youtubeInfo(url);
    links.push({
      id: typeof l.id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(l.id) ? l.id : newId(),
      url: url.href,
      kind: yt ? 'youtube' : 'web',
      videoId: yt ? yt.videoId : null,
      start: yt ? yt.start : 0,
      caption: cleanText(l.caption, captionMax),
    });
  }
  return links;
}

module.exports = { parseLinks, youtubeInfo, parseUrl };
