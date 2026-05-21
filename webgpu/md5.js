export function hexToBytes(hex) {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0) throw new Error("hex string must have an even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const value = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(value)) throw new Error("invalid hex byte");
    out[i] = value;
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function load32le(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function store32le(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >>> 8) & 255;
  bytes[offset + 2] = (value >>> 16) & 255;
  bytes[offset + 3] = (value >>> 24) & 255;
}

function f(x, y, z) { return (z ^ (x & (y ^ z))) >>> 0; }
function g(x, y, z) { return (y ^ (z & (x ^ y))) >>> 0; }
function h(x, y, z) { return (x ^ y ^ z) >>> 0; }
function ii(x, y, z) { return (y ^ (x | (~z))) >>> 0; }

function step(fn, a, b, c, d, x, k, s) {
  return (rotl32((a + fn(b, c, d) + x + k) >>> 0, s) + b) >>> 0;
}

function transform(state, block, offset = 0) {
  const w = new Uint32Array(16);
  for (let i = 0; i < 16; i++) w[i] = load32le(block, offset + i * 4);
  let a = state[0], b = state[1], c = state[2], d = state[3];

  a = step(f, a,b,c,d, w[ 0], 0xd76aa478,  7); d = step(f, d,a,b,c, w[ 1], 0xe8c7b756, 12);
  c = step(f, c,d,a,b, w[ 2], 0x242070db, 17); b = step(f, b,c,d,a, w[ 3], 0xc1bdceee, 22);
  a = step(f, a,b,c,d, w[ 4], 0xf57c0faf,  7); d = step(f, d,a,b,c, w[ 5], 0x4787c62a, 12);
  c = step(f, c,d,a,b, w[ 6], 0xa8304613, 17); b = step(f, b,c,d,a, w[ 7], 0xfd469501, 22);
  a = step(f, a,b,c,d, w[ 8], 0x698098d8,  7); d = step(f, d,a,b,c, w[ 9], 0x8b44f7af, 12);
  c = step(f, c,d,a,b, w[10], 0xffff5bb1, 17); b = step(f, b,c,d,a, w[11], 0x895cd7be, 22);
  a = step(f, a,b,c,d, w[12], 0x6b901122,  7); d = step(f, d,a,b,c, w[13], 0xfd987193, 12);
  c = step(f, c,d,a,b, w[14], 0xa679438e, 17); b = step(f, b,c,d,a, w[15], 0x49b40821, 22);

  a = step(g, a,b,c,d, w[ 1], 0xf61e2562,  5); d = step(g, d,a,b,c, w[ 6], 0xc040b340,  9);
  c = step(g, c,d,a,b, w[11], 0x265e5a51, 14); b = step(g, b,c,d,a, w[ 0], 0xe9b6c7aa, 20);
  a = step(g, a,b,c,d, w[ 5], 0xd62f105d,  5); d = step(g, d,a,b,c, w[10], 0x02441453,  9);
  c = step(g, c,d,a,b, w[15], 0xd8a1e681, 14); b = step(g, b,c,d,a, w[ 4], 0xe7d3fbc8, 20);
  a = step(g, a,b,c,d, w[ 9], 0x21e1cde6,  5); d = step(g, d,a,b,c, w[14], 0xc33707d6,  9);
  c = step(g, c,d,a,b, w[ 3], 0xf4d50d87, 14); b = step(g, b,c,d,a, w[ 8], 0x455a14ed, 20);
  a = step(g, a,b,c,d, w[13], 0xa9e3e905,  5); d = step(g, d,a,b,c, w[ 2], 0xfcefa3f8,  9);
  c = step(g, c,d,a,b, w[ 7], 0x676f02d9, 14); b = step(g, b,c,d,a, w[12], 0x8d2a4c8a, 20);

  a = step(h, a,b,c,d, w[ 5], 0xfffa3942,  4); d = step(h, d,a,b,c, w[ 8], 0x8771f681, 11);
  c = step(h, c,d,a,b, w[11], 0x6d9d6122, 16); b = step(h, b,c,d,a, w[14], 0xfde5380c, 23);
  a = step(h, a,b,c,d, w[ 1], 0xa4beea44,  4); d = step(h, d,a,b,c, w[ 4], 0x4bdecfa9, 11);
  c = step(h, c,d,a,b, w[ 7], 0xf6bb4b60, 16); b = step(h, b,c,d,a, w[10], 0xbebfbc70, 23);
  a = step(h, a,b,c,d, w[13], 0x289b7ec6,  4); d = step(h, d,a,b,c, w[ 0], 0xeaa127fa, 11);
  c = step(h, c,d,a,b, w[ 3], 0xd4ef3085, 16); b = step(h, b,c,d,a, w[ 6], 0x04881d05, 23);
  a = step(h, a,b,c,d, w[ 9], 0xd9d4d039,  4); d = step(h, d,a,b,c, w[12], 0xe6db99e5, 11);
  c = step(h, c,d,a,b, w[15], 0x1fa27cf8, 16); b = step(h, b,c,d,a, w[ 2], 0xc4ac5665, 23);

  a = step(ii, a,b,c,d, w[ 0], 0xf4292244,  6); d = step(ii, d,a,b,c, w[ 7], 0x432aff97, 10);
  c = step(ii, c,d,a,b, w[14], 0xab9423a7, 15); b = step(ii, b,c,d,a, w[ 5], 0xfc93a039, 21);
  a = step(ii, a,b,c,d, w[12], 0x655b59c3,  6); d = step(ii, d,a,b,c, w[ 3], 0x8f0ccc92, 10);
  c = step(ii, c,d,a,b, w[10], 0xffeff47d, 15); b = step(ii, b,c,d,a, w[ 1], 0x85845dd1, 21);
  a = step(ii, a,b,c,d, w[ 8], 0x6fa87e4f,  6); d = step(ii, d,a,b,c, w[15], 0xfe2ce6e0, 10);
  c = step(ii, c,d,a,b, w[ 6], 0xa3014314, 15); b = step(ii, b,c,d,a, w[13], 0x4e0811a1, 21);
  a = step(ii, a,b,c,d, w[ 4], 0xf7537e82,  6); d = step(ii, d,a,b,c, w[11], 0xbd3af235, 10);
  c = step(ii, c,d,a,b, w[ 2], 0x2ad7d2bb, 15); b = step(ii, b,c,d,a, w[ 9], 0xeb86d391, 21);

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
}

export class Md5 {
  constructor(snapshot) {
    this.state = snapshot ? Uint32Array.from(snapshot.state) : new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    this.bytes = snapshot ? snapshot.bytes : 0;
    this.buffer = snapshot ? Uint8Array.from(snapshot.buffer) : new Uint8Array(64);
  }

  update(bytes) {
    for (const value of bytes) {
      const pos = this.bytes & 63;
      this.buffer[pos] = value;
      this.bytes++;
      if (pos === 63) {
        transform(this.state, this.buffer);
        this.buffer.fill(0);
      }
    }
    return this;
  }

  snapshot() {
    return { state: Uint32Array.from(this.state), bytes: this.bytes, buffer: Uint8Array.from(this.buffer) };
  }

  digest() {
    const ctx = new Md5(this.snapshot());
    const bitLen = BigInt(ctx.bytes) * 8n;
    ctx.update(Uint8Array.of(0x80));
    while ((ctx.bytes & 63) !== 56) ctx.update(Uint8Array.of(0));
    const len = new Uint8Array(8);
    let v = bitLen;
    for (let i = 0; i < 8; i++) {
      len[i] = Number(v & 255n);
      v >>= 8n;
    }
    ctx.update(len);
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) store32le(out, i * 4, ctx.state[i]);
    return out;
  }
}

export function md5(bytes) {
  return new Md5().update(bytes).digest();
}

export function md5Hex(bytes) {
  return bytesToHex(md5(bytes));
}

export function loadDigestWords(targetBytes) {
  if (targetBytes.length !== 16) throw new Error("target digest must be 16 bytes");
  return new Uint32Array([
    load32le(targetBytes, 0),
    load32le(targetBytes, 4),
    load32le(targetBytes, 8),
    load32le(targetBytes, 12)
  ]);
}
