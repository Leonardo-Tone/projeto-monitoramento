import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');
mkdirSync(assetsDir, { recursive: true });

// Minimal pure-Node CRC32 for PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function blend(dst, idx, r, g, b, a) {
  const alpha = clamp01(a);
  if (alpha <= 0) return;
  const da = dst[idx + 3] / 255;
  const outA = alpha + da * (1 - alpha);
  if (outA <= 0) return;
  dst[idx] = Math.round((r * alpha + dst[idx] * da * (1 - alpha)) / outA);
  dst[idx + 1] = Math.round((g * alpha + dst[idx + 1] * da * (1 - alpha)) / outA);
  dst[idx + 2] = Math.round((b * alpha + dst[idx + 2] * da * (1 - alpha)) / outA);
  dst[idx + 3] = Math.round(outA * 255);
}

// Render Vigia radar emblem at any square size with anti-aliasing
function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const pad = size * 0.04;
  const radius = size * 0.22;
  const half = size / 2 - pad;

  const distRoundedRect = (x, y) => {
    const dx = Math.abs(x - cx) - (half - radius);
    const dy = Math.abs(y - cy) - (half - radius);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
  };

  // Sweep direction: upper-right 45 degrees
  const sweepAngle = -Math.PI / 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dRect = distRoundedRect(x, y);
      const bgAlpha = clamp01(0.5 - dRect);
      if (bgAlpha <= 0) continue;

      // Rich charcoal background (#181c1a -> #212824 subtle vertical gradient)
      const t = y / size;
      const bgR = Math.round(24 + t * 10);
      const bgG = Math.round(28 + t * 14);
      const bgB = Math.round(26 + t * 10);
      blend(buf, idx, bgR, bgG, bgB, bgAlpha);

      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const maxR = size * 0.36;

      // Subtle emerald radar sweep wedge
      if (dist <= maxR) {
        let ang = Math.atan2(dy, dx) - sweepAngle;
        while (ang < -Math.PI) ang += Math.PI * 2;
        while (ang > Math.PI) ang -= Math.PI * 2;
        if (ang >= -0.85 && ang <= 0) {
          const wedge = (1 + ang / 0.85) * 0.38 * clamp01((maxR - dist) / (size * 0.04));
          blend(buf, idx, 34, 197, 94, wedge * bgAlpha);
        }
      }

      const stroke = Math.max(1.2, size * 0.048);
      // Outer ring
      const dOuter = Math.abs(dist - maxR);
      blend(buf, idx, 240, 245, 242, clamp01(stroke * 0.55 - dOuter + 0.5) * 0.92 * bgAlpha);
      // Inner ring
      const dInner = Math.abs(dist - size * 0.21);
      blend(buf, idx, 148, 224, 178, clamp01(stroke * 0.45 - dInner + 0.5) * 0.65 * bgAlpha);

      // Radar sweep arm (from center to upper-right)
      const proj = dx * Math.cos(sweepAngle) + dy * Math.sin(sweepAngle);
      const perp = Math.abs(-dx * Math.sin(sweepAngle) + dy * Math.cos(sweepAngle));
      if (proj >= 0 && proj <= maxR) {
        blend(buf, idx, 34, 197, 94, clamp01(stroke * 0.58 - perp + 0.5) * bgAlpha);
      }

      // Center dot
      const dDot = dist - size * 0.068;
      blend(buf, idx, 34, 197, 94, clamp01(0.5 - dDot) * bgAlpha);

      // Target blip on sweep
      const bx = cx + Math.cos(sweepAngle) * (size * 0.24);
      const by = cy + Math.sin(sweepAngle) * (size * 0.24);
      const dBlip = Math.hypot(x - bx, y - by) - size * 0.052;
      blend(buf, idx, 187, 247, 208, clamp01(0.5 - dBlip) * bgAlpha);
    }
  }
  return encodePng(size, size, buf);
}

// Pack PNGs into multi-size Windows .ico container
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...entries.map(e => e.png)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const rendered = sizes.map(size => ({ size, png: renderIcon(size) }));
const png256 = rendered.find(e => e.size === 256).png;
const ico = buildIco(rendered);

writeFileSync(join(assetsDir, 'icon.png'), png256);
writeFileSync(join(assetsDir, 'icon.ico'), ico);
console.log(`Vigia icons generated: icon.png (${png256.length} bytes), icon.ico (${ico.length} bytes)`);
