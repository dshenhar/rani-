'use strict';

// Google Drive storage: everything goes into a folder in a Shared Drive, one
// subfolder per memory ("2026-11-06 – name") with the original files and a
// Google Doc holding the text, so the family can simply open the Drive.
//
// Access to Drive is either
//   - a Google account connected once by the site admin ("חיבור לגוגל דרייב"),
//     which needs only an OAuth client – no service account key, and no
//     outside member in the Shared Drive; or
//   - a service account that is a member of the Shared Drive.
// Browsers send
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

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'openid email https://www.googleapis.com/auth/drive';

// Google account connected by the admin; its refresh token lives in the database.
function createOAuth(env, db) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID.trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const authUrl = env.GOOGLE_AUTH_URL || AUTH_URL; // overridable for tests
  const tokenUrl = env.GOOGLE_TOKEN_URL || TOKEN_URL;
  let stored = { value: undefined, at: 0 };
  let access = null;

  async function refreshToken() {
    if (stored.value === undefined || Date.now() - stored.at > 60_000) {
      stored = { value: await db.kvGet('google:refresh_token'), at: Date.now() };
    }
    return stored.value;
  }

  async function tokenRequest(params) {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new DriveError(res.status < 500 ? 503 : 502, `Google sign-in: ${data.error || res.status} ${data.error_description || ''}`);
    }
    return data;
  }

  return {
    mode: 'oauth',
    email: null,

    authUrl(state, redirectUri) {
      return `${authUrl}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent', // makes Google return a refresh token every time
        include_granted_scopes: 'true',
        state,
      })}`;
    },

    /** Trades the code from Google's redirect for tokens (not saved yet). */
    async exchange(code, redirectUri) {
      const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (!data.refresh_token) throw new DriveError(400, 'Google did not return a refresh token');
      let email = '';
      try {
        email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8')).email || '';
      } catch { /* no id token */ }
      return { refreshToken: data.refresh_token, accessToken: data.access_token, email };
    },

    async save({ refreshToken: token, email }) {
      await db.kvSet('google:refresh_token', token);
      await db.kvSet('google:email', email || '');
      stored = { value: token, at: Date.now() };
      access = null;
    },

    async status() {
      const token = await db.kvGet('google:refresh_token');
      return { connected: Boolean(token), email: token ? await db.kvGet('google:email') : null };
    },

    async token() {
      const token = await refreshToken();
      if (!token) throw new DriveError(503, 'Google Drive is not connected yet');
      if (access && access.refresh === token && access.expires > Date.now() + 60_000) return access.value;
      const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token });
      access = { refresh: token, value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
      return access.value;
    },
  };
}

function createTokenSource(env, db) {
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const { JWT } = require('google-auth-library');
    const key = parseKey(env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const client = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return { mode: 'service-account', email: key.client_email, token: async () => (await client.getAccessToken()).token };
  }
  if (env.GOOGLE_OAUTH_CLIENT_ID) return createOAuth(env, db);
  if (env.GOOGLE_API_BASE) return { mode: 'test', email: 'test', token: async () => 'test-token' }; // local Drive stand-in
  throw new Error('Set GOOGLE_OAUTH_CLIENT_ID (and _SECRET) or GOOGLE_SERVICE_ACCOUNT_KEY');
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
  const auth = createTokenSource(env, db);

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

  // Creates a file with content in one request (small files only).
  async function createWithContent(metadata, contentType, content) {
    const boundary = `memorial${Date.now()}${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from([
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${contentType}`,
        '',
        '',
      ].join('\r\n'), 'utf8'),
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const res = await call('POST', '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
    return (await res.json()).id;
  }

  // The text of a memory as a Google Doc named "טקסט" in its folder.
  function writeDoc(folderId, post) {
    const header = [post.name, hebrewDate(post.createdAt), post.visibility === 'family' ? 'משפחה בלבד' : '']
      .filter(Boolean).join('\n');
    return createWithContent(
      { name: 'טקסט', mimeType: 'application/vnd.google-apps.document', parents: [folderId] },
      'text/plain; charset=UTF-8',
      `${header}\n\n${post.text}`,
    );
  }

  async function trashTextDocs(folderId) {
    const q = `'${folderId}' in parents and name = 'טקסט' and mimeType = 'application/vnd.google-apps.document' and trashed = false`;
    const res = await call('GET', `/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&fields=files(id)&q=${encodeURIComponent(q)}`);
    const { files = [] } = await res.json();
    for (const f of files) await trash(f.id).catch(() => {});
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
    description: `Google Drive folder ${rootId} (${auth.mode === 'oauth' ? 'connected Google account' : `as ${auth.email}`})`,
    oauth: auth.mode === 'oauth' ? auth : null,

    /** True when this access token may add files to the configured folder. */
    async checkFolder(accessToken) {
      const res = await fetch(`${API}/drive/v3/files/${encodeURIComponent(rootId)}?supportsAllDrives=true&fields=id,capabilities/canAddChildren`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return data.capabilities?.canAddChildren !== false;
    },

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

    /** Fills in Drive ids for newly uploaded files (a new post, or files added later). */
    async attachFiles(post, files) {
      for (const f of files) {
        f.ref = await fileIdFor(f.pathname);
        f.previewRef = null;
        if (f.previewPathname) {
          const up = await db.getUpload(f.previewPathname);
          if (up && up.fileId) f.previewRef = up.fileId;
          else f.previewPathname = null; // a missing preview is not worth failing the post for
        }
      }
    },

    /** Called before a new post is saved: files it in its own folder in the Shared Drive. */
    async finalizePost(post) {
      await this.attachFiles(post, post.files);
      let folderId = null;
      if (post.files.length) {
        folderId = await db.kvGet(`drive:draft:${post.id}`);
        if (!folderId) throw new DriveError(400, 'Upload folder not found');
        await update(folderId, { name: folderName(post) },
          `&addParents=${encodeURIComponent(rootId)}&removeParents=${encodeURIComponent(await stagingFolder())}`);
      } else {
        folderId = await createFolder(folderName(post), rootId);
        // Files added later by the author go straight into this folder.
        await db.kvPutIfAbsent(`drive:draft:${post.id}`, folderId);
      }
      const docId = post.text ? await writeDoc(folderId, post) : null;
      post.storage = { ...post.storage, folderId, docId };
    },

    /** After an edit: folder name and the text document follow the post. Returns the new storage info. */
    async updatePostStorage(before, after) {
      const info = { ...after.storage };
      if (!info.folderId) return info;
      if (folderName(before) !== folderName(after)) await update(info.folderId, { name: folderName(after) });
      if (before.text !== after.text || before.name !== after.name || before.visibility !== after.visibility) {
        if (info.docId) await trash(info.docId).catch(() => {});
        else await trashTextDocs(info.folderId); // posts saved before the doc id was kept
        info.docId = after.text ? await writeDoc(info.folderId, after) : null;
      }
      return info;
    },

    async removePost(post) {
      if (post.storage?.folderId) await trash(post.storage.folderId);
      for (const f of post.files) if (f.previewRef) await trash(f.previewRef).catch(() => {});
    },

    /** Server-side write, used for the JPEG copies of iPhone photos. Returns the Drive file id. */
    async putBuffer(pathname, buffer, mime) {
      const target = await where(pathname, pathname.split('/').pop());
      return createWithContent({ name: target.name, parents: [target.parent], mimeType: mime }, mime, buffer);
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
