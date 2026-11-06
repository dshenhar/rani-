'use strict';

// Which uploads are accepted, and how they are named on disk.

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  '3gp': 'video/3gpp', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', amr: 'audio/amr',
  flac: 'audio/flac', weba: 'audio/webm',
};

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg',
  'audio/webm': 'webm', 'audio/amr': 'amr', 'audio/flac': 'flac',
};

// Exact types allowed into storage (SVG is excluded on purpose: it can carry scripts).
const UPLOAD_TYPES = [...new Set(Object.values(EXT_MIME).concat(Object.keys(MIME_EXT)))].sort();

// SVG can carry scripts, so it is never accepted.
const BLOCKED = new Set(['image/svg+xml']);
const MIME_RE = /^(image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/;

function normalizeMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function extOf(filename) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Returns { type: 'image'|'video'|'audio', mime, ext } or null when the file
 * is not a photo, video or audio file.
 */
function classify(mimeType, filename) {
  let mime = normalizeMime(mimeType);
  const ext = extOf(filename);
  if (!MIME_RE.test(mime) || BLOCKED.has(mime)) {
    mime = EXT_MIME[ext] || '';
  }
  if (!mime || BLOCKED.has(mime)) return null;
  const type = mime.split('/')[0];
  if (type !== 'image' && type !== 'video' && type !== 'audio') return null;
  const finalExt = (EXT_MIME[ext] && EXT_MIME[ext].split('/')[0] === type) ? ext : (MIME_EXT[mime] || 'bin');
  return { type, mime, ext: '.' + finalExt };
}

function cleanText(value, max) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** File name safe for zip entries and Content-Disposition. */
function safeFileName(name, fallback = 'file') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001F\u007F/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

module.exports = { classify, normalizeMime, cleanText, safeFileName, extOf, UPLOAD_TYPES, EXT_MIME };
