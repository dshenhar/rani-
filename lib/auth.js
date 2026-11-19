'use strict';

// Three roles: guest (anyone with the link), family (FAMILY_CODE) and
// admin (ADMIN_CODE, or the additional admin code set in the page settings;
// can also see family-only posts). The role is kept in a signed, HTTP-only
// cookie. Sign-ins with the additional code carry that code's tag, so
// changing or removing the code signs those people out.

const crypto = require('node:crypto');

const COOKIE = 'memorial_role';
const MAX_AGE_SECONDS = 365 * 24 * 3600;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function sameCode(input, expected) {
  if (!expected) return false;
  const a = digest(String(input || '').trim().toLowerCase());
  const b = digest(expected.trim().toLowerCase());
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const EXTRA_ADMIN_RE = /^admin-([0-9a-f]{16})$/;

function createAuth({ adminCode, familyCode, secret, extraAdminTag = async () => null }) {
  // Changing either code signs everyone out.
  const key = digest(`${secret || ''}|${adminCode}|${familyCode}`);
  const sign = (role) => crypto.createHmac('sha256', key).update(role).digest('base64url');

  /** Returns { role, via } for a valid cookie, or null. */
  async function verify(value) {
    const [role, sig] = String(value || '').split('.');
    const extra = EXTRA_ADMIN_RE.exec(role || '');
    if (!extra && role !== 'admin' && role !== 'family') return null;
    if (role === 'admin' && !adminCode) return null;
    if (role === 'family' && !familyCode) return null;
    const expected = Buffer.from(sign(role));
    const given = Buffer.from(String(sig || ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    if (!extra) return { role, via: role };
    return extra[1] === await extraAdminTag() ? { role: 'admin', via: 'extra-admin' } : null;
  }

  return {
    enabled: Boolean(adminCode || familyCode),

    roleForCode(code) {
      if (sameCode(code, adminCode)) return 'admin';
      if (sameCode(code, familyCode)) return 'family';
      return null;
    },

    async middleware(req, res, next) {
      const found = await verify(parseCookies(req.headers.cookie)[COOKIE]).catch(() => null);
      req.role = found ? found.role : 'guest';
      req.signedInVia = found ? found.via : null;
      next();
    },

    /** role: 'admin', 'family', or `admin-<tag>` for the additional admin code. */
    setRole(req, res, role) {
      res.cookie(COOKIE, `${role}.${sign(role)}`, {
        httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE_SECONDS * 1000, path: '/',
      });
    },

    clear(req, res) {
      res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    },
  };
}

const canSeeFamily = (role) => role === 'family' || role === 'admin';

module.exports = { createAuth, canSeeFamily, parseCookies };
