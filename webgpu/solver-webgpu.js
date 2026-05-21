import { loadDigestWords } from "./md5.js";
import { N_COUNTERS, counterText, utf16leAscii } from "./ooo24.js";

const DEFAULT_WORKGROUP_SIZE = 256;
const SUBSECOND_BATCH = 4096;
const DELTA_BATCH = 64;
const DEFAULT_SESSION_LANES = 1;
const MAX_MESSAGE_WORDS = 96;

function packBytesToWords(bytes) {
  const out = new Uint32Array(Math.max(1, Math.ceil(bytes.length / 4)));
  for (let i = 0; i < bytes.length; i++) out[i >> 2] |= bytes[i] << ((i & 3) * 8);
  return out;
}

function packComponents(candidates) {
  const out = new Uint32Array(candidates.length * 4);
  for (let i = 0; i < candidates.length; i++) {
    const text = candidates[i].component;
    if (text.length > 12) throw new Error(`path component is too long for the WebGPU solver: ${text}`);
    out[i * 4] = text.length;
    for (let j = 0; j < text.length; j++) {
      out[i * 4 + 1 + (j >> 2)] |= text.charCodeAt(j) << ((j & 3) * 8);
    }
  }
  return out;
}

const TAIL_CLASSES = 36;
const TAIL_WORDS = 48;
const TAIL_RECORD_WORDS = 1 + TAIL_WORDS;

function packTailTables({ candidates, mode, infoBytes, prehashPrefix }) {
  const parts = templateParts(mode);
  const headBytes = utf16leAscii(parts.head).length;
  const tailBytes = utf16leAscii(parts.tail).length;
  const out = new Uint32Array(candidates.length * TAIL_CLASSES * TAIL_RECORD_WORDS);
  for (let componentIndex = 0; componentIndex < candidates.length; componentIndex++) {
    const prefixLen = 8 + headBytes + candidates[componentIndex].component.length * 2 + tailBytes;
    const prefixRem = prehashPrefix ? prefixLen - 64 : prefixLen;
    for (let suffixLen = 0; suffixLen < TAIL_CLASSES; suffixLen++) {
      const variableBlocks = prefixRem + suffixLen > 64 ? 2 : 1;
      const variableBytes = variableBlocks * 64;
      const infoStart = Math.max(0, variableBytes - prefixRem - suffixLen);
      const totalLen = prefixLen + suffixLen + infoBytes.length;
      const tailLen = Math.max(0, infoBytes.length - infoStart);
      const padLen = ((tailLen + 1 + 8 + 63) >> 6) << 6;
      const bytes = new Uint8Array(padLen);
      if (infoStart < infoBytes.length) bytes.set(infoBytes.slice(infoStart), 0);
      bytes[tailLen] = 0x80;
      const bitLen = BigInt(totalLen) * 8n;
      const view = new DataView(bytes.buffer);
      view.setUint32(padLen - 8, Number(bitLen & 0xffffffffn), true);
      view.setUint32(padLen - 4, Number(bitLen >> 32n), true);
      const record = (componentIndex * TAIL_CLASSES + suffixLen) * TAIL_RECORD_WORDS;
      out[record] = padLen / 64;
      for (let i = 0; i < bytes.length; i++) {
        out[record + 1 + (i >> 2)] |= bytes[i] << ((i & 3) * 8);
      }
    }
  }
  return out;
}

let packedCounterTexts;

function counterTextWords() {
  if (packedCounterTexts) return packedCounterTexts;
  const out = new Uint32Array(N_COUNTERS * 4);
  for (let i = 0; i < N_COUNTERS; i++) {
    const bytes = utf16leAscii(counterText(i));
    const offset = i * 4;
    out[offset] = bytes.length;
    for (let j = 0; j < bytes.length; j++) {
      out[offset + 1 + (j >> 2)] |= bytes[j] << ((j & 3) * 8);
    }
  }
  packedCounterTexts = out;
  return out;
}

export function recommendedSessionLanes(mode) {
  if (mode?.startsWith("xp")) return 16;
  return 12;
}

export function recommendedWorkgroupSize(mode) {
  if (mode?.startsWith("linux")) return 64;
  if (mode?.startsWith("vista")) return 128;
  return 256;
}

function templateParts(mode) {
  if (mode.startsWith("linux")) return { head: "file://", tail: "/sv" };
  if (mode.startsWith("vista")) return { head: "file:///C:/Users/", tail: "/AppData/Local/Temp/sv" };
  return { head: "file:///C:/DOCUME~1/", tail: "/LOCALS~1/Temp/sv" };
}

export function requiredMessageWords({ infoBytes, candidates, mode }) {
  const parts = templateParts(mode);
  const head = utf16leAscii(parts.head);
  const tail = utf16leAscii(parts.tail);
  const maxComponentBytes = candidates.reduce((max, candidate) => Math.max(max, candidate.component.length * 2), 0);
  const maxMessageBytes = 8 + head.length + maxComponentBytes + tail.length + 34 + infoBytes.length;
  return Math.ceil((maxMessageBytes + 1 + 8) / 64) * 16;
}

export function shouldPrehashPrefix(mode) {
  return !mode?.startsWith("linux");
}

