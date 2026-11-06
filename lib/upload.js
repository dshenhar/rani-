'use strict';

// Streams a multipart upload straight into storage (no temp copies in memory),
// so large videos from phones work.

const busboy = require('busboy');
const { Transform } = require('node:stream');

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * onFile(field, stream, info, ctx) is called for every file part. Call
 * ctx.save(stream, key, mime) to store it, or stream.resume() to skip it.
 * Resolves to { fields, error, keys } once every file has been stored;
 * when error is set the caller removes `keys`.
 */
function receive(req, storage, { fileSize, maxFiles, tooLargeMessage, onFile }) {
  return new Promise((resolve) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { fileSize, files: maxFiles, fields: 20, fieldSize: 200 * 1024 },
      });
    } catch {
      resolve({ fields: {}, keys: [], error: new UploadError(400, 'בקשה לא תקינה') });
      return;
    }

    const fields = {};
    const keys = [];
    const jobs = [];
    let error = null;
    let finished = false;
    let aborted = false;

    const ctx = {
      fail(status, message) {
        if (!error) error = new UploadError(status, message);
      },
      save(stream, key, mime) {
        keys.push(key);
        let size = 0;
        const counter = new Transform({
          transform(chunk, enc, cb) { size += chunk.length; cb(null, chunk); },
        });
        stream.on('error', (err) => counter.destroy(err));
        stream.pipe(counter);
        const job = storage.save(key, counter, mime).then(
          () => {
            if (stream.truncated) throw new UploadError(413, tooLargeMessage);
            return size;
          },
          (err) => {
            stream.unpipe(counter);
            stream.resume();
            throw err;
          },
        );
        jobs.push(job);
        return job;
      },
    };

    async function finish(parseError) {
      if (finished) return;
      finished = true;
      if (parseError) ctx.fail(400, 'ההעלאה נכשלה. נסו שוב.');
      const results = await Promise.allSettled(jobs);
      for (const r of results) {
        if (r.status === 'rejected') {
          if (!(r.reason instanceof UploadError) && !aborted) console.error('Upload storage error:', r.reason);
          ctx.fail(r.reason?.status || 500, r.reason instanceof UploadError ? r.reason.message : 'השמירה נכשלה. נסו שוב.');
        }
      }
      resolve({ fields, keys, error });
    }

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (field, stream, info) => {
      if (error) { stream.resume(); return; }
      try {
        onFile(field, stream, info, ctx);
      } catch (err) {
        console.error(err);
        ctx.fail(500, 'השמירה נכשלה. נסו שוב.');
        stream.resume();
      }
    });
    bb.on('filesLimit', () => ctx.fail(413, 'יותר מדי קבצים בבת אחת.'));
    bb.on('close', () => finish());
    bb.on('error', (err) => finish(err));
    req.on('close', () => {
      if (!req.complete) {
        aborted = true; // the visitor closed the page or lost connection
        bb.destroy(new Error('Request aborted'));
      }
    });
    req.pipe(bb);
  });
}

module.exports = { receive, UploadError };
