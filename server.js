'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const { createStorage } = require('./lib/storage');
const { createStore } = require('./lib/store');
const { createAuth, canSeeFamily } = require('./lib/auth');
const { receive } = require('./lib/upload');
const { streamArchive } = require('./lib/archive');
const { classify, cleanText, safeFileName } = require('./lib/media');

const config = {
  port: Number(process.env.PORT) || 3000,
  adminCode: (process.env.ADMIN_CODE || '').trim(),
  familyCode: (process.env.FAMILY_CODE || '').trim(),
  maxFileMB: Number(process.env.MAX_FILE_MB) || 2048,
  defaultName: (process.env.PERSON_NAME || 'רני אלון').trim(),
};
const MAX_FILE_BYTES = config.maxFileMB * 1024 * 1024;

const storage = createStorage(process.env);
const store = createStore(storage, { name: config.defaultName });
const auth = createAuth({
  adminCode: config.adminCode, familyCode: config.familyCode, secret: process.env.SESSION_SECRET,
});

const newId = () => crypto.randomBytes(12).toString('base64url');
const sizeLabel = (mb) => (mb >= 1024 ? `${Math.round(mb / 1024 * 10) / 10}GB` : `${mb}MB`);
const tooLargeMessage = `קובץ גדול מדי. הגודל המרבי לקובץ: ${sizeLabel(config.maxFileMB)}.`;

// ---------- helpers ----------

const canSee = (req, post) => post.visibility === 'public' || canSeeFamily(req.role);

function serializePost(post) {
  return {
    id: post.id,
    createdAt: post.createdAt,
    name: post.name,
    text: post.text,
    visibility: post.visibility,
    files: post.files.map((f) => ({
      id: f.id,
      type: f.type,
      mime: f.mime,
      name: f.name,
      size: f.size,
      url: `/media/${post.id}/${f.id}`,
      previewUrl: f.previewKey ? `/media/${post.id}/${f.id}/preview` : null,
    })),
  };
}

function publicSettings() {
  const s = store.settings();
  return {
    name: s.name,
    subtitle: s.subtitle,
    coverUrl: s.cover ? `/cover?v=${s.cover.v}` : null,
  };
}

const keysOf = (post) => post.files.flatMap((f) => [f.key, f.previewKey].filter(Boolean));

function requireRole(check) {
  return (req, res, next) => (check(req.role) ? next() : res.status(403).json({ error: 'אין הרשאה' }));
}
const requireAdmin = requireRole((r) => r === 'admin');
const requireFamily = requireRole(canSeeFamily);

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
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

// index.html with the name, photo and Open Graph tags filled in (so links
// shared on WhatsApp etc. show the name and photo).
const indexTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const assetVersion = crypto.createHash('sha1')
  .update(fs.readFileSync(path.join(__dirname, 'public', 'app.js')))
  .update(fs.readFileSync(path.join(__dirname, 'public', 'style.css')))
  .digest('hex').slice(0, 10);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function renderIndex(req) {
  const s = publicSettings();
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

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex(req));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '7d' }));

app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    role: req.role,
    loginEnabled: auth.enabled,
    maxFileMB: config.maxFileMB,
    settings: publicSettings(),
    posts: store.posts().filter((p) => canSee(req, p)).map(serializePost),
  });
});

// ----- media -----

async function sendMedia(req, res, preview) {
  const post = store.get(req.params.postId);
  const file = post && post.files.find((f) => f.id === req.params.fileId);
  if (!file || !canSee(req, post) || (preview && !file.previewKey)) return res.status(404).end();
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (preview) return storage.send(req, res, file.previewKey, 'image/jpeg');
  return storage.send(req, res, file.key, file.mime);
}
app.get('/media/:postId/:fileId', (req, res) => sendMedia(req, res, false));
app.get('/media/:postId/:fileId/preview', (req, res) => sendMedia(req, res, true));

app.get('/cover', async (req, res) => {
  const cover = store.settings().cover;
  if (!cover) return res.status(404).end();
  try {
    const stream = await storage.openRead(cover.key);
    res.set('Content-Type', cover.mime);
    res.set('Cache-Control', 'public, max-age=86400');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.status(404).end();
  }
});

// ----- posts -----