export function webgpuShaderSource({
  sessionLanes = DEFAULT_SESSION_LANES,
  messageWords = MAX_MESSAGE_WORDS,
  prehashPrefix = false,
  workgroupSize = DEFAULT_WORKGROUP_SIZE,
  mode = ""
} = {}) {
  const prehashShared = prehashPrefix ? `
var<workgroup> shared_tail_words: array<u32, ${messageWords}>;
var<workgroup> shared_prefix_total_len: u32;
var<workgroup> shared_state: vec4<u32>;
` : "";
  const prehashHelper = prehashPrefix ? `
fn shared_tail_put_byte(pos: u32, value: u32) {
  shared_tail_words[pos >> 2u] = shared_tail_words[pos >> 2u] | ((value & 255u) << ((pos & 3u) * 8u));
}
` : "";
  const prehashSetup = prehashPrefix ? `
    for (var i = 0u; i < ${messageWords}u; i = i + 1u) { shared_tail_words[i] = 0u; }
    var prefix_words: array<u32, ${messageWords}>;
    for (var i = 0u; i < 16u; i = i + 1u) { prefix_words[i] = shared_words[i]; }
    var prefix_state = vec4<u32>(0x67452301u, 0xefcdab89u, 0x98badcfeu, 0x10325476u);
    md5_transform_words(&prefix_state, &prefix_words, 0u);
    let copy_len = shared_pos - 64u;
    for (var i = 0u; i < copy_len; i = i + 1u) {
      let from_pos = 64u + i;
      let word = shared_words[from_pos >> 2u];
      shared_tail_put_byte(i, (word >> ((from_pos & 3u) * 8u)) & 255u);
    }
    shared_state = prefix_state;
    shared_prefix_pos = copy_len;
    shared_prefix_total_len = shared_pos;
` : `
    shared_prefix_pos = shared_pos;
`;
  const localPrefixCopy = prehashPrefix ? `
    let prefix_word_count = (shared_prefix_pos + 3u) >> 2u;
    for (var i = 0u; i < prefix_word_count; i = i + 1u) {
      words[i] = shared_tail_words[i];
    }
` : `
    let prefix_word_count = (shared_prefix_pos + 3u) >> 2u;
    for (var i = 0u; i < prefix_word_count; i = i + 1u) {
      words[i] = shared_words[i];
    }
`;
  const xpHot3Path = prehashPrefix && mode.startsWith("xp") ? `
    if (hot3 && params.mode == 0u && components[component_index].len == 4u && shared_prefix_pos == 26u && params.info_len >= 4u) {
      let s_counter = counter_texts[session];
      let p_counter = counter_texts[pdf];
      var state = shared_state;
      md5_transform_scalar(
        &state,
        shared_tail_words[0],
        shared_tail_words[1],
        shared_tail_words[2],
        shared_tail_words[3],
        shared_tail_words[4],
        shared_tail_words[5],
        (shared_tail_words[6] & 0xffffu) | ((s_counter.b0 & 255u) << 16u),
        ((s_counter.b0 >> 16u) & 255u) | ((s_counter.b1 & 255u) << 16u),
        0x0074002eu,
        0x0070006du,
        0x0073002fu,
        0x00000076u | ((p_counter.b0 & 255u) << 16u),
        ((p_counter.b0 >> 16u) & 255u) | ((p_counter.b1 & 255u) << 16u),
        0x0074002eu,
        0x0070006du,
        info_words[0]
      );
      let tail_index = component_index * ${TAIL_CLASSES}u + 34u;
      let tail_count = tail_tables[tail_index].count;
      if (tail_count > 0u) { md5_transform_tail_table(&state, tail_index, 0u); }
      if (tail_count > 1u) { md5_transform_tail_table(&state, tail_index, 1u); }
      if (tail_count > 2u) { md5_transform_tail_table(&state, tail_index, 2u); }
      if (all(state == params.digest)) {
        output.component_index = component_index;
        output.time_index = subsecond;
        output.delta = delta;
        output.session = session;
        atomicStore(&output.found, 1u);
      }
      continue;
    }
` : "";
  const vistaHot3Path = prehashPrefix && mode.startsWith("vista") ? `
    if (hot3 && params.mode == 1u && shared_prefix_pos == 38u && params.info_len >= 56u) {
      let s_counter = counter_texts[session];
      let p_counter = counter_texts[pdf];
      var state = shared_state;
      md5_transform_scalar(
        &state,
        shared_tail_words[0],
        shared_tail_words[1],
        shared_tail_words[2],
        shared_tail_words[3],
        shared_tail_words[4],
        shared_tail_words[5],
        shared_tail_words[6],
        shared_tail_words[7],
        shared_tail_words[8],
        (shared_tail_words[9] & 0xffffu) | ((s_counter.b0 & 255u) << 16u),
        ((s_counter.b0 >> 16u) & 255u) | ((s_counter.b1 & 255u) << 16u),
        0x0074002eu,
        0x0070006du,
        0x0073002fu,
        0x00000076u | ((p_counter.b0 & 255u) << 16u),
        ((p_counter.b0 >> 16u) & 255u) | ((p_counter.b1 & 255u) << 16u),
      );
      md5_transform_scalar(
        &state,
        0x0074002eu,
        0x0070006du,
        info_words[0],
        info_words[1],
        info_words[2],
        info_words[3],
        info_words[4],
        info_words[5],
        info_words[6],
        info_words[7],
        info_words[8],
        info_words[9],
        info_words[10],
        info_words[11],
        info_words[12],
        info_words[13]
      );
      let tail_index = component_index * ${TAIL_CLASSES}u + 34u;
      let tail_count = tail_tables[tail_index].count;
      if (tail_count > 0u) { md5_transform_tail_table(&state, tail_index, 0u); }
      if (tail_count > 1u) { md5_transform_tail_table(&state, tail_index, 1u); }
      if (tail_count > 2u) { md5_transform_tail_table(&state, tail_index, 2u); }
      if (all(state == params.digest)) {
        output.component_index = component_index;
        output.time_index = subsecond;
        output.delta = delta;
        output.session = session;
        atomicStore(&output.found, 1u);
      }
      continue;
    }
` : "";
  const prehashHot3Path = `${xpHot3Path}${vistaHot3Path}`;
  const linuxHot3Path = mode.startsWith("linux") ? `
    if (hot3 && params.mode == 2u && components[component_index].len == 4u && components[component_index].b0 == 0x706d742fu && params.info_len >= 58u) {
      let s_counter = counter_texts[session];
      let p_counter = counter_texts[pdf];
      var state = vec4<u32>(0x67452301u, 0xefcdab89u, 0x98badcfeu, 0x10325476u);
      md5_transform_scalar(
        &state,
        params.epoch,
        nanos,
        0x00690066u,
        0x0065006cu,
        0x002f003au,
        0x002f002fu,
        0x006d0074u,
        0x002f0070u,
        0x00760073u,
        s_counter.b0,
        (s_counter.b1 & 255u) | 0x002e0000u,
        0x006d0074u,
        0x002f0070u,
        0x00760073u,
        p_counter.b0,
        (p_counter.b1 & 255u) | 0x002e0000u
      );
      md5_transform_scalar(
        &state,
        0x006d0074u,
        0x00000070u | (get_info_byte(0u) << 16u) | (get_info_byte(1u) << 24u),
        get_info_word4(2u),
        get_info_word4(6u),
        get_info_word4(10u),
        get_info_word4(14u),
        get_info_word4(18u),
        get_info_word4(22u),
        get_info_word4(26u),
        get_info_word4(30u),
        get_info_word4(34u),
        get_info_word4(38u),
        get_info_word4(42u),
        get_info_word4(46u),
        get_info_word4(50u),
        get_info_word4(54u)
      );
      let tail_index = component_index * ${TAIL_CLASSES}u + 34u;
      let tail_count = tail_tables[tail_index].count;
      if (tail_count > 0u) { md5_transform_tail_table(&state, tail_index, 0u); }
      if (tail_count > 1u) { md5_transform_tail_table(&state, tail_index, 1u); }
      if (tail_count > 2u) { md5_transform_tail_table(&state, tail_index, 2u); }
      if (all(state == params.digest)) {
        output.component_index = component_index;
        output.time_index = subsecond;
        output.delta = delta;
        output.session = session;
        atomicStore(&output.found, 1u);
      }
      continue;
    }
` : "";
  const totalLengthExpr = prehashPrefix ? "shared_prefix_total_len + (pos - shared_prefix_pos)" : "pos";
  const stateInitExpr = prehashPrefix ? "shared_state" : "vec4<u32>(0x67452301u, 0xefcdab89u, 0x98badcfeu, 0x10325476u)";
  return `
struct Params {
  digest: vec4<u32>,
  info_len: u32,
  head_len: u32,
  tail_len: u32,
  mode: u32,
  epoch: u32,
  subsecond_start: u32,
  subsecond_count: u32,
  delta_start: u32,
  session_start: u32,
  session_count: u32,
  component_count: u32,
  time_base: u32,
};

struct Component {
  len: u32,
  b0: u32,
  b1: u32,
  b2: u32,
};

struct CounterText {
  len: u32,
  b0: u32,
  b1: u32,
  _pad: u32,
};

struct Output {
  found: atomic<u32>,
  component_index: u32,
  time_index: u32,
  delta: u32,
  session: u32,
};

struct TailBlocks {
  count: u32,
  words: array<u32, ${TAIL_WORDS}>,
};

@group(0) @binding(0) var<storage, read> info_words: array<u32>;
@group(0) @binding(1) var<storage, read> head_words: array<u32>;
@group(0) @binding(2) var<storage, read> tail_words: array<u32>;
@group(0) @binding(3) var<storage, read> components: array<Component>;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var<storage, read_write> output: Output;
@group(0) @binding(6) var<storage, read> counter_texts: array<CounterText>;
@group(0) @binding(7) var<storage, read> tail_tables: array<TailBlocks>;
@group(0) @binding(8) var<storage, read> subsecond_values: array<u32>;

var<workgroup> shared_words: array<u32, ${messageWords}>;
var<workgroup> shared_prefix_pos: u32;
${prehashShared}

fn rotl32(x: u32, n: u32) -> u32 { return (x << n) | (x >> (32u - n)); }
fn md5_f(x: u32, y: u32, z: u32) -> u32 { return z ^ (x & (y ^ z)); }
fn md5_g(x: u32, y: u32, z: u32) -> u32 { return y ^ (z & (x ^ y)); }
fn md5_h(x: u32, y: u32, z: u32) -> u32 { return x ^ y ^ z; }
fn md5_i(x: u32, y: u32, z: u32) -> u32 { return y ^ (x | (~z)); }
fn step_f(a: u32, b: u32, c: u32, d: u32, x: u32, k: u32, s: u32) -> u32 { return rotl32(a + md5_f(b, c, d) + x + k, s) + b; }
fn step_g(a: u32, b: u32, c: u32, d: u32, x: u32, k: u32, s: u32) -> u32 { return rotl32(a + md5_g(b, c, d) + x + k, s) + b; }
fn step_h(a: u32, b: u32, c: u32, d: u32, x: u32, k: u32, s: u32) -> u32 { return rotl32(a + md5_h(b, c, d) + x + k, s) + b; }
fn step_i(a: u32, b: u32, c: u32, d: u32, x: u32, k: u32, s: u32) -> u32 { return rotl32(a + md5_i(b, c, d) + x + k, s) + b; }

fn word_put_byte(words: ptr<function, array<u32, ${messageWords}>>, pos: u32, value: u32) {
  (*words)[pos >> 2u] = (*words)[pos >> 2u] | ((value & 255u) << ((pos & 3u) * 8u));
}

fn shared_put_byte(pos: u32, value: u32) {
  shared_words[pos >> 2u] = shared_words[pos >> 2u] | ((value & 255u) << ((pos & 3u) * 8u));
}
${prehashHelper}

fn get_info_byte(pos: u32) -> u32 {
  let word = info_words[pos >> 2u];
  return (word >> ((pos & 3u) * 8u)) & 255u;
}

fn get_info_word4(pos: u32) -> u32 {
  return get_info_byte(pos) |
    (get_info_byte(pos + 1u) << 8u) |
    (get_info_byte(pos + 2u) << 16u) |
    (get_info_byte(pos + 3u) << 24u);
}

fn get_head_byte(pos: u32) -> u32 {
  let word = head_words[pos >> 2u];
  return (word >> ((pos & 3u) * 8u)) & 255u;
}

fn get_tail_byte(pos: u32) -> u32 {
  let word = tail_words[pos >> 2u];
  return (word >> ((pos & 3u) * 8u)) & 255u;
}

fn put_u32_le(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>, value: u32) {
  word_put_byte(words, *pos + 0u, value & 255u);
  word_put_byte(words, *pos + 1u, (value >> 8u) & 255u);
  word_put_byte(words, *pos + 2u, (value >> 16u) & 255u);
  word_put_byte(words, *pos + 3u, (value >> 24u) & 255u);
  *pos = *pos + 4u;
}

fn shared_put_u32_le(pos: ptr<function, u32>, value: u32) {
  shared_put_byte(*pos + 0u, value & 255u);
  shared_put_byte(*pos + 1u, (value >> 8u) & 255u);
  shared_put_byte(*pos + 2u, (value >> 16u) & 255u);
  shared_put_byte(*pos + 3u, (value >> 24u) & 255u);
  *pos = *pos + 4u;
}

fn put_info_bytes(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>) {
  for (var i = 0u; i < params.info_len; i = i + 1u) {
    word_put_byte(words, *pos, get_info_byte(i));
    *pos = *pos + 1u;
  }
}

fn put_head_bytes(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>) {
  for (var i = 0u; i < params.head_len; i = i + 1u) {
    word_put_byte(words, *pos, get_head_byte(i));
    *pos = *pos + 1u;
  }
}

fn shared_put_head_bytes(pos: ptr<function, u32>) {
  for (var i = 0u; i < params.head_len; i = i + 1u) {
    shared_put_byte(*pos, get_head_byte(i));
    *pos = *pos + 1u;
  }
}

fn put_tail_bytes(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>) {
  for (var i = 0u; i < params.tail_len; i = i + 1u) {
    word_put_byte(words, *pos, get_tail_byte(i));
    *pos = *pos + 1u;
  }
}

fn shared_put_tail_bytes(pos: ptr<function, u32>) {
  for (var i = 0u; i < params.tail_len; i = i + 1u) {
    shared_put_byte(*pos, get_tail_byte(i));
    *pos = *pos + 1u;
  }
}

fn component_byte(c: Component, index: u32) -> u32 {
  var word = c.b0;
  if (index >= 8u) {
    word = c.b2;
  } else if (index >= 4u) {
    word = c.b1;
  }
  return (word >> ((index & 3u) * 8u)) & 255u;
}

fn put_component_utf16(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>, c: Component) {
  for (var i = 0u; i < c.len; i = i + 1u) {
    word_put_byte(words, *pos, component_byte(c, i));
    *pos = *pos + 1u;
    word_put_byte(words, *pos, 0u);
    *pos = *pos + 1u;
  }
}

fn shared_put_component_utf16(pos: ptr<function, u32>, c: Component) {
  for (var i = 0u; i < c.len; i = i + 1u) {
    shared_put_byte(*pos, component_byte(c, i));
    *pos = *pos + 1u;
    shared_put_byte(*pos, 0u);
    *pos = *pos + 1u;
  }
}

fn put_utf16_char(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>, ch: u32) {
  word_put_byte(words, *pos, ch);
  *pos = *pos + 1u;
  word_put_byte(words, *pos, 0u);
  *pos = *pos + 1u;
}

fn put_counter(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>, raw_value: u32) {
  let counter = counter_texts[raw_value];
  for (var i = 0u; i < counter.len; i = i + 1u) {
    let word = select(counter.b1, counter.b0, i < 4u);
    word_put_byte(words, *pos, (word >> ((i & 3u) * 8u)) & 255u);
    *pos = *pos + 1u;
  }
}

fn put_counter3(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>, raw_value: u32) {
  let counter = counter_texts[raw_value];
  word_put_byte(words, *pos + 0u, counter.b0 & 255u);
  word_put_byte(words, *pos + 1u, (counter.b0 >> 8u) & 255u);
  word_put_byte(words, *pos + 2u, (counter.b0 >> 16u) & 255u);
  word_put_byte(words, *pos + 3u, (counter.b0 >> 24u) & 255u);
  word_put_byte(words, *pos + 4u, counter.b1 & 255u);
  word_put_byte(words, *pos + 5u, (counter.b1 >> 8u) & 255u);
  *pos = *pos + 6u;
}

fn put_tmp_separator(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>) {
  put_utf16_char(words, pos, 46u);
  put_utf16_char(words, pos, 116u);
  put_utf16_char(words, pos, 109u);
  put_utf16_char(words, pos, 112u);
  put_utf16_char(words, pos, 47u);
  put_utf16_char(words, pos, 115u);
  put_utf16_char(words, pos, 118u);
}

fn put_dot_tmp(words: ptr<function, array<u32, ${messageWords}>>, pos: ptr<function, u32>) {
  put_utf16_char(words, pos, 46u);
  put_utf16_char(words, pos, 116u);
  put_utf16_char(words, pos, 109u);
  put_utf16_char(words, pos, 112u);
}

fn md5_transform_scalar(
  state: ptr<function, vec4<u32>>,
  w0: u32, w1: u32, w2: u32, w3: u32,
  w4: u32, w5: u32, w6: u32, w7: u32,
  w8: u32, w9: u32, wa: u32, wb: u32,
  wc: u32, wd: u32, we: u32, wf: u32
) {
  var a = (*state).x;
  var b = (*state).y;
  var c = (*state).z;
  var d = (*state).w;
  a = step_f(a,b,c,d, w0, 0xd76aa478u,  7u); d = step_f(d,a,b,c, w1, 0xe8c7b756u, 12u);
  c = step_f(c,d,a,b, w2, 0x242070dbu, 17u); b = step_f(b,c,d,a, w3, 0xc1bdceeeu, 22u);
  a = step_f(a,b,c,d, w4, 0xf57c0fafu,  7u); d = step_f(d,a,b,c, w5, 0x4787c62au, 12u);
  c = step_f(c,d,a,b, w6, 0xa8304613u, 17u); b = step_f(b,c,d,a, w7, 0xfd469501u, 22u);
  a = step_f(a,b,c,d, w8, 0x698098d8u,  7u); d = step_f(d,a,b,c, w9, 0x8b44f7afu, 12u);
  c = step_f(c,d,a,b, wa, 0xffff5bb1u, 17u); b = step_f(b,c,d,a, wb, 0x895cd7beu, 22u);
  a = step_f(a,b,c,d, wc, 0x6b901122u,  7u); d = step_f(d,a,b,c, wd, 0xfd987193u, 12u);
  c = step_f(c,d,a,b, we, 0xa679438eu, 17u); b = step_f(b,c,d,a, wf, 0x49b40821u, 22u);
  a = step_g(a,b,c,d, w1, 0xf61e2562u,  5u); d = step_g(d,a,b,c, w6, 0xc040b340u,  9u);
  c = step_g(c,d,a,b, wb, 0x265e5a51u, 14u); b = step_g(b,c,d,a, w0, 0xe9b6c7aau, 20u);
  a = step_g(a,b,c,d, w5, 0xd62f105du,  5u); d = step_g(d,a,b,c, wa, 0x02441453u,  9u);
  c = step_g(c,d,a,b, wf, 0xd8a1e681u, 14u); b = step_g(b,c,d,a, w4, 0xe7d3fbc8u, 20u);
  a = step_g(a,b,c,d, w9, 0x21e1cde6u,  5u); d = step_g(d,a,b,c, we, 0xc33707d6u,  9u);
  c = step_g(c,d,a,b, w3, 0xf4d50d87u, 14u); b = step_g(b,c,d,a, w8, 0x455a14edu, 20u);
  a = step_g(a,b,c,d, wd, 0xa9e3e905u,  5u); d = step_g(d,a,b,c, w2, 0xfcefa3f8u,  9u);
  c = step_g(c,d,a,b, w7, 0x676f02d9u, 14u); b = step_g(b,c,d,a, wc, 0x8d2a4c8au, 20u);
  a = step_h(a,b,c,d, w5, 0xfffa3942u,  4u); d = step_h(d,a,b,c, w8, 0x8771f681u, 11u);
  c = step_h(c,d,a,b, wb, 0x6d9d6122u, 16u); b = step_h(b,c,d,a, we, 0xfde5380cu, 23u);
  a = step_h(a,b,c,d, w1, 0xa4beea44u,  4u); d = step_h(d,a,b,c, w4, 0x4bdecfa9u, 11u);
  c = step_h(c,d,a,b, w7, 0xf6bb4b60u, 16u); b = step_h(b,c,d,a, wa, 0xbebfbc70u, 23u);
  a = step_h(a,b,c,d, wd, 0x289b7ec6u,  4u); d = step_h(d,a,b,c, w0, 0xeaa127fau, 11u);
  c = step_h(c,d,a,b, w3, 0xd4ef3085u, 16u); b = step_h(b,c,d,a, w6, 0x04881d05u, 23u);
  a = step_h(a,b,c,d, w9, 0xd9d4d039u,  4u); d = step_h(d,a,b,c, wc, 0xe6db99e5u, 11u);
  c = step_h(c,d,a,b, wf, 0x1fa27cf8u, 16u); b = step_h(b,c,d,a, w2, 0xc4ac5665u, 23u);
  a = step_i(a,b,c,d, w0, 0xf4292244u,  6u); d = step_i(d,a,b,c, w7, 0x432aff97u, 10u);
  c = step_i(c,d,a,b, we, 0xab9423a7u, 15u); b = step_i(b,c,d,a, w5, 0xfc93a039u, 21u);
  a = step_i(a,b,c,d, wc, 0x655b59c3u,  6u); d = step_i(d,a,b,c, w3, 0x8f0ccc92u, 10u);
  c = step_i(c,d,a,b, wa, 0xffeff47du, 15u); b = step_i(b,c,d,a, w1, 0x85845dd1u, 21u);
  a = step_i(a,b,c,d, w8, 0x6fa87e4fu,  6u); d = step_i(d,a,b,c, wf, 0xfe2ce6e0u, 10u);
  c = step_i(c,d,a,b, w6, 0xa3014314u, 15u); b = step_i(b,c,d,a, wd, 0x4e0811a1u, 21u);
  a = step_i(a,b,c,d, w4, 0xf7537e82u,  6u); d = step_i(d,a,b,c, wb, 0xbd3af235u, 10u);
  c = step_i(c,d,a,b, w2, 0x2ad7d2bbu, 15u); b = step_i(b,c,d,a, w9, 0xeb86d391u, 21u);
  *state = vec4<u32>((*state).x + a, (*state).y + b, (*state).z + c, (*state).w + d);
}

fn md5_transform_words(state: ptr<function, vec4<u32>>, words: ptr<function, array<u32, ${messageWords}>>, block_word: u32) {
  let base = block_word;
  md5_transform_scalar(
    state,
    (*words)[base+ 0u], (*words)[base+ 1u], (*words)[base+ 2u], (*words)[base+ 3u],
    (*words)[base+ 4u], (*words)[base+ 5u], (*words)[base+ 6u], (*words)[base+ 7u],
    (*words)[base+ 8u], (*words)[base+ 9u], (*words)[base+10u], (*words)[base+11u],
    (*words)[base+12u], (*words)[base+13u], (*words)[base+14u], (*words)[base+15u]
  );
}

fn md5_transform_tail_table(state: ptr<function, vec4<u32>>, tail_index: u32, block: u32) {
  let base = block * 16u;
  md5_transform_scalar(
    state,
    tail_tables[tail_index].words[base+ 0u], tail_tables[tail_index].words[base+ 1u],
    tail_tables[tail_index].words[base+ 2u], tail_tables[tail_index].words[base+ 3u],
    tail_tables[tail_index].words[base+ 4u], tail_tables[tail_index].words[base+ 5u],
    tail_tables[tail_index].words[base+ 6u], tail_tables[tail_index].words[base+ 7u],
    tail_tables[tail_index].words[base+ 8u], tail_tables[tail_index].words[base+ 9u],
    tail_tables[tail_index].words[base+10u], tail_tables[tail_index].words[base+11u],
    tail_tables[tail_index].words[base+12u], tail_tables[tail_index].words[base+13u],
    tail_tables[tail_index].words[base+14u], tail_tables[tail_index].words[base+15u]
  );
}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let subsecond = subsecond_values[params.subsecond_start + gid.y];
  let nanos = select(subsecond * 1000000u, subsecond * 1000u, params.mode == 2u);
  let delta_index = gid.z / params.component_count;
  let component_index = gid.z - delta_index * params.component_count;
  let in_range = gid.x * ${sessionLanes}u < params.session_count && gid.y < params.subsecond_count && component_index < params.component_count;

  if (lid.x == 0u) {
    for (var i = 0u; i < ${messageWords}u; i = i + 1u) { shared_words[i] = 0u; }
    var shared_pos = 0u;
    shared_put_u32_le(&shared_pos, params.epoch);
    shared_put_u32_le(&shared_pos, nanos);
    shared_put_head_bytes(&shared_pos);
    shared_put_component_utf16(&shared_pos, components[component_index]);
    shared_put_tail_bytes(&shared_pos);
${prehashSetup}
  }
  workgroupBarrier();

  if (!in_range || atomicLoad(&output.found) != 0xffffffffu) { return; }

  let delta = params.delta_start + delta_index;
  for (var lane = 0u; lane < ${sessionLanes}u; lane = lane + 1u) {
    let session_offset = gid.x * ${sessionLanes}u + lane;
    if (session_offset >= params.session_count) { continue; }
    let session = params.session_start + session_offset;
    var words: array<u32, ${messageWords}>;
${localPrefixCopy}
    var pos = shared_prefix_pos;
    let pdf_sum = session + delta;
    var pdf = pdf_sum;
    if (pdf >= ${N_COUNTERS}u) { pdf = pdf - ${N_COUNTERS}u; }
    let hot3 = session >= 676u && pdf_sum < ${N_COUNTERS}u && pdf >= 676u;
${prehashHot3Path}
${linuxHot3Path}
    if (hot3) {
      put_counter3(&words, &pos, session);
    } else {
      put_counter(&words, &pos, session);
    }
    put_tmp_separator(&words, &pos);
    if (hot3) {
      put_counter3(&words, &pos, pdf);
    } else {
      put_counter(&words, &pos, pdf);
    }
    put_dot_tmp(&words, &pos);
    let suffix_len = pos - shared_prefix_pos;
    let suffix_end = pos;
    let variable_bytes = select(128u, 64u, pos <= 64u);
    let info_capacity = variable_bytes - suffix_end;
    let inline_info_len = min(params.info_len, info_capacity);
    for (var i = 0u; pos < variable_bytes; i = i + 1u) {
      var value = 0u;
      if (i < params.info_len) {
        value = get_info_byte(i);
      }
      word_put_byte(&words, pos, value);
      pos = pos + 1u;
    }
    let inline_end = suffix_end + inline_info_len;
    let inline_padded_len = ((inline_end + 1u + 8u + 63u) / 64u) * 64u;
    let pad_in_variable = params.info_len <= info_capacity && inline_padded_len <= variable_bytes;
    if (pad_in_variable) {
      word_put_byte(&words, inline_end, 0x80u);
      let total_len = ${prehashPrefix ? "shared_prefix_total_len + suffix_len + params.info_len" : "shared_prefix_pos + suffix_len + params.info_len"};
      let bit_len_low = total_len << 3u;
      let bit_len_high = total_len >> 29u;
      word_put_byte(&words, inline_padded_len - 8u, bit_len_low & 255u);
      word_put_byte(&words, inline_padded_len - 7u, (bit_len_low >> 8u) & 255u);
      word_put_byte(&words, inline_padded_len - 6u, (bit_len_low >> 16u) & 255u);
      word_put_byte(&words, inline_padded_len - 5u, (bit_len_low >> 24u) & 255u);
      word_put_byte(&words, inline_padded_len - 4u, bit_len_high & 255u);
      word_put_byte(&words, inline_padded_len - 3u, (bit_len_high >> 8u) & 255u);
      word_put_byte(&words, inline_padded_len - 2u, (bit_len_high >> 16u) & 255u);
      word_put_byte(&words, inline_padded_len - 1u, (bit_len_high >> 24u) & 255u);
    }

    var state = ${stateInitExpr};
    let transformed_bytes = select(variable_bytes, inline_padded_len, pad_in_variable);
    for (var block = 0u; block < transformed_bytes / 64u; block = block + 1u) {
      md5_transform_words(&state, &words, block * 16u);
    }
    let tail_index = component_index * ${TAIL_CLASSES}u + suffix_len;
    let tail_count = select(tail_tables[tail_index].count, 0u, pad_in_variable);
    if (tail_count > 0u) { md5_transform_tail_table(&state, tail_index, 0u); }
    if (tail_count > 1u) { md5_transform_tail_table(&state, tail_index, 1u); }
    if (tail_count > 2u) { md5_transform_tail_table(&state, tail_index, 2u); }
    if (all(state == params.digest)) {
      output.component_index = component_index;
      output.time_index = subsecond;
      output.delta = delta;
      output.session = session;
      atomicStore(&output.found, 1u);
    }
  }
}
`;
}

