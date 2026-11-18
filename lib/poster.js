'use strict';

// Cover images ("posters") for videos, made on the server with ffmpeg.
// Browsers make one while uploading, but some (notably with iPhone videos)
// capture a black frame; the server checks covers and makes a proper one.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

let binary;
function ffmpegBinary() {
  if (binary !== undefined) return binary;
  try {
    binary = require('ffmpeg-static') || null;
  } catch {
    binary = null;
  }
  return binary;
}

const available = () => Boolean(ffmpegBinary());

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const data = Buffer.concat(out);
      if (code === 0 && data.length) resolve(data);
      else reject(new Error(`ffmpeg ${signal ? `stopped (${signal})` : `exited ${code}`}: ${err.trim().split('\n').pop() || 'no output'}`));
    });
  });
}

// Some hosts lose the executable bit when bundling; a copy in /tmp fixes that.
async function runFfmpeg(args, timeoutMs) {
  const bin = ffmpegBinary();
  try {
    return await run(bin, args, timeoutMs);
  } catch (err) {
    if (err.code !== 'EACCES') throw err;
    const copy = path.join(os.tmpdir(), 'ffmpeg-memorial');
    if (!fs.existsSync(copy)) {
      fs.copyFileSync(bin, copy);
      fs.chmodSync(copy, 0o755);
    }
    return run(copy, args, timeoutMs);
  }
}

/** True when a JPEG is (nearly) one flat colour, e.g. the black frames some phones capture. */
function isBlank(jpegBuffer) {
  const { data, width, height } = require('jpeg-js').decode(jpegBuffer, { useTArray: true, maxMemoryUsageInMB: 256 });
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  const step = Math.max(1, Math.floor((width * height) / 20000));
  for (let p = 0; p < width * height; p += step) {
    const i = p * 4;
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y;
    sumSq += y * y;
    n++;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return sd < 4 || (mean < 12 && sd < 8);
}

/**
 * Serves a remote video on 127.0.0.1 while ffmpeg reads it. The static ffmpeg
 * build crashes when it has to look up a host name, and Node handles the
 * storage's TLS and sign-in anyway; ffmpeg's range requests (to jump to the
 * index at the end of an iPhone .mov) are passed through.
 */
async function withRelay(url, headers, fn) {
  const server = http.createServer(async (req, res) => {
    // ffmpeg drops a connection once it has read enough; stop downloading then.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const upstream = await fetch(url, {
        headers: { ...headers, ...(req.headers.range ? { range: req.headers.range } : {}) },
        signal: abort.signal,
      });
      const out = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(upstream.status, out);
      if (!upstream.body || req.method === 'HEAD') return res.end();
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/video`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/**
 * A JPEG from the start of the video (input: a file path, or a URL with
 * optional request headers). Picks a representative frame of the first
 * seconds and skips black openings by looking further in if needed.
 */
async function videoPoster({ input, headers }) {
  if (!available()) throw new Error('ffmpeg is not available');
  if (/^https?:/i.test(input)) return withRelay(input, headers || {}, (local) => posterFrom(local));
  return posterFrom(input);
}

async function posterFrom(input) {
  let last = null;
  for (const start of [0, 3, 8]) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(start ? ['-ss', String(start)] : []),
      '-i', input,
      '-t', '4',
      '-vf', "thumbnail=90,scale='min(1280,iw)':-2:flags=bicubic,format=yuvj420p",
      '-frames:v', '1', '-q:v', '4',
      '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
    ];
    try {
      const jpeg = await runFfmpeg(args, 90_000);
      if (!isBlank(jpeg)) return jpeg;
      last = jpeg;
    } catch (err) {
      if (!start) throw err; // the video itself could not be read
      break; // shorter than this offset
    }
  }
  if (last) return last; // a genuinely dark video: keep what it shows
  throw new Error('No frame found');
}

module.exports = { videoPoster, isBlank, available };
