'use strict';

// Two interchangeable storage back ends:
//   local – files on disk under DATA_DIR (use a persistent volume in production)
//   s3    – any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2, ...)
// Both keep the metadata (posts.json, settings.json) next to the files.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const IMMUTABLE = 'private, max-age=31536000, immutable';

function createLocalStorage(dataDir) {
  const root = path.resolve(dataDir);

  const resolve = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return p;
  };

  async function writeAtomic(dest, data) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, dest);
  }

  return {
    kind: 'local',
    description: `local disk at ${root}`,

    async init() {
      await fsp.mkdir(root, { recursive: true });
      await writeAtomic(path.join(root, '.write-test'), 'ok');
      await fsp.rm(path.join(root, '.write-test'), { force: true });
    },

    async save(key, stream) {
      const dest = resolve(key);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
      try {
        await pipeline(stream, fs.createWriteStream(tmp));
        await fsp.rename(tmp, dest);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    },

    async readJSON(key) {
      try {
        return JSON.parse(await fsp.readFile(resolve(key), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    async writeJSON(key, value) {
      await writeAtomic(resolve(key), JSON.stringify(value, null, 1));
    },

    async remove(keys) {
      const dirs = new Set();
      for (const key of keys) {
        const p = resolve(key);
        await fsp.rm(p, { force: true });
        dirs.add(path.dirname(p));
      }
      for (const dir of dirs) {
        if (dir !== root) await fsp.rmdir(dir).catch(() => {}); // only succeeds when empty
      }
    },

    async openRead(key) {
      const p = resolve(key);
      await fsp.access(p);
      return fs.createReadStream(p);
    },

    // Streams the file with Range support (needed for seeking in videos).
    send(req, res, key, mime) {
      res.sendFile(resolve(key), {
        headers: { 'Content-Type': mime, 'Cache-Control': IMMUTABLE },
        cacheControl: false,
        dotfiles: 'deny',
      }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 404).end();
      });
    },
  };
}

function createS3Storage(cfg) {
  const {
    S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand, HeadBucketCommand,
  } = require('@aws-sdk/client-s3');
  const { Upload } = require('@aws-sdk/lib-storage');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const client = new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Some S3-compatible services reject the newer default checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = cfg.bucket;
  const prefix = cfg.prefix ? cfg.prefix.replace(/\/+$/, '') + '/' : '';
  const k = (key) => prefix + key;

  // Re-use signed URLs for a while so browsers can cache the media.
  const signed = new Map();
  const SIGN_SECONDS = 6 * 3600;
  const REUSE_MS = 3 * 3600 * 1000;

  return {
    kind: 's3',
    description: `bucket "${Bucket}"${cfg.endpoint ? ` at ${cfg.endpoint}` : ''}`,

    async init() {
      await client.send(new HeadBucketCommand({ Bucket }));
    },

    async save(key, stream, mime) {
      const upload = new Upload({
        client,
        params: { Bucket, Key: k(key), Body: stream, ContentType: mime, CacheControl: IMMUTABLE },
        queueSize: 3,
        partSize: 8 * 1024 * 1024,
      });
      try {
        await upload.done();
      } catch (err) {
        await upload.abort().catch(() => {});
        throw err;
      }
    },

    async readJSON(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: k(key) }));
        return JSON.parse(await out.Body.transformToString('utf8'));
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    async writeJSON(key, value) {
      await client.send(new PutObjectCommand({
        Bucket, Key: k(key), Body: JSON.stringify(value, null, 1),
        ContentType: 'application/json', CacheControl: 'no-store',
      }));
    },

    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        if (!chunk.length) continue;
        await client.send(new DeleteObjectsCommand({
          Bucket, Delete: { Objects: chunk.map((key) => ({ Key: k(key) })), Quiet: true },
        }));
        chunk.forEach((key) => signed.delete(key));
      }
    },

    async openRead(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: k(key) }));
      return out.Body;
    },

    // Redirects the browser to a short-lived signed URL; the bucket stays private.
    async send(req, res, key) {
      let entry = signed.get(key);
      if (!entry || entry.expires < Date.now()) {
        const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: k(key) }), { expiresIn: SIGN_SECONDS });
        entry = { url, expires: Date.now() + REUSE_MS };
        signed.set(key, entry);
      }
      res.set('Cache-Control', 'private, max-age=600');
      res.redirect(302, entry.url);
    },
  };
}

function createStorage(env) {
  const useS3 = (env.STORAGE || '').toLowerCase() === 's3' || (!env.STORAGE && env.S3_BUCKET);
  if (useS3) {
    const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((n) => !env[n]);
    if (missing.length) throw new Error(`Missing environment variables for S3 storage: ${missing.join(', ')}`);
    return createS3Storage({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      prefix: env.S3_PREFIX,
    });
  }
  return createLocalStorage(env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { createStorage };
