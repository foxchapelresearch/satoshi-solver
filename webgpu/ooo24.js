import { Md5, bytesToHex, hexToBytes } from "./md5.js";

export const N_COUNTERS = 17576;
const RADIX = "0123456789abcdefghijklmnop";

export function counterText(value) {
  let n = ((value % N_COUNTERS) + N_COUNTERS) % N_COUNTERS;
  if (n === 0) return "0";
  let out = "";
  while (n > 0) {
    out = RADIX[n % 26] + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function utf16leAscii(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new Error("only ASCII path components are supported");
    out[i * 2] = code;
  }
  return out;
}

export function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const XP_INVALID_DOS_CHAR_BITS = [0xffffffff, 0xfc009c04, 0x38000000, 0x10000000];

function invalidDosChar(ch) {
  return ch < 128 && (XP_INVALID_DOS_CHAR_BITS[ch >> 5] & (1 << (ch & 31))) !== 0;
}

function upcaseSimple(ch) {
  return ch >= 97 && ch <= 122 ? ch - 32 : ch;
}

function validOemChar(ch, allowExtended = false) {
  if (ch < 0x21) return false;
  if (ch <= 0x7e) return true;
  return allowExtended;
}

function toU16(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp > 0xffff) throw new Error(`username is not valid BMP text: ${text}`);
    out.push(cp);
  }
  return out;
}

function next8dot3Char(name, pos, skipDots, allowExtended = false) {
  while (pos < name.length) {
    let ch = name[pos++];
    if (!validOemChar(ch, allowExtended)) continue;
    if (ch === 46 && skipDots) continue;
    if (ch < 0x80 && invalidDosChar(ch)) ch = 95;
    return [upcaseSimple(ch), pos];
  }
  return [0, pos];
}

function checksumXp(name) {
  if (name.length === 0) return 0;
  if (name.length === 1) return name[0];
  let acc = ((name[0] << 8) + name[1]) & 0xffff;
  for (let i = 2; i < name.length; i += 2) {
    let edx = acc << 7;
    const dx = ((edx & 0xffff) + name[i]) & 0xffff;
    const ax = (acc & 0xffff) >>> 1;
    edx = (((edx & 0xffff0000) | dx) << 8) >>> 0;
    acc = (ax + edx) >>> 0;
    if (i + 1 < name.length) acc = (acc & 0xffff0000) | (((acc & 0xffff) + name[i + 1]) & 0xffff);
  }
  return acc & 0xffff;
}

function hexNibble(value) {
  value &= 0xf;
  return value + 48 + (value > 9 ? 7 : 0);
}

function appendChecksumNibbles(base, start, end, checksum) {
  while (base.length < end && base.length < 8) base.push(0);
  for (let i = start; i < end && i < 8; i += 1) {
    base[i] = hexNibble(checksum);
    checksum = (checksum >> 4) & 0x0fff;
  }
}

function initializeXpContext(name, ctx) {
  let pos = 0;
  let lastDot = null;
  let skipDots = name.length > 0 && name[0] === 46;
  while (true) {
    const next = next8dot3Char(name, pos, skipDots);
    const ch = next[0];
    pos = next[1];
    if (ch === 0) break;
    if (ch === 46) lastDot = pos;
    skipDots = false;
  }
  if (lastDot === name.length) lastDot = null;

  pos = 0;
  const stop = lastDot == null ? name.length + 1 : lastDot;
  ctx.base = [];
  while (pos < name.length && pos < stop && ctx.base.length < 6) {
    const next = next8dot3Char(name, pos, true);
    const ch = next[0];
    pos = next[1];
    if (ch === 0 || pos >= stop) break;
    ctx.base.push(ch);
  }

  if (ctx.base.length < 3) {
    ctx.checksum = checksumXp(name);
    const oldLen = ctx.base.length;
    appendChecksumNibbles(ctx.base, oldLen, oldLen + 4, ctx.checksum);
    ctx.checksumInserted = true;
  }

  if (lastDot == null) {
    ctx.ext = [];
  } else {
    pos = lastDot;
    ctx.ext = [46];
    while (ctx.ext.length < 4) {
      const next = next8dot3Char(name, pos, true);
      const ch = next[0];
      pos = next[1];
      if (ch === 0) break;
      ctx.ext.push(ch);
    }
  }
}

