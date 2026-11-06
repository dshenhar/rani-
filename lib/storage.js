'use strict';

// File storage. Browsers upload straight to storage (Vercel functions accept at
// most 4.5MB per request, far less than a phone video), and the server only
// hands out upload permission and time-limited read links.
//
//   google-drive – a folder in a Google Shared Drive (see lib/drive.js)
//   vercel-blob  – a *private* Vercel Blob store
//   local        – files on disk under DATA_DIR, for running on a laptop

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// A browser cancelling a media request (e.g. skipping ahead in a video) is normal.
const ignoreClosed = (err) => { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; };

function createVercelBlobStorage(env) {
  const blob = require('@vercel/blob');
  const { handleUpload, handleUploadPresigned } = require('@vercel/blob/client');
  // A read-write token allows the classic client-token flow; with only OIDC
  // credentials the presigned-URL flow is used instead.
  const uploadMode = env.BLOB_READ_WRITE_TOKEN ? 'token' : 'presigned';

  // One read delegation per server instance; individual links are signed locally from it.
  let delegation = null;
  const signedUrls = new Map();
  async function readDelegation() {
    if (!delegation || delegation.validUntil - Date.now() < 20 * 60 * 1000) {
      delegation = await blob.issueSignedToken({
        pathname: '*', operations: ['get'], validUntil: Date.now() + 2 * 3600 * 1000,
      });
      signedUrls.clear();
    }
    return delegation;
  }

  return {
    kind: 'vercel-blob',
    uploadMode,
    description: `Vercel Blob (private, ${uploadMode} uploads)`,

    async init() {},

    /** Handles the upload-permission request made by the browser SDK. */
    async handleUploadRequest(req, { authorize }) {
      if (uploadMode === 'token') {
        return handleUpload({
          request: req,
          body: req.body,
          onBeforeGenerateToken: async (pathname) => {
            const rules = authorize(pathname);
            return {
              allowedContentTypes: rules.contentTypes,
              maximumSizeInBytes: rules.maxBytes,
            };
          },
        });
      }
      return handleUploadPresigned({
        request: req,
        body: req.body,
        getSignedToken: async (pathname) => {
          const rules = authorize(pathname);
          const token = await blob.issueSignedToken({
            pathname,
            operations: ['put'],
            allowedContentTypes: rules.contentTypes,
            maximumSizeInBytes: rules.maxBytes,
          });
          return {
            token,
            urlOptions: {
              allowedContentTypes: rules.contentTypes,
              maximumSizeInBytes: rules.maxBytes,
            },
          };
        },
      });
    },

    // Redirects to a signed link so videos stream straight from storage (with
    // seeking). Falls back to streaming through the function if signing fails.
    async send(req, res, pathname, mime) {
      try {
        let url = signedUrls.get(pathname);
        if (!url) {
          const token = await readDelegation();
          ({ presignedUrl: url } = await blob.presignUrl(token, {
            operation: 'get', pathname, access: 'private', validUntil: token.validUntil,
          }));
          signedUrls.set(pathname, url);
        }
        res.set('Cache-Control', 'private, max-age=600');
        return res.redirect(302, url);
      } catch (err) {
        console.error('Signed link failed, streaming instead:', err.message);
      }
      const headers = req.headers.range ? { range: req.headers.range } : undefined;
      const result = await blob.get(pathname, { access: 'private', headers });
      if (!result || !result.stream) return res.status(404).end();
      res.status(result.headers.get('content-range') ? 206 : 200);
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag']) {
        const v = result.headers.get(h);
        if (v) res.set(h, v);
      }
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'private, max-age=600');
      await pipeline(Readable.fromWeb(result.stream), res).catch(ignoreClosed);
    },

    async openRead(pathname) {
      const result = await blob.get(pathname, { access: 'private' });
      if (!result || !result.stream) throw new Error(`Not found: ${pathname}`);
      return Readable.fromWeb(result.stream);
    },

    async remove(pathnames) {
      if (pathnames.length) await blob.del(pathnames);
      pathnames.forEach((p) => signedUrls.delete(p));
    },
  };
}

function createLocalStorage(dataDir) {
  const root = path.resolve(dataDir);
  const resolve = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return p;
  };

  return {
    kind: 'local',
    uploadMode: 'local',
    description: `local disk at ${root}`,

    async init() {
      await fsp.mkdir(root, { recursive: true });
    },

    /** Stores a raw request body (PUT /api/local-upload). Never overwrites, like Vercel Blob. */
    async saveUpload(req, pathname, maxBytes) {
      const dest = resolve(pathname);
      if (fs.existsSync(dest)) throw Object.assign(new Error('exists'), { status: 409 });
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(Object.assign(new Error('too large'), { status: 413 }));
      });
      try {
        await pipeline(req, fs.createWriteStream(tmp));
        await fsp.rename(tmp, dest);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      return pathname;
    },

    send(req, res, pathname, mime) {
      res.sendFile(resolve(pathname), {
        headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=31536000, immutable' },
        cacheControl: false,
      }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 404).end();
      });
    },

    async openRead(pathname) {
      const p = resolve(pathname);
      await fsp.access(p);
      return fs.createReadStream(p);
    },

    async remove(pathnames) {
      const dirs = new Set();
      for (const key of pathnames) {
        const p = resolve(key);
        await fsp.rm(p, { force: true });
        dirs.add(path.dirname(p));
      }
      for (const dir of dirs) if (dir !== root) await fsp.rmdir(dir).catch(() => {});
    },
  };
}

function createStorage(env, { db } = {}) {
  if (env.GOOGLE_DRIVE_FOLDER_ID) return require('./drive').createDriveStorage(env, db);
  if (env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID) return createVercelBlobStorage(env);
  return createLocalStorage(env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { createStorage };
