'use strict';

// Runs on Vercel (exported Express app) or locally (`npm start`).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const { createStorage } = require('./lib/storage');
const { createDb } = require('./lib/db');
const { createAuth, canSeeFamily, parseCookies } = require('./lib/auth');
const { streamArchive, splitIntoParts } = require('./lib/archive');
const { classify, cleanText, safeFileName, UPLOAD_TYPES } = require('./lib/media');
const { heicToJpeg, isHeic } = require('./lib/heic');

// Lets work finish after the response on Vercel (no-op elsewhere).
let waitUntil = (promise) => promise;
try { ({ waitUntil } = require('@vercel/functions')); } catch { /* not installed */ }

const config = {
  port: Number(process.env.PORT) || 3000,
  adminCode: (process.env.ADMIN_CODE || '').trim(),
  familyCode: (process.env.FAMILY_CODE || '').trim(),
  maxFileMB: Number(process.env.MAX_FILE_MB) || 1024,
  defaultName: (process.env.PERSON_NAME || 'רני אלון').trim(),
  exportPartMB: Number(process.env.EXPORT_PART_MB) || 250,
};
const MAX_FILE_BYTES = config.maxFileMB * 1024 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// The Neon integration may add a prefix to its variables (e.g. STORAGE_DATABASE_URL).
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL
  || Object.entries(process.env).find(([k, v]) => /(^|_)(DATABASE_URL|POSTGRES_URL)$/.test(k) && v)?.[1];
// Until the deployment is fully configured the site shows what is missing
// instead of failing (see setupPage below).
const setupProblems = [];
if (!databaseUrl) setupProblems.push('db');
const db = databaseUrl ? createDb({ connectionString: databaseUrl, defaultName: config.defaultName }) : null;
let storage;
try {
  storage = createStorage(process.env, { db });
} catch (err) {
  console.error('Storage settings:', err.message);
  setupProblems.push('storage-config');
  storage = { kind: 'none', description: 'not configured' };
}
if (process.env.VERCEL && storage.kind === 'local') setupProblems.push('storage');
if (storage.oauth && !process.env.GOOGLE_OAUTH_CLIENT_SECRET) setupProblems.push('oauth-secret');
if (!config.adminCode) setupProblems.push('admin-code');
const auth = createAuth({
  adminCode: config.adminCode, familyCode: config.familyCode, secret: process.env.SESSION_SECRET,
});

const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const newId = () => crypto.randomBytes(12).toString('base64url');

// Upload paths the browser may ask for:
//   media/<16-char draft id>/<n>.<ext>          a file of a new post
//   media/<16-char draft id>/<n>.preview.jpg    its smaller copy / video poster
//   cover/<16-char id>.<jpg|png|webp>            the portrait (admin only)
const MEDIA_PATH_RE = /^media\/([A-Za-z0-9_-]{16})\/(\d{1,3})(\.preview\.jpg|\.[a-z0-9]{1,5})$/;
const COVER_PATH_RE = /^cover\/[A-Za-z0-9_-]{16}\.(jpg|png|webp)$/;

function uploadRules(pathname, role) {
  const media = MEDIA_PATH_RE.exec(pathname);
  if (media) {
    return media[3] === '.preview.jpg'
      ? { contentTypes: ['image/jpeg'], maxBytes: 20 * 1024 * 1024 }
      : { contentTypes: UPLOAD_TYPES, maxBytes: MAX_FILE_BYTES };
  }
  if (COVER_PATH_RE.test(pathname) && role === 'admin') {
    return { contentTypes: COVER_TYPES, maxBytes: 40 * 1024 * 1024 };
  }
  throw Object.assign(new Error('Upload path not allowed'), { status: 403 });
}

// ---------- helpers ----------

// Whoever posted a memory gets its key in a cookie (set by the server, so iPhones keep it).
const KEYS_COOKIE = 'memorial_keys';
const MAX_KEYS = 40;

function readAuthorKeys(req) {
  const keys = new Map();
  for (const pair of String(parseCookies(req.headers.cookie)[KEYS_COOKIE] || '').split('.')) {
    const [id, key] = pair.split('~');
    if (ID_RE.test(id || '') && /^[A-Za-z0-9_-]{20,64}$/.test(key || '')) keys.set(id, key);
  }
  return keys;
}

