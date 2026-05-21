import { bytesToHex } from "./md5.js";

function bytesToPdfString(bytes) {
  if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(bytes).toString("latin1");
  return new TextDecoder("latin1").decode(bytes);
}

function isPdfSpaceCode(code) {
  return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function parsePdfLiteral(raw, start) {
  if (raw[start] !== "(") throw new Error("internal PDF literal parse error");
  const out = [];
  let i = start + 1;
  let depth = 1;
  while (i < raw.length && depth > 0) {
    const ch = raw.charCodeAt(i++) & 255;
    if (ch === 0x5c) {
      if (i >= raw.length) break;
      const esc = raw.charCodeAt(i++) & 255;
      switch (esc) {
        case 0x6e: out.push(10); break;
        case 0x72: out.push(13); break;
        case 0x74: out.push(9); break;
        case 0x62: out.push(8); break;
        case 0x66: out.push(12); break;
        case 0x28:
        case 0x29:
        case 0x5c:
          out.push(esc);
          break;
        case 0x0d:
          if (i < raw.length && raw.charCodeAt(i) === 0x0a) i++;
          break;
        case 0x0a:
          break;
        default:
          if (esc >= 0x30 && esc <= 0x37) {
            let value = esc - 0x30;
            for (let n = 0; n < 2 && i < raw.length; n++) {
              const d = raw.charCodeAt(i) & 255;
              if (d < 0x30 || d > 0x37) break;
              value = value * 8 + (d - 0x30);
              i++;
            }
            out.push(value & 255);
          } else {
            out.push(esc);
          }
      }
    } else if (ch === 0x28) {
      depth++;
      out.push(ch);
    } else if (ch === 0x29) {
      depth--;
      if (depth > 0) out.push(ch);
    } else {
      out.push(ch);
    }
  }
  if (depth !== 0) throw new Error("unterminated PDF literal string");
  return { value: Uint8Array.from(out), next: i };
}

function parsePdfHexStringAsAscii(raw, start) {
  if (raw[start] !== "<") throw new Error("internal PDF hex parse error");
  const out = [];
  let i = start + 1;
  while (i < raw.length && raw[i] !== ">") {
    const ch = raw.charCodeAt(i++) & 255;
    if (!isPdfSpaceCode(ch)) out.push(ch);
  }
  if (i >= raw.length) throw new Error("unterminated PDF hex string");
  return { value: Uint8Array.from(out), next: i + 1 };
}

function extractRegexGroup(raw, re, label) {
  const match = raw.match(re);
  if (!match || !match[1]) throw new Error(`failed to find PDF ${label}`);
  return match[1];
}

function extractIndirectObject(raw, objNum) {
  const re = new RegExp(`(^|[\\r\\n])\\s*${objNum}\\s+0\\s+obj\\s*\\r?\\n`);
  const match = re.exec(raw);
  if (!match) throw new Error("failed to find PDF Info object");
  const begin = match.index + match[0].length;
  const end = raw.indexOf("endobj", begin);
  if (end < 0) throw new Error("unterminated PDF Info object");
  return raw.slice(begin, end);
}

function bytesToAscii(bytes) {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

export function reconstructPdfInfoValues(infoObj) {
  const values = [];
  let creationDate = "";
  for (let i = 0; i < infoObj.length; i++) {
    if (infoObj[i] !== "/") continue;
    const keyBegin = ++i;
    while (i < infoObj.length && /[A-Za-z0-9_-]/.test(infoObj[i])) i++;
    if (i === keyBegin) continue;
    const key = infoObj.slice(keyBegin, i);
    while (i < infoObj.length && isPdfSpaceCode(infoObj.charCodeAt(i) & 255)) i++;

    let parsed = null;
    if (infoObj[i] === "(") parsed = parsePdfLiteral(infoObj, i);
    else if (infoObj[i] === "<" && infoObj[i + 1] !== "<") parsed = parsePdfHexStringAsAscii(infoObj, i);
    if (!parsed) continue;

    values.push(parsed.value);
    if (key === "CreationDate") creationDate = bytesToAscii(parsed.value);
    i = parsed.next - 1;
  }
  if (!creationDate) throw new Error("PDF Info object has no CreationDate string");
  const total = values.reduce((n, v) => n + v.length, 0);
  if (total === 0) throw new Error("PDF Info object produced no reconstructable string values");
  const infoBytes = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    infoBytes.set(value, offset);
    offset += value.length;
  }
  return { infoBytes, creationDate };
}

function fixedDigits(s, pos, count, label) {
  if (pos + count > s.length) throw new Error(`short PDF CreationDate ${label}`);
  const text = s.slice(pos, pos + count);
  if (!/^\d+$/.test(text)) throw new Error(`bad PDF CreationDate ${label}`);
  return Number.parseInt(text, 10);
}

export function parsePdfDateEpochUtc(date) {
  if (date.length < 23 || !date.startsWith("D:")) throw new Error(`unsupported PDF CreationDate format: ${date}`);
  const year = fixedDigits(date, 2, 4, "year");
  const month = fixedDigits(date, 6, 2, "month") - 1;
  const day = fixedDigits(date, 8, 2, "day");
  const hour = fixedDigits(date, 10, 2, "hour");
  const minute = fixedDigits(date, 12, 2, "minute");
  const second = fixedDigits(date, 14, 2, "second");
  const sign = date[16];
  if (sign !== "+" && sign !== "-") throw new Error("PDF CreationDate must include numeric UTC offset");
  if (date[19] !== "'" || date[22] !== "'") throw new Error("PDF CreationDate timezone must look like +HH'MM'");
  const offH = fixedDigits(date, 17, 2, "tz hour");
  const offM = fixedDigits(date, 20, 2, "tz minute");
  let offset = offH * 3600 + offM * 60;
  if (sign === "-") offset = -offset;
  return Math.trunc(Date.UTC(year, month, day, hour, minute, second) / 1000) - offset;
}

export function parsePdfTarget(bytes, path = "") {
  const raw = bytesToPdfString(bytes);
  if (!raw) throw new Error("empty PDF file");
  const docIdHex = extractRegexGroup(raw, /\/ID\s*\[\s*<([0-9A-Fa-f]{32})>/, "/ID").toUpperCase();
  const infoObjNum = Number.parseInt(extractRegexGroup(raw, /\/Info\s+(\d+)\s+0\s+R/, "/Info reference"), 10);
  const infoObj = extractIndirectObject(raw, infoObjNum);
  const { infoBytes, creationDate } = reconstructPdfInfoValues(infoObj);
  const creationEpochUtc = parsePdfDateEpochUtc(creationDate);
  return {
    path,
    docIdHex,
    targetBytes: Uint8Array.from(docIdHex.match(/../g).map((h) => Number.parseInt(h, 16))),
    infoBytes,
    infoHex: bytesToHex(infoBytes).toUpperCase(),
    creationDate,
    creationEpochUtc
  };
}
