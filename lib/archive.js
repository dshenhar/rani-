'use strict';

// "Download everything": a zip with every post (oldest first), the original
// files, and an index.html that opens offline in any browser.

const archiver = require('archiver');
const { safeFileName } = require('./media');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function formatDate(iso) {
  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem',
  }).format(new Date(iso));
}

// Splits posts (oldest first) into downloads of roughly `partBytes` each, so a
// single download finishes well within the hosting time limit.
function splitIntoParts(postsOldestFirst, partBytes) {
  const parts = [];
  let current = null;
  postsOldestFirst.forEach((post, index) => {
    const size = post.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0) + post.text.length;
    if (!current || (current.size > 0 && current.size + size > partBytes)) {
      current = { firstIndex: index, posts: [], size: 0 };
      parts.push(current);
    }
    current.posts.push(post);
    current.size += size;
  });
  return parts;
}

function plan(posts, offset = 0) {
  return posts.map((post, i) => {
    const date = post.createdAt.slice(0, 10);
    const folder = [String(offset + i + 1).padStart(3, '0'), date, post.name ? safeFileName(post.name, '') : '']
      .filter(Boolean).join('_');
    const files = post.files.map((file, j) => {
      const ext = file.pathname.slice(file.pathname.lastIndexOf('.'));
      let name = safeFileName(file.name, `file${ext}`);
      if (!name.toLowerCase().endsWith(ext.toLowerCase()) && !/\.[a-z0-9]{2,5}$/i.test(name)) name += ext;
      return { file, path: `${folder}/${j + 1}_${name}` };
    });
    return { post, folder, files };
  });
}

function indexHtml(items, settings) {
  const body = items.map(({ post, files }) => {
    const meta = [post.name && `<strong>${escapeHtml(post.name)}</strong>`, escapeHtml(formatDate(post.createdAt)),
      post.visibility === 'family' && 'משפחה בלבד'].filter(Boolean).join(' · ');
    const text = post.text ? `<p class="text">${escapeHtml(post.text)}</p>` : '';
    const media = files.map(({ file, path }) => {
      const src = encodePath(path);
      if (file.type === 'image') return `<a href="${src}"><img src="${src}" alt=""></a>`;
      if (file.type === 'video') return `<video controls preload="metadata" src="${src}"></video><a class="file" href="${src}">${escapeHtml(file.name || 'video')}</a>`;
      return `<audio controls preload="metadata" src="${src}"></audio><a class="file" href="${src}">${escapeHtml(file.name || 'audio')}</a>`;
    }).join('\n');
    return `<article><div class="meta">${meta}</div>${text}${media}</article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(settings.name)}</title>
<style>
body{margin:0;background:#f6f4f0;color:#2a2826;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-weight:500;text-align:center;margin:0 0 4px}
.sub{text-align:center;color:#78736b;margin:0 0 32px}
.cover{display:block;margin:0 auto 20px;width:180px;aspect-ratio:4/5;object-fit:cover;border-radius:14px}
article{background:#fff;border:1px solid #e4dfd7;border-radius:14px;padding:18px;margin:0 0 18px}
.meta{color:#78736b;font-size:15px;margin-bottom:8px}.meta strong{color:#2a2826}
.text{white-space:pre-wrap;margin:0 0 12px}
img,video{display:block;max-width:100%;border-radius:10px;margin:10px 0 4px}
audio{width:100%;margin:10px 0 4px}
.file{font-size:14px;color:#78736b}
</style>
</head>
<body>
<main>
${settings.coverPath ? `<img class="cover" src="${encodePath(settings.coverPath)}" alt="">` : ''}
<h1>${escapeHtml(settings.name)}</h1>
${settings.subtitle ? `<p class="sub">${escapeHtml(settings.subtitle)}</p>` : '<p class="sub"></p>'}
${body}
</main>
</body>
</html>
`;
}

/** Streams one part (from splitIntoParts) as a zip to `res`. */
async function streamArchive(res, storage, part, settings, { includeCover }) {
  const items = plan(part.posts, part.firstIndex);
  const archive = archiver('zip', { store: true });
  let aborted = false;

  res.on('close', () => {
    if (!res.writableFinished) { aborted = true; archive.abort(); }
  });
  archive.on('warning', (err) => console.warn('Archive warning:', err));
  archive.on('error', (err) => { console.error('Archive error:', err); res.destroy(err); });
  archive.pipe(res);

  // Add one entry at a time so only one storage download is open at once.
  const add = (source, name, date) => new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      if (entry.name !== name) return;
      archive.off('entry', onEntry);
      archive.off('error', reject);
      resolve();
    };
    archive.on('entry', onEntry);
    archive.once('error', reject);
    archive.append(source, { name, date });
  });

  const missing = [];
  let coverPath = null;
  if (includeCover && settings.cover) {
    try {
      const ext = settings.cover.pathname.slice(settings.cover.pathname.lastIndexOf('.'));
      coverPath = `cover${ext}`;
      await add(await storage.openRead(settings.cover.pathname), coverPath, new Date());
    } catch {
      coverPath = null;
    }
  }

  for (const { post, folder, files } of items) {
    if (aborted) return;
    const date = new Date(post.createdAt);
    if (post.text) {
      const header = [post.name, formatDate(post.createdAt), post.visibility === 'family' ? 'משפחה בלבד' : '']
        .filter(Boolean).join('\n');
      await add(Buffer.from(`﻿${header}\n\n${post.text}\n`, 'utf8'), `${folder}/טקסט.txt`, date);
    }
    for (const { file, path } of files) {
      if (aborted) return;
      try {
        await add(await storage.openRead(file.pathname), path, date);
      } catch (err) {
        if (aborted) return;
        missing.push(path);
        console.error(`Archive: could not read ${file.pathname}:`, err.message);
      }
    }
  }

  if (aborted) return;
  const exported = items.map(({ post, files }) => ({
    name: post.name, date: post.createdAt, visibility: post.visibility, text: post.text,
    files: files.map((f) => f.path),
  }));
  await add(Buffer.from(indexHtml(items, { ...settings, coverPath }), 'utf8'), 'index.html', new Date());
  await add(Buffer.from(JSON.stringify(exported, null, 2), 'utf8'), 'data.json', new Date());
  if (missing.length) {
    await add(Buffer.from(`﻿קבצים שלא נמצאו:\n${missing.join('\n')}\n`, 'utf8'), 'missing.txt', new Date());
  }
  await archive.finalize();
}

module.exports = { streamArchive, splitIntoParts };
