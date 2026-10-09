// -----------------------------------------------------------------------------
// JPEG bytes -> Gladys camera image.
//
// Gladys takes `image/jpg;base64,...` strings of at most 150 KB (the whole
// string). eufy push thumbnails are usually far below that; a larger one is
// halved in size until it fits rather than dropped.
// -----------------------------------------------------------------------------

import jpeg from 'jpeg-js';

export const MAX_IMAGE_SIZE = 150 * 1024;
const PREFIX = 'image/jpg;base64,';
const QUALITY = 70;
const MAX_HALVINGS = 5;

const toGladys = (buffer) => `${PREFIX}${Buffer.from(buffer).toString('base64')}`;

/** Nearest-neighbour halving: thumbnails do not deserve a better filter. */
function halve({ width, height, data }) {
  const w = Math.max(1, Math.floor(width / 2));
  const h = Math.max(1, Math.floor(height / 2));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = (y * 2 * width + x * 2) * 4;
      data.copy(out, (y * w + x) * 4, from, from + 4);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Convert JPEG bytes into a Gladys camera image under the size limit.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function toGladysImage(buffer) {
  const image = toGladys(buffer);
  if (image.length <= MAX_IMAGE_SIZE) {
    return image;
  }
  let raw = jpeg.decode(buffer, { useTArray: false, formatAsRGBA: true });
  for (let i = 0; i < MAX_HALVINGS; i += 1) {
    raw = halve(raw);
    const resized = toGladys(jpeg.encode(raw, QUALITY).data);
    if (resized.length <= MAX_IMAGE_SIZE) {
      return resized;
    }
  }
  throw new Error('The eufy image is too large, even resized');
}
