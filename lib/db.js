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
COMMIT;
`;

const toPost = (row) => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  name: row.name,
  text: row.body,
  visibility: row.visibility,
  files: row.files,
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

    async listPosts({ includeFamily }) {
      const { rows } = await query(
        `SELECT * FROM memorial_posts ${includeFamily ? '' : "WHERE visibility = 'public'"} ORDER BY created_at DESC`,
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
        `INSERT INTO memorial_posts (id, name, body, visibility, files)
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING`,
        [post.id, post.name, post.text, post.visibility, JSON.stringify(post.files)],
      );
      return rowCount === 1;
    },

    async setVisibility(id, visibility) {
      const { rows } = await query(
        'UPDATE memorial_posts SET visibility = $2 WHERE id = $1 RETURNING *', [id, visibility],
      );
      return rows[0] ? toPost(rows[0]) : null;
    },

    async deletePost(id) {
      const { rows } = await query('DELETE FROM memorial_posts WHERE id = $1 RETURNING *', [id]);
      return rows[0] ? toPost(rows[0]) : null;
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
