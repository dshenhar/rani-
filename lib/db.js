'use strict';

// Posts and page settings in Postgres (Neon on Vercel). Tables are created on
// first use, so a fresh Neon database needs no manual setup.

const { Pool } = require('pg');

const SCHEMA = `
BEGIN;
SELECT pg_advisory_xact_lock(727274);
CREATE TABLE IF NOT EXISTS memorial_posts (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'family')),
  files jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS memorial_posts_created_idx ON memorial_posts (created_at DESC);
CREATE TABLE IF NOT EXISTS memorial_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE memorial_posts ADD COLUMN IF NOT EXISTS storage jsonb NOT NULL DEFAULT '{}'::jsonb;
-- sha256 of the key the posting browser keeps, so its author can edit later
ALTER TABLE memorial_posts ADD COLUMN IF NOT EXISTS edit_hash text;
-- Google Drive: uploads in progress, and ids of folders the app created.
CREATE TABLE IF NOT EXISTS memorial_uploads (
  pathname text PRIMARY KEY,
  session_uri text NOT NULL,
  total bigint NOT NULL,
  received bigint NOT NULL DEFAULT 0,
  file_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memorial_kv (
  key text PRIMARY KEY,
  value text NOT NULL
);
COMMIT;
`;

const toPost = (row) => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  name: row.name,
  text: row.body,
  visibility: row.visibility,
  files: row.files,
  storage: row.storage || {},
  editHash: row.edit_hash || null,
});

function createDb({ connectionString, defaultName }) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. On Vercel: Storage → Neon → connect it to this project.');
  }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: local ? false : undefined,
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  try {
    // Lets Vercel close idle connections before a function instance is suspended.
    require('@vercel/functions').attachDatabasePool(pool);
  } catch { /* not on Vercel */ }

  let ready = null;
  const init = () => {
    ready ??= pool.query(SCHEMA).catch((err) => { ready = null; throw err; });
    return ready;
  };
  const query = async (text, params) => {
    await init();
    return pool.query(text, params);
  };

  return {
    init,

    /** Public posts, plus family-only ones when allowed, plus the given ids (the visitor's own). */
    async listPosts({ includeFamily, alsoIds = [] }) {
      const { rows } = includeFamily
        ? await query('SELECT * FROM memorial_posts ORDER BY created_at DESC')
        : await query(
          "SELECT * FROM memorial_posts WHERE visibility = 'public' OR id = ANY($1::text[]) ORDER BY created_at DESC",
          [alsoIds],
        );
      return rows.map(toPost);
    },

    async getPost(id) {
      const { rows } = await query('SELECT * FROM memorial_posts WHERE id = $1', [id]);
      return rows[0] ? toPost(rows[0]) : null;
    },

    /** Returns false when a post with this id already exists. */
    async insertPost(post) {
      const { rowCount } = await query(
        `INSERT INTO memorial_posts (id, name, body, visibility, files, storage, edit_hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) ON CONFLICT (id) DO NOTHING`,
        [post.id, post.name, post.text, post.visibility, JSON.stringify(post.files),
          JSON.stringify(post.storage || {}), post.editHash || null],
      );
      return rowCount === 1;
    },

    async updatePost(id, post) {
      const { rows } = await query(
        `UPDATE memorial_posts SET name = $2, body = $3, visibility = $4, files = $5::jsonb, storage = $6::jsonb
         WHERE id = $1 RETURNING *`,
        [id, post.name, post.text, post.visibility, JSON.stringify(post.files), JSON.stringify(post.storage || {})],
      );
      return rows[0] ? toPost(rows[0]) : null;
    },

    /** Changes one file entry (e.g. adds a preview) without touching the rest of the post. */
    async updateFile(postId, fileId, changes) {
      const { rows } = await query(
        `UPDATE memorial_posts SET files = (
           SELECT COALESCE(jsonb_agg(CASE WHEN f->>'id' = $2 THEN f || $3::jsonb ELSE f END ORDER BY i), '[]'::jsonb)
           FROM jsonb_array_elements(files) WITH ORDINALITY AS t(f, i))
         WHERE id = $1 RETURNING *`,
        [postId, fileId, JSON.stringify(changes)],
      );
      return rows[0] ? toPost(rows[0]) : null;
    },

    async deletePost(id) {
      const { rows } = await query('DELETE FROM memorial_posts WHERE id = $1 RETURNING *', [id]);
      return rows[0] ? toPost(rows[0]) : null;
    },

    // ----- used by the Google Drive storage -----

    async kvGet(key) {
      const { rows } = await query('SELECT value FROM memorial_kv WHERE key = $1', [key]);
      return rows[0]?.value ?? null;
    },

    async kvSet(key, value) {
      await query(
        'INSERT INTO memorial_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
    },

    /** Stores value unless the key exists; returns the value that ends up stored. */
    async kvPutIfAbsent(key, value) {
      await query('INSERT INTO memorial_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
      return this.kvGet(key);
    },

    async startUpload(pathname, sessionUri, total) {
      const { rowCount } = await query(
        `INSERT INTO memorial_uploads (pathname, session_uri, total) VALUES ($1, $2, $3)
         ON CONFLICT (pathname) DO UPDATE SET session_uri = EXCLUDED.session_uri, total = EXCLUDED.total, received = 0
         WHERE memorial_uploads.file_id IS NULL`,
        [pathname, sessionUri, total],
      );
      return rowCount === 1;
    },

    async getUpload(pathname) {
      const { rows } = await query('SELECT * FROM memorial_uploads WHERE pathname = $1', [pathname]);
      const r = rows[0];
      return r ? { sessionUri: r.session_uri, total: Number(r.total), received: Number(r.received), fileId: r.file_id } : null;
    },

    async setUploadProgress(pathname, received, fileId = null) {
      await query('UPDATE memorial_uploads SET received = $2, file_id = COALESCE($3, file_id) WHERE pathname = $1',
        [pathname, received, fileId]);
    },

    async getSettings() {
      const { rows } = await query('SELECT data FROM memorial_settings WHERE id = 1');
      return { name: defaultName, subtitle: '', cover: null, ...(rows[0]?.data || {}) };
    },

    async updateSettings(changes) {
      const { rows } = await query(
        `INSERT INTO memorial_settings (id, data) VALUES (1, $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = memorial_settings.data || EXCLUDED.data
         RETURNING data`,
        [JSON.stringify(changes)],
      );
      return { name: defaultName, subtitle: '', cover: null, ...rows[0].data };
    },
  };
}

module.exports = { createDb };