function writeAuthorKeys(req, res, keys) {
  const value = [...keys].slice(-MAX_KEYS).map(([id, key]) => `${id}~${key}`).join('.');
  res.cookie(KEYS_COOKIE, value, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 400 * 24 * 3600 * 1000, path: '/',
  });
}

const canSee = (req, post) => post.visibility === 'public' || canSeeFamily(req.role) || isAuthor(req, post);

// iPhone photos get a JPEG copy made on the server (see ensureHeicPreview).
const hasPreview = (f) => Boolean(f.previewPathname) || (f.type === 'image' && isHeic(f.mime));
const fileIndex = (f) => Number(MEDIA_PATH_RE.exec(f.pathname)?.[2] ?? -1);
// Index for the next file added to a post; never reused, so storage paths stay unique.
const nextIndexOf = (post) => post.storage?.nextIndex ?? Math.max(-1, ...post.files.map(fileIndex)) + 1;

function serializePost(post, req) {
  return {
    id: post.id,
    canEdit: canEdit(req, post),
    createdAt: post.createdAt,
    name: post.name,
    text: post.text,
    visibility: post.visibility,
    nextIndex: nextIndexOf(post),
    files: post.files.map((f) => ({
      id: f.id,
      type: f.type,
      mime: f.mime,
      name: f.name,
      size: f.size,
      url: `/media/${post.id}/${f.id}`,
      previewUrl: hasPreview(f) ? `/media/${post.id}/${f.id}/preview` : null,
    })),
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function keyMatches(key, post) {
  if (!key || !post.editHash) return false;
  const given = Buffer.from(sha256(key), 'hex');
  const expected = Buffer.from(post.editHash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** True for the browser that posted it (it holds the post's key). */
function isAuthor(req, post) {
  req.authorKeys ??= readAuthorKeys(req);
  return keyMatches(req.authorKeys.get(post.id), post);
}

/** The admin, or whoever posted it, may change a post. */
const canEdit = (req, post) => req.role === 'admin' || isAuthor(req, post);

/** Upload rules, plus: files for an existing post may only come from someone who can edit it. */
async function checkUpload(req, pathname) {
  const rules = uploadRules(pathname, req.role);
  const media = MEDIA_PATH_RE.exec(pathname);
  if (media) {
    const post = await db.getPost(media[1]);
    if (post && !canEdit(req, post)) throw Object.assign(new Error('Not the author'), { status: 403 });
  }
  return rules;
}

/** Validates file descriptions sent by the browser after uploading to `media/<postId>/`. */
function parseFiles(input, postId, takenPathnames = new Set()) {
  const files = [];
  for (const f of Array.isArray(input) ? input.slice(0, 80) : []) {
    const m = MEDIA_PATH_RE.exec(String(f.pathname || ''));
    if (!m || m[1] !== postId || m[3] === '.preview.jpg' || takenPathnames.has(f.pathname)) return null;
    const kind = classify(f.mime, f.pathname);
    if (!kind) return null;
    let previewPathname = null;
    if (f.previewPathname) {
      const p = MEDIA_PATH_RE.exec(String(f.previewPathname));
      if (!p || p[1] !== postId || p[2] !== m[2] || p[3] !== '.preview.jpg' || kind.type === 'audio') return null;
      previewPathname = f.previewPathname;
    }
    files.push({
      id: newId(),
      pathname: f.pathname,
      previewPathname,
      type: kind.type,
      mime: kind.mime,
      name: safeFileName(f.name, `file${kind.ext}`),
      size: Math.max(0, Math.min(Number(f.size) || 0, MAX_FILE_BYTES)),
    });
  }
  return files;
}

async function streamToBuffer(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Too large to convert');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Makes (once) the JPEG copy of an iPhone photo that other browsers can show.
const converting = new Map();
function ensureHeicPreview(post, file) {
  if (file.previewPathname || file.type !== 'image' || !isHeic(file.mime) || !storage.putBuffer) {
    return Promise.resolve(file);
  }
  const key = `${post.id}/${file.id}`;
  if (!converting.has(key)) {
    converting.set(key, (async () => {
      const original = await streamToBuffer(await storage.openRead(refOf(file)), 60 * 1024 * 1024);
      const jpeg = await heicToJpeg(original);
      const previewPathname = `media/${post.id}/${fileIndex(file)}.preview.jpg`;
      const previewRef = await storage.putBuffer(previewPathname, jpeg, 'image/jpeg');
      await db.updateFile(post.id, file.id, { previewPathname, previewRef });
      return { ...file, previewPathname, previewRef };
    })().finally(() => converting.delete(key)));
  }
  return converting.get(key);
}

function convertInBackground(post) {
  const work = Promise.all(post.files.map((f) => ensureHeicPreview(post, f)))
    .catch((err) => console.error('HEIC conversion failed:', err.message));
  try { waitUntil(work); } catch { /* not on Vercel */ }
}

const publicSettings = (s) => ({
  name: s.name,
  subtitle: s.subtitle,
  coverUrl: s.cover ? `/cover?v=${s.cover.v}` : null,
});

// Where a file lives in storage: a Drive file id, or the upload path for Blob/disk.
const refOf = (f) => f.ref || f.pathname;
const previewRefOf = (f) => f.previewRef || f.previewPathname;
const refsOf = (post) => post.files.flatMap((f) => [refOf(f), f.previewPathname && previewRefOf(f)].filter(Boolean));

function requireRole(check) {
  return (req, res, next) => (check(req.role) ? next() : res.status(403).json({ error: 'אין הרשאה' }));
}
const requireAdmin = requireRole((r) => r === 'admin');
const requireFamily = requireRole(canSeeFamily);

// Per server instance only (Vercel may run several); enough to slow down abuse.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    let entry = hits.get(req.ip);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: 'יותר מדי בקשות. נסו שוב בעוד כמה דקות.' });
    next();
  };
}

// The page, with name, portrait and link-preview tags filled in on the server.
const indexTemplate = require('./lib/page');
const assetVersion = (() => {
  // Changes whenever app.js / style.css change, so browsers fetch the new ones.
  try {
    return crypto.createHash('sha1')
      .update(fs.readFileSync(path.join(__dirname, 'public', 'app.js')))
      .update(fs.readFileSync(path.join(__dirname, 'public', 'style.css')))
      .digest('hex').slice(0, 10);
  } catch {
    return (process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || String(Date.now())).slice(0, 10);
  }
})();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function renderIndex(req, settings) {
  const s = publicSettings(settings);
  const origin = `${req.protocol}://${req.get('host')}`;
  const ogImage = s.coverUrl ? `<meta property="og:image" content="${escapeHtml(origin + s.coverUrl)}">` : '';
  return indexTemplate
    .replaceAll('{{NAME}}', escapeHtml(s.name))
    .replaceAll('{{SUBTITLE}}', escapeHtml(s.subtitle || ''))
    .replace('{{SUBTITLE_HIDDEN}}', s.subtitle ? '' : 'hidden')
    .replace('{{COVER}}', s.coverUrl ? `src="${escapeHtml(s.coverUrl)}"` : 'hidden')
    .replace('{{OG_IMAGE}}', ogImage)
    .replaceAll('{{V}}', assetVersion);
}

// ---------- app ----------

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(auth.middleware);

app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: setupProblems.length === 0, problems: setupProblems, storage: storage.kind });
});