app.post('/api/posts', rateLimit({ windowMs: 60 * 60 * 1000, max: 300 }), async (req, res) => {
  const postId = newId();
  const files = [];

  const result = await receive(req, storage, {
    fileSize: MAX_FILE_BYTES,
    maxFiles: 80,
    tooLargeMessage,
    onFile(field, stream, info, ctx) {
      if (field === 'file') {
        const kind = classify(info.mimeType, info.filename);
        if (!kind) {
          ctx.fail(415, `סוג הקובץ לא נתמך: ${safeFileName(info.filename, '')}`.trim());
          stream.resume();
          return;
        }
        const meta = {
          id: newId(), key: '', type: kind.type, mime: kind.mime,
          name: safeFileName(info.filename, `file${kind.ext}`), size: 0, previewKey: null,
        };
        meta.key = `media/${postId}/${meta.id}${kind.ext}`;
        files.push(meta);
        ctx.save(stream, meta.key, meta.mime).then((size) => { meta.size = size; }, () => {});
        return;
      }
      // A smaller JPEG made in the browser: image preview or video poster.
      const m = /^preview_(\d+)$/.exec(field);
      const target = m && files[Number(m[1])];
      if (target && !target.previewKey && target.type !== 'audio' && /^image\/jpeg$/i.test(info.mimeType)) {
        target.previewKey = `media/${postId}/${target.id}.preview.jpg`;
        ctx.save(stream, target.previewKey, 'image/jpeg').catch(() => {});
        return;
      }
      stream.resume();
    },
  });

  const name = cleanText(result.fields.name, 80);
  const text = cleanText(result.fields.text, 20000);
  const visibility = result.fields.visibility === 'family' ? 'family' : 'public';
  let error = result.error;
  if (!error && !text && files.length === 0) error = { status: 400, message: 'נא להוסיף טקסט או קובץ.' };

  if (error) {
    storage.remove(result.keys).catch(() => {});
    return res.status(error.status).json({ error: error.message });
  }

  const post = { id: postId, createdAt: new Date().toISOString(), name, text, visibility, files };
  try {
    await store.addPost(post);
  } catch (err) {
    console.error('Could not save post:', err);
    storage.remove(result.keys).catch(() => {});
    return res.status(500).json({ error: 'השמירה נכשלה. נסו שוב.' });
  }
  res.status(201).json({ post: serializePost(post) });
});

app.patch('/api/posts/:id', requireAdmin, express.json({ limit: '4kb' }), async (req, res) => {
  const post = store.get(req.params.id);
  if (!post) return res.status(404).json({ error: 'לא נמצא' });
  const visibility = req.body?.visibility === 'family' ? 'family' : 'public';
  const updated = await store.updatePost(post.id, { visibility });
  res.json({ post: serializePost(updated) });
});

app.delete('/api/posts/:id', requireAdmin, async (req, res) => {
  const post = store.get(req.params.id);
  if (!post) return res.status(404).json({ error: 'לא נמצא' });
  await store.removePost(post.id);
  storage.remove(keysOf(post)).catch((err) => console.error('Could not delete files:', err));
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

// ----- page settings (admin) -----

app.post('/api/settings', requireAdmin, express.json({ limit: '8kb' }), async (req, res) => {
  const name = cleanText(req.body?.name, 120) || config.defaultName;
  const subtitle = cleanText(req.body?.subtitle, 200);
  await store.updateSettings({ name, subtitle });
  res.json({ settings: publicSettings() });
});

app.post('/api/cover', requireAdmin, async (req, res) => {
  let cover = null;
  const result = await receive(req, storage, {
    fileSize: 40 * 1024 * 1024,
    maxFiles: 1,
    tooLargeMessage: 'התמונה גדולה מדי.',
    onFile(field, stream, info, ctx) {
      const kind = field === 'cover' && classify(info.mimeType, info.filename);
      if (!kind || !['image/jpeg', 'image/png', 'image/webp'].includes(kind.mime)) {
        ctx.fail(415, 'נא לבחור תמונה בפורמט JPG או PNG.');
        stream.resume();
        return;
      }
      cover = { key: `cover/${newId()}${kind.ext}`, mime: kind.mime, v: Date.now() };
      ctx.save(stream, cover.key, cover.mime).catch(() => {});
    },
  });
  if (result.error || !cover) {
    storage.remove(result.keys).catch(() => {});
    return res.status(result.error?.status || 400).json({ error: result.error?.message || 'לא נבחרה תמונה.' });
  }
  const old = store.settings().cover;
  await store.updateSettings({ cover });
  if (old) storage.remove([old.key]).catch(() => {});
  res.json({ settings: publicSettings() });
});

app.delete('/api/cover', requireAdmin, async (req, res) => {
  const old = store.settings().cover;
  await store.updateSettings({ cover: null });
  if (old) storage.remove([old.key]).catch(() => {});
  res.json({ settings: publicSettings() });
});

// ----- download everything (family and admin) -----

app.get('/api/export', requireFamily, async (req, res) => {
  const settings = store.settings();
  const fileName = `${safeFileName(settings.name, 'memorial')}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="memorial.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.set('Cache-Control', 'no-store');
  try {
    await streamArchive(res, storage, store.posts(), settings);
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

// ---------- start ----------

async function start() {
  await storage.init();
  await store.load();
  if (!config.adminCode) console.warn('ADMIN_CODE is not set: nobody can delete posts or change the page.');
  if (!config.familyCode) console.warn('FAMILY_CODE is not set: family-only posts are visible to the admin only.');
  app.listen(config.port, () => {
    console.log(`Memorial site listening on port ${config.port} (storage: ${storage.description}, ${store.posts().length} posts)`);
  });
}

start().catch((err) => {
  console.error('Could not start:', err);
  process.exit(1);
});