function createBuffer(device, data, usage) {
  const buffer = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  const view = new Uint32Array(buffer.getMappedRange());
  view.set(data);
  buffer.unmap();
  return buffer;
}

async function readOutput(device, outputBuffer) {
  const readBuffer = device.createBuffer({ size: 20, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, 20);
  device.queue.submit([encoder.finish()]);
  await readBuffer.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(readBuffer.getMappedRange()).slice();
  readBuffer.destroy();
  return out;
}

export async function createWebGpuSolver({
  sessionLanes = DEFAULT_SESSION_LANES,
  messageWords = MAX_MESSAGE_WORDS,
  prehashPrefix = false,
  workgroupSize = DEFAULT_WORKGROUP_SIZE,
  mode = ""
} = {}) {
  if (!globalThis.navigator?.gpu) throw new Error("WebGPU is not available in this browser");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter is available");
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: webgpuShaderSource({ sessionLanes, messageWords, prehashPrefix, workgroupSize, mode }) });
  if (module.getCompilationInfo) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((message) => `WGSL ${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
    }
  }
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  return { device, pipeline, sessionLanes, messageWords, prehashPrefix, workgroupSize, mode };
}

function modeId(mode) {
  if (mode.startsWith("linux")) return 2;
  if (mode.startsWith("vista")) return 1;
  return 0;
}

export async function scanWebGpu({
  solver,
  targetBytes,
  infoBytes,
  candidates,
  mode,
  epoch,
  subsecondStart = 0,
  subsecondCount,
  subsecondValues,
  timeBase = 0,
  deltaStart = 0,
  deltaCount = 1,
  sessionStart = 0,
  sessionCount = N_COUNTERS,
  signal,
  onProgress,
  subsecondBatch = SUBSECOND_BATCH,
  deltaBatch = DELTA_BATCH
}) {
  const requiredWords = requiredMessageWords({ infoBytes, candidates, mode });
  if (requiredWords > MAX_MESSAGE_WORDS) {
    throw new Error(`PDF metadata is too large for the optimized WebGPU kernel (${infoBytes.length} info bytes)`);
  }
  const {
    device,
    pipeline,
    sessionLanes = DEFAULT_SESSION_LANES,
    messageWords = MAX_MESSAGE_WORDS,
    workgroupSize = DEFAULT_WORKGROUP_SIZE
  } = solver || await createWebGpuSolver({
    sessionLanes: recommendedSessionLanes(mode),
    messageWords: requiredWords,
    prehashPrefix: shouldPrehashPrefix(mode),
    workgroupSize: recommendedWorkgroupSize(mode),
    mode
  });
  const prehashPrefix = solver?.prehashPrefix ?? shouldPrehashPrefix(mode);
  if (requiredWords > messageWords) {
    throw new Error(`WebGPU solver was compiled for ${messageWords} words but this target needs ${requiredWords}`);
  }
  const parts = templateParts(mode);
  const head = utf16leAscii(parts.head);
  const tail = utf16leAscii(parts.tail);
  const millisValues = subsecondValues
    ? Uint32Array.from(subsecondValues)
    : Uint32Array.from({ length: subsecondCount }, (_, i) => subsecondStart + i);
  if (millisValues.length === 0) throw new Error("subsecondValues produced no values");
  const buffers = {
    info: createBuffer(device, packBytesToWords(infoBytes), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    head: createBuffer(device, packBytesToWords(head), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    tail: createBuffer(device, packBytesToWords(tail), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    components: createBuffer(device, packComponents(candidates), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    counters: createBuffer(device, counterTextWords(), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    tails: createBuffer(device, packTailTables({ candidates, mode, infoBytes, prehashPrefix }), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    subseconds: createBuffer(device, millisValues, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  };
  const total = candidates.length * millisValues.length * deltaCount * sessionCount;
  const targetWords = loadDigestWords(targetBytes);
  let processed = 0;

  try {
    for (let subOffset = 0; subOffset < millisValues.length; subOffset += subsecondBatch) {
      const thisSubCount = Math.min(subsecondBatch, millisValues.length - subOffset);
      for (let deltaOffset = 0; deltaOffset < deltaCount; deltaOffset += deltaBatch) {
        if (signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
        const thisDeltaCount = Math.min(deltaBatch, deltaCount - deltaOffset);
        const params = new Uint32Array(20);
        params.set(targetWords, 0);
        params[4] = infoBytes.length;
        params[5] = head.length;
        params[6] = tail.length;
        params[7] = modeId(mode);
        params[8] = epoch >>> 0;
        params[9] = subOffset;
        params[10] = thisSubCount;
        params[11] = deltaStart + deltaOffset;
        params[12] = sessionStart;
        params[13] = sessionCount;
        params[14] = candidates.length;
        params[15] = timeBase + subOffset;

        const paramsBuffer = createBuffer(device, params, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const outputBuffer = createBuffer(device, new Uint32Array([0xffffffff, 0, 0, 0, 0]), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: buffers.info } },
            { binding: 1, resource: { buffer: buffers.head } },
            { binding: 2, resource: { buffer: buffers.tail } },
            { binding: 3, resource: { buffer: buffers.components } },
            { binding: 4, resource: { buffer: paramsBuffer } },
            { binding: 5, resource: { buffer: outputBuffer } },
            { binding: 6, resource: { buffer: buffers.counters } },
            { binding: 7, resource: { buffer: buffers.tails } },
            { binding: 8, resource: { buffer: buffers.subseconds } }
          ]
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(Math.ceil(sessionCount / sessionLanes) / workgroupSize), thisSubCount, thisDeltaCount * candidates.length);
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        if (signal?.aborted) {
          paramsBuffer.destroy();
          outputBuffer.destroy();
          throw new DOMException("Scan aborted", "AbortError");
        }

        const out = await readOutput(device, outputBuffer);
        paramsBuffer.destroy();
        outputBuffer.destroy();
        processed += candidates.length * thisSubCount * thisDeltaCount * sessionCount;
        onProgress?.({ processed: Math.min(processed, total), total });

        if (out[0] !== 0xffffffff) {
          const candidate = candidates[out[1]];
          const delta = out[3];
          const session = out[4];
          const pdf = (session + delta) % N_COUNTERS;
          return {
            hit: true,
            userIndex: out[1],
            timeIndex: out[2],
            candidate,
            delta,
            session,
            pdf,
            sessionText: counterText(session),
            pdfText: counterText(pdf),
            processed: Math.min(processed, total),
            total
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    buffers.info.destroy();
    buffers.head.destroy();
    buffers.tail.destroy();
    buffers.components.destroy();
    buffers.counters.destroy();
    buffers.tails.destroy();
    buffers.subseconds.destroy();
  }
  return { hit: false, processed, total };
}
