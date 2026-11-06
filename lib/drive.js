'use strict';

// Google Drive storage: everything goes into a folder in a Shared Drive, one
// subfolder per memory ("2026-11-06 – name") with the original files and a
// Google Doc holding the text, so the family can simply open the Drive.
//
// A service account (a member of the Shared Drive) does the work. Browsers send
// files to the server in 4MB chunks (the most a Vercel function accepts per
// request) and the server passes them on to a Drive resumable upload.
// Files stay private in Drive; the site streams them to visitors allowed to see them.

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// A browser cancelling a media request (e.g. skipping ahead in a video) is normal.
const ignoreClosed = (err) => { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; };

const FOLDER = 'application/vnd.google-apps.folder';
const CHUNK_SIZE = 4 * 1024 * 1024; // a multiple of 256KB, as Drive requires
const MAX_RANGE = 8 * 1024 * 1024; // largest piece streamed per media request

class DriveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseKey(raw) {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const key = JSON.parse(text);
  if (!key.client_email || !key.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key');
  return key;
}

function createTokenSource(env) {
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const { JWT } = require('google-auth-library');
    const key = parseKey(env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const client = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return { email: key.client_email, token: async () => (await client.getAccessToken()).token };
  }
  if (env.GOOGLE_API_BASE) return { email: 'test', token: async () => 'test-token' }; // local Drive stand-in for tests
  throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
}

const israelDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
const hebrewDate = (iso) => new Intl.DateTimeFormat('he-IL', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem',
}).format(new Date(iso));
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 150);

function folderName(post) {
  const parts = [israelDate(post.createdAt)];
  if (post.name) parts.push(cleanName(post.name));
  return parts.join(' – ') + (post.visibility === 'family' ? ' (משפחה בלבד)' : '');
}