const SETUP_MESSAGES = {
  db: 'אין חיבור למסד הנתונים. ב-Vercel: Storage → Neon → Connect Project.',
  storage: 'לא הוגדר אחסון לקבצים. צריך להוסיף GOOGLE_DRIVE_FOLDER_ID, GOOGLE_OAUTH_CLIENT_ID ו-GOOGLE_OAUTH_CLIENT_SECRET.',
  'storage-config': 'הגדרות האחסון לא תקינות. הפרטים מופיעים ב-Logs של Vercel.',
  'oauth-secret': 'חסר GOOGLE_OAUTH_CLIENT_SECRET.',
  'admin-code': 'חסר ADMIN_CODE.',
};

function setupPage(problems) {
  const items = problems.map((p) => `<li>${escapeHtml(SETUP_MESSAGES[p] || p)}</li>`).join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>הגדרה</title><style>body{font:17px/1.7 system-ui,sans-serif;background:#f6f4f0;color:#2a2826;margin:0}
main{max-width:560px;margin:12vh auto;padding:0 16px}li{margin:8px 0}p{color:#78736b}</style></head>
<body><main><h1>האתר עוד לא מוגדר עד הסוף</h1><ul>${items}</ul>
<p>אחרי שמוסיפים משתנים ב-Vercel: Deployments → ⋯ → Redeploy.</p></main></body></html>`;
}

if (setupProblems.length) {
  console.error('Setup incomplete:', setupProblems.join(', '));
  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') return res.status(503).type('html').send(setupPage(setupProblems));
    if (req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path === '/cover') {
      return res.status(503).json({ error: 'האתר עוד לא מוגדר.' });
    }
    next();
  });
}

app.get(['/', '/index.html'], async (req, res) => {
  const settings = await db.getSettings();
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex(req, settings));
});

// On Vercel the CDN serves public/; this is for local runs.
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '7d' }));

app.get('/api/state', async (req, res) => {
  const [settings, posts, drive] = await Promise.all([
    db.getSettings(),
    db.listPosts({ includeFamily: canSeeFamily(req.role), alsoIds: [...readAuthorKeys(req).keys()] }),
    req.role === 'admin' && storage.oauth ? storage.oauth.status() : null,
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    role: req.role,
    loginEnabled: auth.enabled,
    maxFileMB: config.maxFileMB,
    uploadMode: storage.uploadMode,
    chunkSize: storage.chunkSize || null,
    uploadTypes: UPLOAD_TYPES,
    settings: publicSettings(settings),
    posts: posts.filter((p) => canSee(req, p)).map((p) => serializePost(p, req)),
    drive, // admin only: is a Google account connected for the files?
  });
});

// ----- uploads (browser → storage directly) -----

const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 1500 });

app.post('/api/upload', uploadLimiter, express.json({ limit: '64kb' }), async (req, res) => {
  if (!storage.handleUploadRequest) return res.status(404).json({ error: 'לא נמצא' });
  try {
    const result = await storage.handleUploadRequest(req, {
      authorize: (pathname) => checkUpload(req, pathname),
    });
    res.json(result);
  } catch (err) {
    if (err.status !== 403) console.error('Upload permission failed:', err);
    res.status(err.status || 400).json({ error: 'ההעלאה נכשלה. נסו שוב.' });
  }
});

app.put('/api/local-upload', uploadLimiter, async (req, res) => {
  if (!storage.saveUpload) return res.status(404).json({ error: 'לא נמצא' });
  const pathname = String(req.query.pathname || '');
  let rules;
  try {
    rules = await checkUpload(req, pathname);
  } catch {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!rules.contentTypes.includes(mime)) return res.status(415).json({ error: 'סוג הקובץ לא נתמך.' });
  try {
    res.json({ pathname: await storage.saveUpload(req, pathname, rules.maxBytes) });
  } catch (err) {
    if (!req.complete && !err.status) return; // visitor left mid-upload
    res.status(err.status === 413 ? 413 : err.status === 409 ? 409 : 500).json({ error: 'ההעלאה נכשלה. נסו שוב.' });
  }
});

// Google Drive: the browser sends files in chunks through the server.
app.post('/api/upload/start', uploadLimiter, express.json({ limit: '8kb' }), async (req, res) => {
  if (!storage.startUpload) return res.status(404).json({ error: 'לא נמצא' });
  const { pathname, contentType, size, name } = req.body || {};
  let rules;
  try {
    rules = await checkUpload(req, String(pathname || ''));
  } catch {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!rules.contentTypes.includes(mime)) return res.status(415).json({ error: 'סוג הקובץ לא נתמך.' });
  const total = Number(size);
  if (!Number.isInteger(total) || total <= 0) return res.status(400).json({ error: 'הקובץ ריק.' });
  if (total > rules.maxBytes) return res.status(413).json({ error: 'קובץ גדול מדי.' });
  try {
    await storage.startUpload({ pathname, mime, total, name: safeFileName(name, pathname.split('/').pop()) });
    res.json({ chunkSize: storage.chunkSize });
  } catch (err) {
    console.error('Upload start failed:', err.message);
    res.status(err.status === 409 ? 409 : 502).json({ error: 'ההעלאה נכשלה. נסו שוב.' });
  }
});

app.put('/api/upload/chunk', uploadLimiter, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  if (!storage.putChunk) return res.status(404).json({ error: 'לא נמצא' });
  const offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0 || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'בקשה לא תקינה' });
  }
  try {
    res.json(await storage.putChunk({ pathname: String(req.query.pathname || ''), offset, data: req.body }));
  } catch (err) {
    console.error('Upload chunk failed:', err.message);
    res.status(err.status && err.status < 500 ? err.status : 502).json({ error: 'ההעלאה נכשלה. נסו שוב.' });
  }
});

// ----- media -----

async function sendMedia(req, res, preview) {
  const post = await db.getPost(req.params.postId);
  let file = post && post.files.find((f) => f.id === req.params.fileId);
  if (!file || !canSee(req, post) || (preview && !hasPreview(file))) return res.status(404).end();
  if (preview && !file.previewPathname) {
    try {
      file = await ensureHeicPreview(post, file);
    } catch (err) {
      console.error('HEIC conversion failed:', err.message);
      return res.status(404).end();
    }
  }
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (preview) return storage.send(req, res, previewRefOf(file), 'image/jpeg');
  return storage.send(req, res, refOf(file), file.mime);
}
app.get('/media/:postId/:fileId', (req, res) => sendMedia(req, res, false));
app.get('/media/:postId/:fileId/preview', (req, res) => sendMedia(req, res, true));

app.get('/cover', async (req, res) => {
  const { cover } = await db.getSettings();
  if (!cover) return res.status(404).end();
  try {
    const stream = await storage.openRead(cover.ref || cover.pathname);
    res.set('Content-Type', cover.mime);
    // Versioned URL (?v=), so the CDN may keep it; link previews fetch it without signing in.
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=31536000');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.status(404).end();
  }
});

// ----- posts -----

app.post('/api/posts', rateLimit({ windowMs: 60 * 60 * 1000, max: 300 }), express.json({ limit: '256kb' }), async (req, res) => {
  const body = req.body || {};
  const draftId = String(body.draftId || '');
  if (!ID_RE.test(draftId)) return res.status(400).json({ error: 'בקשה לא תקינה' });

  const name = cleanText(body.name, 80);
  const text = cleanText(body.text, 20000);
  const visibility = body.visibility === 'family' ? 'family' : 'public';
  const files = parseFiles(body.files, draftId);
  if (!files) return res.status(400).json({ error: 'בקשה לא תקינה' });
  if (!text && files.length === 0) return res.status(400).json({ error: 'נא להוסיף טקסט או קובץ.' });

  if (await db.getPost(draftId)) return res.status(409).json({ error: 'הפריט כבר נשמר.' });
  const editKey = crypto.randomBytes(24).toString('base64url');
  const post = {
    id: draftId, createdAt: new Date().toISOString(), name, text, visibility, files,
    storage: { nextIndex: Math.max(-1, ...files.map(fileIndex)) + 1 },
    editHash: sha256(editKey),
  };
  if (storage.finalizePost) {
    try {
      await storage.finalizePost(post);
    } catch (err) {
      console.error('Could not file the post in storage:', err.message);
      return res.status(err.status === 400 ? 400 : 502).json({ error: 'השמירה נכשלה. נסו שוב.' });
    }
  }
  if (!(await db.insertPost(post))) return res.status(409).json({ error: 'הפריט כבר נשמר.' });
  const saved = await db.getPost(post.id);
  convertInBackground(saved);
  // The key lets this browser edit the post later; only its hash is stored.
  const keys = readAuthorKeys(req);
  keys.delete(post.id);
  keys.set(post.id, editKey);
  writeAuthorKeys(req, res, keys);
  req.authorKeys = keys;
  res.status(201).json({ post: serializePost(saved, req), editKey });
});

// Author (with the edit key) or admin: change text, name, visibility; add or remove files.
app.patch('/api/posts/:id', express.json({ limit: '256kb' }), async (req, res) => {
  const post = await db.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'לא נמצא' });
  if (!canEdit(req, post)) return res.status(403).json({ error: 'אין הרשאה' });
  const body = req.body || {};

  const next = { ...post, storage: { ...post.storage } };
  if ('name' in body) next.name = cleanText(body.name, 80);
  if ('text' in body) next.text = cleanText(body.text, 20000);
  if ('visibility' in body) next.visibility = body.visibility === 'family' ? 'family' : 'public';

  const removeIds = new Set(Array.isArray(body.removeFiles) ? body.removeFiles.map(String) : []);
  const removed = post.files.filter((f) => removeIds.has(f.id));
  const added = parseFiles(body.addFiles, post.id, new Set(post.files.map((f) => f.pathname)));
  if (!added || added.some((f) => fileIndex(f) < nextIndexOf(post))) return res.status(400).json({ error: 'בקשה לא תקינה' });
  next.files = [...post.files.filter((f) => !removeIds.has(f.id)), ...added];
  if (!next.text && next.files.length === 0) {
    return res.status(400).json({ error: 'לא נשאר טקסט או קובץ. אפשר למחוק את הזיכרון.' });
  }
  next.storage.nextIndex = Math.max(nextIndexOf(post), ...added.map((f) => fileIndex(f) + 1));

  try {
    if (added.length && storage.attachFiles) await storage.attachFiles(next, added);
  } catch (err) {
    console.error('Could not attach files:', err.message);
    return res.status(err.status === 400 ? 400 : 502).json({ error: 'השמירה נכשלה. נסו שוב.' });
  }
  if (storage.updatePostStorage) {
    try {
      next.storage = await storage.updatePostStorage(post, next);
    } catch (err) {
      console.error('Could not update the Drive folder:', err.message); // the site itself is still right
    }
  }
  const saved = await db.updatePost(post.id, next);
  if (removed.length) {
    const refs = removed.flatMap((f) => [refOf(f), f.previewPathname && previewRefOf(f)].filter(Boolean));
    await storage.remove(refs).catch((err) => console.error('Could not delete files:', err.message));
  }
  convertInBackground(saved);
  res.json({ post: serializePost(saved, req) });
});

// An edit link (?edit=POST~KEY) opened on another device: remember the key there too.
app.post('/api/claim', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }), express.json({ limit: '2kb' }), async (req, res) => {
  const id = String(req.body?.id || '');
  const key = String(req.body?.key || '');
  const post = ID_RE.test(id) ? await db.getPost(id) : null;
  if (!post || !keyMatches(key, post)) return res.status(404).json({ error: 'הקישור לעריכה לא תקין.' });
  const keys = readAuthorKeys(req);
  keys.delete(id);
  keys.set(id, key);
  writeAuthorKeys(req, res, keys);
  req.authorKeys = keys;
  res.json({ post: serializePost(post, req) });
});

app.delete('/api/posts/:id', async (req, res) => {
  const existing = await db.getPost(req.params.id);
  if (!existing) return res.status(404).json({ error: 'לא נמצא' });
  if (!canEdit(req, existing)) return res.status(403).json({ error: 'אין הרשאה' });
  const post = await db.deletePost(existing.id);
  if (!post) return res.status(404).json({ error: 'לא נמצא' });
  const removal = storage.removePost ? storage.removePost(post) : storage.remove(refsOf(post));
  await removal.catch((err) => console.error('Could not delete files:', err));
  const keys = readAuthorKeys(req);
  if (keys.delete(post.id)) writeAuthorKeys(req, res, keys);
  res.json({ ok: true });
});

// ----- access -----

app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 40 }), express.json({ limit: '2kb' }), (req, res) => {
  const role = auth.roleForCode(req.body?.code);
  if (!role) return res.status(401).json({ error: 'הקוד שגוי' });
  auth.setRole(req, res, role);
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  auth.clear(req, res);
  res.json({ ok: true });
});

// ----- connecting Google Drive (admin) -----

const OAUTH_COOKIE = 'memorial_google_state';
const redirectUriFor = (req) => process.env.GOOGLE_OAUTH_REDIRECT_URI
  || `${req.protocol}://${req.get('host')}/api/google/callback`;

app.get('/api/google/connect', requireAdmin, (req, res) => {
  if (!storage.oauth) return res.status(404).json({ error: 'לא נמצא' });
  const state = crypto.randomBytes(16).toString('base64url');
  res.cookie(OAUTH_COOKIE, state, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 15 * 60 * 1000, path: '/api/google',
  });
  res.redirect(storage.oauth.authUrl(state, redirectUriFor(req)));
});

app.get('/api/google/callback', async (req, res) => {
  const back = (result) => res.redirect(`/?drive=${result}`);
  const expected = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
  res.clearCookie(OAUTH_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api/google' });
  if (!storage.oauth) return back('error');
  if (req.role !== 'admin') return back('admin');
  if (!expected || req.query.state !== expected) return back('error');
  if (req.query.error || !req.query.code) return back('cancelled');
  try {
    const result = await storage.oauth.exchange(String(req.query.code), redirectUriFor(req));
    // Keep a working connection rather than replace it with an account that cannot use the folder.
    if (!(await storage.checkFolder(result.accessToken))) return back('folder');
    await storage.oauth.save(result);
    back('connected');
  } catch (err) {
    console.error('Connecting Google Drive failed:', err.message);
    back('error');
  }
});

// ----- page settings (admin) -----

app.post('/api/settings', requireAdmin, express.json({ limit: '8kb' }), async (req, res) => {
  const body = req.body || {};
  const changes = {
    name: cleanText(body.name, 120) || config.defaultName,
    subtitle: cleanText(body.subtitle, 200),
  };
  const old = (await db.getSettings()).cover;
  if (body.coverPathname) {
    const pathname = String(body.coverPathname);
    if (!COVER_PATH_RE.test(pathname)) return res.status(400).json({ error: 'בקשה לא תקינה' });
    const ext = pathname.slice(pathname.lastIndexOf('.') + 1);
    let ref = pathname;
    if (storage.resolveUpload) {
      try {
        ref = await storage.resolveUpload(pathname);
      } catch {
        return res.status(400).json({ error: 'העלאת התמונה לא הושלמה.' });
      }
    }
    changes.cover = { pathname, ref, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, v: Date.now() };
  } else if (body.removeCover) {
    changes.cover = null;
  }
  const settings = await db.updateSettings(changes);
  if (old && 'cover' in changes) storage.remove([old.ref || old.pathname]).catch(() => {});
  res.json({ settings: publicSettings(settings) });
});

// ----- download everything (family and admin), in parts -----

async function exportParts() {
  const posts = (await db.listPosts({ includeFamily: true })).reverse(); // oldest first
  const parts = splitIntoParts(posts, config.exportPartMB * 1024 * 1024);
  return parts.length ? parts : [{ firstIndex: 0, posts: [], size: 0 }];
}

app.get('/api/export', requireFamily, async (req, res) => {
  const parts = await exportParts();
  res.set('Cache-Control', 'no-store');
  res.json({
    parts: parts.map((p, i) => ({ number: i + 1, url: `/api/export/${i + 1}`, posts: p.posts.length, bytes: p.size })),
  });
});

app.get('/api/export/:part', requireFamily, async (req, res) => {
  const [parts, settings] = await Promise.all([exportParts(), db.getSettings()]);
  const n = Number(req.params.part);
  const part = parts[n - 1];
  if (!Number.isInteger(n) || !part) return res.status(404).json({ error: 'לא נמצא' });
  const base = safeFileName(settings.name, 'memorial');
  const fileName = parts.length > 1 ? `${base} - ${n} of ${parts.length}.zip` : `${base}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="memorial-${n}.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.set('Cache-Control', 'no-store');
  try {
    await streamArchive(res, storage, part, settings, { includeCover: n === 1 });
  } catch (err) {
    console.error('Export failed:', err);
    res.destroy(err);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'לא נמצא' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(err.status || 500).json({ error: 'אירעה שגיאה. נסו שוב.' });
});

if (!config.adminCode) console.warn('ADMIN_CODE is not set: nobody can delete posts or change the page.');
if (!config.familyCode) console.warn('FAMILY_CODE is not set: family-only posts are visible to the admin only.');

module.exports = app;

if (require.main === module) {
  Promise.all([storage.init?.(), db?.init()]).then(() => {
    app.listen(config.port, () => {
      console.log(`Memorial site on http://localhost:${config.port} (storage: ${storage.description})`);
    });
  }).catch((err) => {
    console.error('Could not start:', err);
    process.exit(1);
  });
}