function generateXp83(name, ctx) {
  if (name.length === 0) throw new Error("empty names cannot generate XP 8.3 aliases");
  if (ctx.base.length === 0) initializeXpContext(name, ctx);
  ctx.lastIndex += 1;
  if (ctx.lastIndex > 4 && !ctx.checksumInserted) {
    ctx.checksum = checksumXp(name);
    appendChecksumNibbles(ctx.base, 2, 6, ctx.checksum);
    ctx.base = ctx.base.slice(0, 6);
    ctx.checksumInserted = true;
    ctx.lastIndex = 1;
  }

  let value = ctx.lastIndex;
  const digits = [];
  let allNines = true;
  do {
    const digit = 48 + (value % 10);
    digits.push(digit);
    if (digit !== 57) allNines = false;
    value = Math.floor(value / 10);
  } while (value !== 0 && digits.length < 11);

  const out = [...ctx.base, 126, ...digits.reverse(), ...ctx.ext];
  if (allNines && ctx.base.length > 0) ctx.base.pop();
  return out;
}

export function isLegalXpProfileShortComponent(component) {
  const name = toU16(component);
  if (name.length === 0 || name.length > 12) return false;
  for (const raw of name) {
    const ch = upcaseSimple(raw);
    if (ch >= 0x80 || (ch < 0x80 && invalidDosChar(ch))) return false;
  }
  if ((name.length === 1 && name[0] === 46) || (name.length === 2 && name[0] === 46 && name[1] === 46)) return true;

  let seenDot = false;
  for (let i = 0; i < name.length; i += 1) {
    const ch = upcaseSimple(name[i]);
    if (ch === 46) {
      if (seenDot || i === 0 || name[i - 1] === 32) return false;
      if (name.length - i - 1 > 3) return false;
      seenDot = true;
    }
    if (i >= 8 && !seenDot) return false;
  }
  return name[name.length - 1] !== 32 && name[name.length - 1] !== 46;
}

export function short83Component(username, aliasIndex = 1) {
  if (isLegalXpProfileShortComponent(username)) return username;
  const name = toU16(username);
  const ctx = { checksum: 0, checksumInserted: false, base: [], ext: [], lastIndex: 0 };
  let generated = [];
  for (let i = 0; i < Math.max(aliasIndex, 1); i += 1) {
    generated = generateXp83(name, ctx);
  }
  return String.fromCharCode(...generated);
}

export function pathTemplate(mode) {
  switch (mode) {
    case "xp":
    case "xp-short":
      return { head: "file:///C:/DOCUME~1/", tail: "/LOCALS~1/Temp/sv", defaultComponent: "User" };
    case "vista":
    case "vista-short":
      return { head: "file:///C:/Users/", tail: "/AppData/Local/Temp/sv", defaultComponent: "New Computer" };
    case "linux":
    case "linux-tmp":
      return { head: "file://", tail: "/sv", defaultComponent: "/tmp" };
    default:
      throw new Error(`unsupported mode: ${mode}`);
  }
}

export function expandUsernameCandidates(inputNames, { mode = "xp", shortAliasMax = 1 } = {}) {
  if (mode.startsWith("linux")) {
    return [{ input: "linux-tmp", component: "/tmp", aliasIndex: 0, klass: 4 }];
  }
  const names = inputNames.map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const needsAlias = !isLegalXpProfileShortComponent(raw);
    const firstAlias = needsAlias ? 1 : 0;
    const lastAlias = needsAlias ? Math.max(shortAliasMax, 1) : 0;
    for (let alias = firstAlias; alias <= lastAlias; alias++) {
      const component = short83Component(raw, alias || 1);
      if (!component || component.length > 12) throw new Error(`bad path component for username: ${raw}`);
      if (seen.has(component)) continue;
      seen.add(component);
      out.push({
        input: raw === "/tmp" ? "linux-tmp" : raw,
        component,
        aliasIndex: alias,
        klass: component.length === 8 ? 9 : component.length
      });
    }
  }
  return out;
}

export function timeValueBytes(sec, subsecond, mode) {
  const nanos = mode.startsWith("linux") ? subsecond * 1000 : subsecond * 1000000;
  const out = new Uint8Array(8);
  out[0] = sec & 255;
  out[1] = (sec >>> 8) & 255;
  out[2] = (sec >>> 16) & 255;
  out[3] = (sec >>> 24) & 255;
  out[4] = nanos & 255;
  out[5] = (nanos >>> 8) & 255;
  out[6] = (nanos >>> 16) & 255;
  out[7] = (nanos >>> 24) & 255;
  return out;
}