function createDriveStorage(env, db) {
  const rootId = env.GOOGLE_DRIVE_FOLDER_ID.trim();
  const API = (env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '');
  const auth = createTokenSource(env);

  async function call(method, url, { json, body, headers = {}, expect = [200] } = {}) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${await auth.token()}`,
        ...(json ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });
    if (!expect.includes(res.status)) {
      const detail = await res.text().catch(() => '');
      throw new DriveError(res.status >= 500 ? 502 : res.status, `Drive ${method} ${url.split('?')[0]} → ${res.status} ${detail.slice(0, 300)}`);
    }
    return res;
  }

  async function createFolder(name, parent) {
    const res = await call('POST', '/drive/v3/files?supportsAllDrives=true&fields=id', {
      json: { name, mimeType: FOLDER, parents: [parent] },
    });
    return (await res.json()).id;
  }

  async function update(fileId, metadata, query = '') {
    await call('PATCH', `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true${query}`, { json: metadata });
  }

  // Deleting from the site moves things to the Drive trash (recoverable for 30 days).
  const trash = (fileId) => update(fileId, { trashed: true });

  // A folder the app keeps one of; its id is remembered in the database.
  async function appFolder(key, name, parent) {
    const existing = await db.kvGet(key);
    if (existing) return existing;
    const created = await createFolder(name, parent);
    const stored = await db.kvPutIfAbsent(key, created);
    if (stored !== created) await trash(created).catch(() => {}); // another request won the race
    return stored;
  }
  const stagingFolder = () => appFolder('drive:staging', '_העלאות שלא הושלמו', rootId);
  const siteFolder = () => appFolder('drive:site', '_קבצי אתר (לא למחוק)', rootId);
  const draftFolder = async (draftId) => appFolder(`drive:draft:${draftId}`, draftId, await stagingFolder());

  async function where(pathname, name) {
    let m = /^media\/([A-Za-z0-9_-]{16})\/(\d{1,3})\.preview\.jpg$/.exec(pathname);
    if (m) return { parent: await siteFolder(), name: `${m[1]}-${m[2]}-preview.jpg` };
    m = /^media\/([A-Za-z0-9_-]{16})\//.exec(pathname);
    if (m) return { parent: await draftFolder(m[1]), name };
    m = /^cover\/.*(\.[a-z]+)$/.exec(pathname);
    if (m) return { parent: await siteFolder(), name: `תמונה ראשית${m[1]}` };
    throw new DriveError(400, 'Unexpected path');
  }

  async function fileIdFor(pathname) {
    const up = await db.getUpload(pathname);
    if (!up || !up.fileId) throw new DriveError(400, `Upload not finished: ${pathname}`);
    return up.fileId;
  }

  async function download(fileId, range) {
    return call('GET', `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      headers: range ? { Range: range } : {},
      expect: [200, 206, 404, 416],
    });
  }

  return {
    kind: 'google-drive',
    uploadMode: 'chunked',
    chunkSize: CHUNK_SIZE,
    description: `Google Drive folder ${rootId} (as ${auth.email})`,

    async init() {},

    async startUpload({ pathname, mime, total, name }) {
      const target = await where(pathname, name);
      const res = await call('POST', '/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
        json: { name: target.name, parents: [target.parent] },
        headers: { 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(total) },
      });
      const sessionUri = res.headers.get('location');
      if (!sessionUri) throw new DriveError(502, 'Drive did not return an upload session');
      if (!(await db.startUpload(pathname, sessionUri, total))) throw new DriveError(409, 'Already uploaded');
    },

    /** Passes one chunk on to Drive. Returns { received, done }. */
    async putChunk({ pathname, offset, data }) {
      const up = await db.getUpload(pathname);
      if (!up) throw new DriveError(404, 'Unknown upload');
      if (up.fileId) return { received: up.total, done: true };
      if (offset !== up.received) return { received: up.received, done: false, resend: true };
      const end = offset + data.length - 1;
      if (!data.length || end >= up.total || (data.length !== CHUNK_SIZE && end !== up.total - 1)) {
        throw new DriveError(400, 'Bad chunk');
      }
      const res = await call('PUT', up.sessionUri, {
        body: data,
        headers: { 'Content-Range': `bytes ${offset}-${end}/${up.total}` },
        expect: [200, 201, 308],
      });
      if (res.status === 308) {
        // Drive reports what it has stored so far, e.g. "bytes=0-4194303".
        const range = /bytes=0-(\d+)/.exec(res.headers.get('range') || '');
        const received = range ? Number(range[1]) + 1 : 0;
        await db.setUploadProgress(pathname, received);
        return { received, done: false };
      }
      const { id } = await res.json();
      await db.setUploadProgress(pathname, up.total, id);
      return { received: up.total, done: true };
    },

    /** Called before a new post is saved: fills in Drive ids and files the post in its own folder. */
    async finalizePost(post) {
      for (const f of post.files) {
        f.ref = await fileIdFor(f.pathname);
        f.previewRef = null;
        if (f.previewPathname) {
          const up = await db.getUpload(f.previewPathname);
          if (up && up.fileId) f.previewRef = up.fileId;
          else f.previewPathname = null; // a missing preview is not worth failing the post for
        }
      }
      let folderId = null;
      if (post.files.length) {
        folderId = await db.kvGet(`drive:draft:${post.id}`);
        if (!folderId) throw new DriveError(400, 'Upload folder not found');
        await update(folderId, { name: folderName(post) },
          `&addParents=${encodeURIComponent(rootId)}&removeParents=${encodeURIComponent(await stagingFolder())}`);
      } else {
        folderId = await createFolder(folderName(post), rootId);
      }
      if (post.text) {
        const header = [post.name, hebrewDate(post.createdAt), post.visibility === 'family' ? 'משפחה בלבד' : '']
          .filter(Boolean).join('\n');
        const boundary = `memorial${Date.now()}`;
        const body = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify({ name: 'טקסט', mimeType: 'application/vnd.google-apps.document', parents: [folderId] }),
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          `${header}\n\n${post.text}`,
          `--${boundary}--`,
          '',
        ].join('\r\n');
        await call('POST', '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
          body: Buffer.from(body, 'utf8'),
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        });
      }
      post.storage = { folderId };
    },

    /** Keeps the folder name in step with the post (e.g. "(משפחה בלבד)"). */
    async onPostChanged(post) {
      if (post.storage?.folderId) await update(post.storage.folderId, { name: folderName(post) });
    },

    async removePost(post) {
      if (post.storage?.folderId) await trash(post.storage.folderId);
      for (const f of post.files) if (f.previewRef) await trash(f.previewRef).catch(() => {});
    },

    resolveUpload: fileIdFor,

    async remove(fileIds) {
      for (const id of fileIds) await trash(id).catch((err) => console.error('Drive trash failed:', err.message));
    },

    // Streams a file to the browser. Open-ended ranges are capped, so long
    // videos arrive in pieces and no request runs into the function time limit.
    async send(req, res, fileId, mime) {
      let range = req.headers.range;
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m && !m[2]) range = `bytes=${m[1]}-${Number(m[1]) + MAX_RANGE - 1}`;
      const r = await download(fileId, range);
      if (r.status === 404) return res.status(404).end();
      if (r.status === 416) {
        res.set('Content-Range', r.headers.get('content-range') || '');
        return res.status(416).end();
      }
      res.status(r.status);
      for (const h of ['content-length', 'content-range']) {
        const v = r.headers.get(h);
        if (v) res.set(h, v);
      }
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'private, max-age=86400');
      await pipeline(Readable.fromWeb(r.body), res).catch(ignoreClosed);
    },

    async openRead(fileId) {
      const r = await download(fileId);
      if (r.status !== 200) throw new DriveError(404, `Not found: ${fileId}`);
      return Readable.fromWeb(r.body);
    },
  };
}

module.exports = { createDriveStorage };
