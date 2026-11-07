'use strict';

// iPhone photos (HEIC/HEIF) only display in Safari. For everyone else the
// server makes a JPEG copy to show on the page; the original stays as uploaded.

const MAX_SIDE = 1600;

/** Shrinks RGBA pixels by averaging blocks, so the long side is at most `max`. */
function downscale({ width, height, data }, max) {
  const factor = Math.max(width, height) / max;
  if (factor <= 1) return { width, height, data };
  const w = Math.max(1, Math.round(width / factor));
  const h = Math.max(1, Math.round(height / factor));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * height / h);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * width / w);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / w));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

async function heicToJpeg(buffer, maxSide = MAX_SIDE) {
  const decode = require('heic-decode');
  const jpeg = require('jpeg-js');
  const image = await decode({ buffer });
  const small = downscale({ width: image.width, height: image.height, data: image.data }, maxSide);
  return jpeg.encode(small, 85).data;
}

const isHeic = (mime) => /^image\/hei[cf]$/.test(mime);

module.exports = { heicToJpeg, isHeic };