export function parseRangeList(text, { max }) {
  const trimmed = text.trim();
  if (trimmed === "all") return { all: true, values: null };
  const values = [];
  for (const itemRaw of trimmed.split(",")) {
    const item = itemRaw.trim();
    if (!item) continue;
    const dash = item.indexOf("-");
    if (dash < 0) {
      const value = Number.parseInt(item, 10);
      if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`range value must be in 0..${max}`);
      values.push(value);
    } else {
      const lo = Number.parseInt(item.slice(0, dash), 10);
      const hi = Number.parseInt(item.slice(dash + 1), 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > max) {
        throw new Error(`range must be in 0..${max}`);
      }
      for (let value = lo; value <= hi; value++) values.push(value);
    }
  }
  const sorted = Array.from(new Set(values)).sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error("range produced no values");
  return { all: false, values: sorted };
}

export function subsecondValues(mode, rangeText = "all") {
  const max = mode.startsWith("linux") ? 999999 : 999;
  const parsed = parseRangeList(rangeText, { max });
  if (!parsed.all) return parsed.values;
  return Array.from({ length: max + 1 }, (_, i) => i);
}

export function buildTimePrefixes(target, mode, { secondOffsetMin = 0, secondOffsetMax = 0, subsecondRange = "all" } = {}) {
  const subs = subsecondValues(mode, subsecondRange);
  const out = [];
  for (let off = secondOffsetMin; off <= secondOffsetMax; off++) {
    const sec = (target.creationEpochUtc + off) >>> 0;
    for (const sub of subs) out.push(timeValueBytes(sec, sub, mode));
  }
  return out;
}

export function buildPathPrefixBytes(timePrefix, component, mode) {
  const tmpl = pathTemplate(mode);
  return concatBytes(timePrefix, utf16leAscii(tmpl.head), utf16leAscii(component), utf16leAscii(tmpl.tail));
}

export function snapshotForPathPrefix(timePrefix, component, mode) {
  return new Md5().update(buildPathPrefixBytes(timePrefix, component, mode)).snapshot();
}

export function suffixBytes(session, delta) {
  const pdf = (session + delta) % N_COUNTERS;
  return utf16leAscii(`${counterText(session)}.tmp/sv${counterText(pdf)}.tmp`);
}

export function candidateDigestBytes(prefixSnapshot, infoBytes, session, delta) {
  return new Md5(prefixSnapshot).update(suffixBytes(session, delta)).update(infoBytes).digest();
}

export function candidateDigestHex(prefixSnapshot, infoBytes, session, delta) {
  return bytesToHex(candidateDigestBytes(prefixSnapshot, infoBytes, session, delta)).toUpperCase();
}

export function parseHashFileText(text) {
  const timePrefixes = [];
  let targetHex = "";
  let infoHex = "";
  const seen = new Set();
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const parts = line.split(":");
    if (parts.length !== 3) throw new Error("bad hash line, expected digest:salt1:salt2");
    const [digest, salt1Hex, salt2Hex] = parts;
    if (!targetHex) {
      targetHex = digest.toUpperCase();
      infoHex = salt2Hex.toUpperCase();
    } else if (digest.toUpperCase() !== targetHex || salt2Hex.toUpperCase() !== infoHex) {
      throw new Error("all hash lines must share target digest and info bytes");
    }
    const salt1 = hexToBytes(salt1Hex);
    if (salt1.length < 8) throw new Error("salt1 must begin with the 8-byte time value");
    const key = bytesToHex(salt1.slice(0, 8));
    if (!seen.has(key)) {
      seen.add(key);
      timePrefixes.push(salt1.slice(0, 8));
    }
  }
  if (!targetHex) throw new Error("hash file contained no lines");
  return { targetHex, targetBytes: hexToBytes(targetHex), infoHex, infoBytes: hexToBytes(infoHex), timePrefixes };
}

export function makePrefixRecords(timePrefixes, candidates, mode) {
  const records = [];
  for (let userIndex = 0; userIndex < candidates.length; userIndex++) {
    for (let timeIndex = 0; timeIndex < timePrefixes.length; timeIndex++) {
      records.push({
        userIndex,
        timeIndex,
        candidate: candidates[userIndex],
        snapshot: snapshotForPathPrefix(timePrefixes[timeIndex], candidates[userIndex].component, mode)
      });
    }
  }
  return records;
}
