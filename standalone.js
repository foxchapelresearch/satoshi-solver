import * as ooo24 from "./webgpu/ooo24.js";
import * as solverWebGpu from "./webgpu/solver-webgpu.js";
import * as solverCpu from "./webgpu/solver-cpu.js";
import * as pdf from "./webgpu/pdf.js";
import * as presets from "./webgpu/presets.js";
import createMaskModule from "./webgpu/maskgen-emscripten.js";

const modules = { ooo24, solverWebGpu, solverCpu, pdf, presets, createMaskModule };
const $ = (id) => document.getElementById(id);

const WEBGPU_STATE = {
  solverPromise: null,
  solverKey: "",
  abort: null,
  fieldPrepared: false,
  maskModulePromise: null
};

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function formatHashrate(rate) {
  const value = Number(rate || 0);
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} GH/s`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} MH/s`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kH/s`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} H/s`;
}

function formatLiteralRate(rate) {
  const value = Number(rate || 0);
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}M/s`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}k/s`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}/s`;
}

function parseInclusiveRange(text, fallbackHi) {
  const trimmed = text.trim();
  if (!trimmed) return [0, fallbackHi];
  const normalized = trimmed.includes(":") ? trimmed : trimmed.replace("-", ":");
  const [a, b = a] = normalized.split(":");
  const lo = Number.parseInt(a, 10);
  const hi = Number.parseInt(b, 10);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) throw new Error(`bad range: ${text}`);
  return [lo, hi];
}

function xp64Millis(radius = 0) {
  const values = new Set();
  for (let tick = 0; tick < 64; tick += 1) {
    const base = Math.floor((tick * 1000) / 64);
    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = base + offset;
      if (value >= 0 && value <= 999) values.add(value);
    }
  }
  values.add(999);
  return [...values].sort((a, b) => a - b);
}

function parseMillisList(text, max) {
  const values = new Set();
  for (const partRaw of text.split(",")) {
    const part = partRaw.trim();
    if (!part) continue;
    const [lo, hi] = parseInclusiveRange(part, max);
    if (lo < 0 || hi > max) throw new Error(`millisecond value must be in 0..${max}`);
    for (let value = lo; value <= hi; value += 1) values.add(value);
  }
  const out = [...values].sort((a, b) => a - b);
  if (out.length === 0) throw new Error("millisecond set is empty");
  return out;
}

function millisValuesFor(setId, custom, mode) {
  const max = mode.startsWith("linux") ? 999999 : 999;
  if (setId === "all") return Array.from({ length: max + 1 }, (_, i) => i);
  if (setId === "xp64") return xp64Millis(0);
  return parseMillisList(custom, max);
}

function webGpuIds() {
  return {
    form: "webGpuForm",
    targetPreset: "webGpuTargetPreset",
    mode: "webGpuMode",
    source: "webGpuCandidateSource",
    millisSet: "webGpuMillisSet",
    millisCustom: "webGpuMillisCustom",
    deltas: "webGpuDeltas",
    sessions: "webGpuSessions",
    secondOffsets: "webGpuSecondOffsets",
    aliasMax: "webGpuAliasMax",
    chunkSize: "webGpuChunkSize",
    pdfs: "webGpuPdfs",
    file: "webGpuWordlistFile",
    mask: "webGpuMask",
    charset1: "webGpuCharset1",
    charset2: "webGpuCharset2",
    charset3: "webGpuCharset3",
    charset4: "webGpuCharset4",
    generateLimit: "webGpuGenerateLimit",
    wordTransform: "webGpuWordTransform",
    prefixMask: "webGpuPrefixMask",
    suffixMask: "webGpuSuffixMask",
    nameVariants: "webGpuNameVariants",
    previewGenerated: "webGpuPreviewGenerated",
    useGenerated: "webGpuUseGenerated",
    generatorStats: "webGpuGeneratorStats",
    generatorPreview: "webGpuGeneratorPreview",
    diagnostics: "webGpuDiagnostics",
    profileGenerator: "webGpuProfileGenerator",
    diagnosticSummary: "webGpuDiagnosticSummary",
    usernames: "webGpuUsernames",
    previewField: "webGpuPreviewField",
    prepareUsernames: "webGpuPrepareUsernames",
    prepareStats: "webGpuPrepareStats",
    start: "webGpuStart",
    abort: "webGpuAbort",
    bar: "webGpuBar",
    state: "webGpuState",
    rate: "webGpuRate",
    log: "webGpuLog"
  };
}

function solverLog(ids, line = "") {
  const el = $(ids.log);
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setSolverProgress(ids, processed, total, startedAt) {
  const pct = total ? Math.min(100, (processed / total) * 100) : 0;
  $(ids.bar).style.width = `${pct}%`;
  const seconds = (performance.now() - startedAt) / 1000;
  if (seconds > 0.2 && processed > 0) $(ids.rate).textContent = formatHashrate(processed / seconds);
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function webGpuTargets(ids) {
  const preset = $(ids.targetPreset).value;
  if (preset !== "custom") return modules.presets.materializePresetTargets(preset);
  const files = Array.from($(ids.pdfs).files || []);
  if (files.length === 0) throw new Error("Upload at least one PDF");
  const targets = [];
  for (const file of files) {
    const target = await modules.pdf.parsePdfTarget(new Uint8Array(await file.arrayBuffer()), file.name);
    targets.push(target);
  }
  return targets;
}

function webGpuBatchShape({ solver, candidateCount, millisCount, deltaCount, sessionCount }) {
  const maxDispatch = solver?.device?.limits?.maxComputeWorkgroupsPerDimension || 65535;
  const maxZ = Math.max(1, maxDispatch - 1);
  const maxDeltaByZ = Math.max(1, Math.floor(maxZ / Math.max(1, candidateCount)));
  const maxDispatchCandidates = 600000000;
  const candidateScale = Math.max(1, candidateCount * sessionCount);
  const deltaBatch = Math.max(1, Math.min(deltaCount, 32, maxDeltaByZ, Math.floor(maxDispatchCandidates / candidateScale) || 1));
  let subsecondBatch = Math.max(1, Math.floor(maxDispatchCandidates / (candidateScale * deltaBatch)) || 1);
  subsecondBatch = Math.min(millisCount, Math.max(1, Math.min(2048, subsecondBatch)));
  return { subsecondBatch, deltaBatch };
}

async function webGpuSolverFor(mode, targets, candidates) {
  const lanes = modules.solverWebGpu.recommendedSessionLanes(mode);
  const workgroupSize = modules.solverWebGpu.recommendedWorkgroupSize(mode);
  const messageWords = Math.max(...targets.map((target) =>
    modules.solverWebGpu.requiredMessageWords({ infoBytes: target.infoBytes, candidates, mode })
  ));
  const prehashPrefix = modules.solverWebGpu.shouldPrehashPrefix(mode);
  const key = `${mode}:${lanes}:${workgroupSize}:${messageWords}:${prehashPrefix}`;
  if (!WEBGPU_STATE.solverPromise || WEBGPU_STATE.solverKey !== key) {
    WEBGPU_STATE.solverPromise = modules.solverWebGpu.createWebGpuSolver({
      sessionLanes: lanes,
      workgroupSize,
      messageWords,
      prehashPrefix,
      mode
    });
    WEBGPU_STATE.solverKey = key;
  }
  return WEBGPU_STATE.solverPromise;
}

const MASK_CHARSETS = {
  l: "abcdefghijklmnopqrstuvwxyz",
  u: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  d: "0123456789",
  s: " !\"#$%&'()*+,-./:;<=>?@[]^_`{|}~"
};
MASK_CHARSETS.a = MASK_CHARSETS.l + MASK_CHARSETS.u + MASK_CHARSETS.d + MASK_CHARSETS.s;
const XP_MASK_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&'()-.@^_`{}~";
const XP_MASK_CHARS_NO_DOT = XP_MASK_CHARS.replace(".", "");

function defaultCustomCharset(code) {
  if (code === "1") return XP_MASK_CHARS;
  if (code === "2") return XP_MASK_CHARS_NO_DOT;
  return "";
}

function parseMaskTokens(mask, customCharsets) {
  const tokens = [];
  for (let i = 0; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch !== "?") {
      tokens.push(ch);
      continue;
    }
    const code = mask[++i];
    if (!code) throw new Error("mask cannot end with bare ?");
    if (code === "?") {
      tokens.push("?");
      continue;
    }
    const charset = customCharsets[code] || defaultCustomCharset(code) || MASK_CHARSETS[code];
    if (!charset) throw new Error(`unknown mask token ?${code}`);
    if (charset.length === 0) throw new Error(`mask token ?${code} has an empty charset`);
    tokens.push([...charset]);
  }
  if (tokens.length === 0) throw new Error("mask is empty");
  return tokens;
}

function maskCountFromTokens(tokens) {
  return tokens.reduce((total, token) => total * (Array.isArray(token) ? token.length : 1), 1);
}

async function emscriptenMaskCount(mask, customCharsets) {
  if (!WEBGPU_STATE.maskModulePromise) {
    WEBGPU_STATE.maskModulePromise = modules.createMaskModule({ print: () => {}, printErr: () => {} });
  }
  const mod = await WEBGPU_STATE.maskModulePromise;
  return mod.ccall(
    "mp_count",
    "number",
    ["string", "string", "string", "string", "string"],
    [mask, customCharsets["1"] || "", customCharsets["2"] || "", customCharsets["3"] || "", customCharsets["4"] || ""]
  );
}

function generatedNameAt(tokens, index) {
  let n = index;
  const out = [];
  for (let pos = tokens.length - 1; pos >= 0; pos -= 1) {
    const token = tokens[pos];
    if (Array.isArray(token)) {
      out[pos] = token[n % token.length];
      n = Math.floor(n / token.length);
    } else {
      out[pos] = token;
    }
  }
  return out.join("");
}

function customMaskCharsets(ids) {
  return {
    "1": $(ids.charset1).value || defaultCustomCharset("1"),
    "2": $(ids.charset2).value || defaultCustomCharset("2"),
    "3": $(ids.charset3).value,
    "4": $(ids.charset4).value
  };
}

function rawNamesFromMask(mask, customCharsets, limit) {
  const trimmed = mask.trim();
  const tokens = parseMaskTokens(trimmed, customCharsets);
  const total = maskCountFromTokens(tokens);
  const rawLimit = Math.min(total, limit);
  return {
    total,
    rawLimit,
    *[Symbol.iterator]() {
      for (let i = 0; i < rawLimit; i += 1) yield generatedNameAt(tokens, i);
    }
  };
}

function titleWords(words) {
  return words.map((word) => word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : word);
}

function nameVariantStrings(raw, level = "basic") {
  const text = raw.trim();
  if (!text) return [];
  if (level === "off") return [text];
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const lower = words.map((word) => word.toLowerCase());
  const title = titleWords(words);
  const upper = words.map((word) => word.toUpperCase());
  const candidates = new Set([text]);
  if (words.length > 0) {
    for (const parts of [lower, title]) {
      candidates.add(parts.join(""));
      candidates.add(parts.join(" "));
      candidates.add(parts.join("."));
      candidates.add(parts.join("_"));
      candidates.add(parts.join("-"));
    }
  }
  if (level === "aggressive" && words.length > 0) {
    candidates.add(upper.join(""));
    candidates.add(upper.join("."));
    candidates.add(upper.join("_"));
    if (words.length >= 2) {
      candidates.add(`${lower[0][0] || ""}${lower.slice(1).join("")}`);
      candidates.add(`${title[0][0] || ""}${title.slice(1).join("")}`);
      candidates.add(words.map((word) => word[0] || "").join(""));
    }
  }
  return [...candidates].filter(Boolean);
}

function applyMaskToWords(words, { prefixMask = "", suffixMask = "", mode = "none", customCharsets, limit = 1000000 }) {
  const prefix = mode === "prefix" || mode === "both"
    ? rawNamesFromMask(prefixMask || "", customCharsets, limit)
    : null;
  const suffix = mode === "suffix" || mode === "both"
    ? rawNamesFromMask(suffixMask || "", customCharsets, limit)
    : null;
  const prefixValues = prefix ? [...prefix] : [""];
  const suffixValues = suffix ? [...suffix] : [""];
  const out = [];
  for (const word of words) {
    for (const pre of prefixValues) {
      for (const suf of suffixValues) {
        out.push(`${pre}${word}${suf}`);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function transformedRawNames(rawLines) {
  const ids = webGpuIds();
  const customCharsets = customMaskCharsets(ids);
  const variantLevel = $(ids.nameVariants).value;
  const transformMode = $(ids.wordTransform).value;
  const limit = Math.max(1, Math.min(10000000, Number.parseInt($(ids.generateLimit).value, 10) || 200000));
  const variants = [];
  for (const line of rawLines) {
    for (const variant of nameVariantStrings(line, variantLevel)) {
      variants.push(variant);
      if (variants.length >= limit) break;
    }
    if (variants.length >= limit) break;
  }
  if (transformMode === "none") return variants;
  return applyMaskToWords(variants, {
    prefixMask: $(ids.prefixMask).value,
    suffixMask: $(ids.suffixMask).value,
    mode: transformMode,
    customCharsets,
    limit
  });
}

function dedupeXpCandidates(rawNames, mode, aliasMax, limit = Infinity, seen = new Set()) {
  const out = [];
  let rawCount = 0;
  for (const raw of rawNames) {
    rawCount += 1;
    for (const candidate of modules.ooo24.expandUsernameCandidates([raw], { mode, shortAliasMax: aliasMax })) {
      if (seen.has(candidate.component)) continue;
      seen.add(candidate.component);
      out.push(candidate);
      if (out.length >= limit) return { candidates: out, rawCount };
    }
  }
  return { candidates: out, rawCount };
}

function generateMaskCandidates(ids, { previewOnly = false } = {}) {
  const mode = $(ids.mode).value;
  const aliasMax = Number.parseInt($(ids.aliasMax).value, 10) || 1;
  const limit = Math.max(1, Math.min(10000000, Number.parseInt($(ids.generateLimit).value, 10) || 200000));
  const rawNames = rawNamesFromMask($(ids.mask).value, customMaskCharsets(ids), limit);
  const total = rawNames.total;
  const rawLimit = rawNames.rawLimit;
  const dedupeLimit = previewOnly ? Math.min(200, rawLimit) : rawLimit;
  const result = dedupeXpCandidates(rawNames, mode, aliasMax, dedupeLimit);
  return { ...result, total, rawLimit };
}

async function refreshGeneratorPreview({ useGenerated = false } = {}) {
  const ids = webGpuIds();
  const custom = customMaskCharsets(ids);
  const jsResult = generateMaskCandidates(ids, { previewOnly: !useGenerated });
  let emCount = null;
  try {
    emCount = await emscriptenMaskCount($(ids.mask).value.trim(), custom);
  } catch {
    emCount = null;
  }
  const rows = jsResult.candidates.slice(0, 40).map((candidate) =>
    `${candidate.input}${candidate.input === candidate.component ? "" : ` -> ${candidate.component}`}`
  );
  $(ids.generatorPreview).textContent = rows.join("\n");
  $(ids.generatorStats).textContent = [
    `${fmtNum(jsResult.total)} raw`,
    `${fmtNum(jsResult.candidates.length)} unique 8.3`,
    `limit ${fmtNum(jsResult.rawLimit)}`,
    `?1 ${fmtNum(custom["1"].length)} chars`,
    `?2 ${fmtNum(custom["2"].length)} chars`,
    emCount === null ? "" : `emscripten count ${fmtNum(Math.round(emCount))}`
  ].filter(Boolean).join(" / ");
  if (useGenerated) {
    $(ids.usernames).value = jsResult.candidates.map((candidate) => candidate.component).join("\n");
    $(ids.source).value = "field";
    WEBGPU_STATE.fieldPrepared = true;
    syncWebGpuCandidateSourceUi();
  }
}

function manualCandidateChunks(text, mode, aliasMax, chunkSize, { prepared = false } = {}) {
  const rawLines = text.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
  const generated = dedupeXpCandidates(
    prepared ? rawLines : transformedRawNames(rawLines),
    mode,
    aliasMax
  );
  const candidates = generated.candidates;
  const chunks = [];
  for (let offset = 0; offset < candidates.length; offset += chunkSize) {
    chunks.push(candidates.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function maskCandidateChunks(ids, mode, aliasMax, chunkSize) {
  const generated = generateMaskCandidates(ids, { previewOnly: false });
  const chunks = [];
  for (let offset = 0; offset < generated.candidates.length; offset += chunkSize) {
    chunks.push(generated.candidates.slice(offset, offset + chunkSize));
  }
  return chunks;
}

async function prepareManualUsernamesForWebGpu() {
  const ids = webGpuIds();
  const mode = $(ids.mode).value;
  const aliasMax = Number.parseInt($(ids.aliasMax).value, 10) || 1;
  const rawLines = $(ids.usernames).value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
  const transformed = transformedRawNames(rawLines);
  const generated = dedupeXpCandidates(transformed, mode, aliasMax);
  $(ids.usernames).value = generated.candidates.map((candidate) => candidate.component).join("\n");
  WEBGPU_STATE.fieldPrepared = true;
  $(ids.prepareStats).textContent = `${fmtNum(rawLines.length)} input / ${fmtNum(generated.rawCount)} expanded / ${fmtNum(generated.candidates.length)} unique 8.3`;
  $(ids.generatorPreview).textContent = generated.candidates.slice(0, 40).map((candidate) =>
    `${candidate.input}${candidate.input === candidate.component ? "" : ` -> ${candidate.component}`}`
  ).join("\n");
}

async function previewManualTransformForWebGpu() {
  const ids = webGpuIds();
  const mode = $(ids.mode).value;
  const aliasMax = Number.parseInt($(ids.aliasMax).value, 10) || 1;
  const rawLines = $(ids.usernames).value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
  const transformed = transformedRawNames(rawLines);
  const generated = dedupeXpCandidates(transformed, mode, aliasMax, 200);
  $(ids.prepareStats).textContent = `${fmtNum(rawLines.length)} input / ${fmtNum(generated.rawCount)} previewed / ${fmtNum(generated.candidates.length)} unique 8.3 shown`;
  $(ids.generatorPreview).textContent = generated.candidates.slice(0, 80).map((candidate) =>
    `${candidate.input}${candidate.input === candidate.component ? "" : ` -> ${candidate.component}`}`
  ).join("\n");
}

async function* wordlistCandidateChunks(file, mode, aliasMax, chunkSize, signal) {
  let buffer = "";
  let lines = [];
  const seen = new Set();
  const flush = function* () {
    if (lines.length === 0) return;
    const candidates = dedupeXpCandidates(transformedRawNames(lines), mode, aliasMax, Infinity, seen).candidates;
    lines = [];
    for (let offset = 0; offset < candidates.length; offset += chunkSize) {
      yield candidates.slice(offset, offset + chunkSize);
    }
  };
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  for (;;) {
    if (signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (line) lines.push(line);
      if (lines.length >= chunkSize) yield* flush();
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) lines.push(buffer.trim());
  yield* flush();
}

async function scanCpuFallback({ target, candidates, mode, epoch, millisValues, deltaStart, deltaCount, sessionStart, sessionCount, signal, onProgress }) {
  const total = candidates.length * millisValues.length * deltaCount * sessionCount;
  if (total > 25000000) {
    throw new Error("WebGPU is unavailable and this range is too large for CPU fallback");
  }
  const timePrefixes = millisValues.map((millis) => modules.ooo24.timeValueBytes(epoch, millis, mode));
  const prefixes = modules.ooo24.makePrefixRecords(timePrefixes, candidates, mode);
  const result = await modules.solverCpu.scanCpu({
    targetBytes: target.targetBytes,
    infoBytes: target.infoBytes,
    prefixes,
    deltaStart,
    deltaCount,
    sessionStart,
    sessionCount,
    signal,
    onProgress
  });
  if (result.hit) result.timeIndex = millisValues[result.timeIndex] ?? result.timeIndex;
  return result;
}

async function scanChunk({ ids, targets, candidates, mode, millisValues, deltaStart, deltaCount, sessionStart, sessionCount, secondOffsetMin, secondOffsetMax, startedAt }) {
  let solver = null;
  let webgpu = true;
  try {
    solver = await webGpuSolverFor(mode, targets, candidates);
  } catch (err) {
    webgpu = false;
    WEBGPU_STATE.solverPromise = null;
    WEBGPU_STATE.solverKey = "";
    solverLog(ids, `WebGPU unavailable; CPU fallback active (${err.message})`);
  }
  for (const target of targets) {
    for (let secondOffset = secondOffsetMin; secondOffset <= secondOffsetMax; secondOffset += 1) {
      if (WEBGPU_STATE.abort?.signal.aborted) throw new DOMException("Scan aborted", "AbortError");
      const epoch = (target.creationEpochUtc + secondOffset) >>> 0;
      const onProgress = ({ processed, total }) => {
        $(ids.state).textContent = `Scanning ${target.path}`;
        setSolverProgress(ids, processed, total, startedAt);
      };
      const result = webgpu
        ? await modules.solverWebGpu.scanWebGpu({
            solver,
            targetBytes: target.targetBytes,
            infoBytes: target.infoBytes,
            candidates,
            mode,
            epoch,
            subsecondValues: millisValues,
            deltaStart,
            deltaCount,
            sessionStart,
            sessionCount,
            signal: WEBGPU_STATE.abort.signal,
            onProgress,
            ...webGpuBatchShape({ solver, candidateCount: candidates.length, millisCount: millisValues.length, deltaCount, sessionCount })
          })
        : await scanCpuFallback({
            target,
            candidates,
            mode,
            epoch,
            millisValues,
            deltaStart,
            deltaCount,
            sessionStart,
            sessionCount,
            signal: WEBGPU_STATE.abort.signal,
            onProgress
          });
      if (result.hit) {
        const pdfCounter = (result.session + result.delta) % modules.ooo24.N_COUNTERS;
        const namePart = mode.startsWith("linux") ? "component=/tmp" : `username=${result.candidate.input} component=${result.candidate.component}`;
        solverLog(ids, `FOUND file=${target.path} ${namePart} millis=${result.timeIndex} session=${modules.ooo24.counterText(result.session)} delta=${result.delta} pdf=${modules.ooo24.counterText(pdfCounter)} offset=${secondOffset}`);
        return true;
      }
    }
  }
  return false;
}

async function runWebGpuDiagnostics() {
  const ids = webGpuIds();
  const lines = [];
  lines.push(`userAgent=${navigator.userAgent}`);
  if (!navigator.gpu) {
    lines.push("WebGPU API is not exposed in this browser.");
    $(ids.diagnosticSummary).textContent = "WebGPU unavailable";
    $("webGpuSupport").textContent = "WebGPU unavailable";
    solverLog(ids, lines.join("\n"));
    return;
  }
  const t0 = performance.now();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const adapterMs = performance.now() - t0;
  if (!adapter) {
    lines.push("navigator.gpu.requestAdapter() returned null.");
    $(ids.diagnosticSummary).textContent = "No adapter";
    $("webGpuSupport").textContent = "No WebGPU adapter";
    solverLog(ids, lines.join("\n"));
    return;
  }
  const info = adapter.info || {};
  lines.push(`adapter=${[info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" / ") || "unknown"}`);
  lines.push(`requestAdapter=${adapterMs.toFixed(1)}ms`);
  lines.push(`limits.maxComputeWorkgroupsPerDimension=${adapter.limits?.maxComputeWorkgroupsPerDimension ?? "unknown"}`);
  const desc = `${info.vendor || ""} ${info.architecture || ""} ${info.device || ""} ${info.description || ""}`.toLowerCase();
  const software = /(swiftshader|llvmpipe|software|cpu|mesa offscreen|warp)/.test(desc);
  if (software) {
    lines.push("WARNING: adapter string looks like a software/CPU backend.");
    $(ids.diagnosticSummary).textContent = "Likely CPU/WebGPU fallback";
    $("webGpuSupport").textContent = "WebGPU software adapter";
  } else {
    $(ids.diagnosticSummary).textContent = "Adapter looks hardware-backed";
    $("webGpuSupport").textContent = "WebGPU ready";
  }
  try {
    const d0 = performance.now();
    const device = await adapter.requestDevice();
    lines.push(`requestDevice=${(performance.now() - d0).toFixed(1)}ms`);
    device.destroy?.();
  } catch (err) {
    lines.push(`requestDevice failed: ${err.message || err}`);
    $(ids.diagnosticSummary).textContent = "Device request failed";
    $("webGpuSupport").textContent = "WebGPU device failed";
  }
  solverLog(ids, lines.join("\n"));
}

async function profileGenerator() {
  const ids = webGpuIds();
  const t0 = performance.now();
  const result = generateMaskCandidates(ids, { previewOnly: false });
  const elapsed = Math.max(0.001, (performance.now() - t0) / 1000);
  const rawRate = result.rawCount / elapsed;
  const uniqueRate = result.candidates.length / elapsed;
  const message = `generator: ${fmtNum(result.rawCount)} raw, ${fmtNum(result.candidates.length)} unique 8.3 in ${elapsed.toFixed(3)}s (${formatLiteralRate(rawRate)} raw, ${formatLiteralRate(uniqueRate)} unique)`;
  $(ids.generatorStats).textContent = message;
  solverLog(ids, message);
}

async function runWebGpu() {
  const ids = webGpuIds();
  const mode = $(ids.mode).value;
  const [deltaStart, deltaStop] = parseInclusiveRange($(ids.deltas).value, 384);
  const [sessionStart, sessionStop] = parseInclusiveRange($(ids.sessions).value, modules.ooo24.N_COUNTERS - 1);
  const [secondOffsetMin, secondOffsetMax] = parseInclusiveRange($(ids.secondOffsets).value, 0);
  const deltaCount = deltaStop - deltaStart + 1;
  const sessionCount = sessionStop - sessionStart + 1;
  const aliasMax = Number.parseInt($(ids.aliasMax).value, 10) || 1;
  const chunkSize = Math.max(1, Math.min(8192, Number.parseInt($(ids.chunkSize).value, 10) || 1024));
  const millisValues = millisValuesFor($(ids.millisSet).value, $(ids.millisCustom).value, mode);
  const targets = await webGpuTargets(ids);
  WEBGPU_STATE.abort = new AbortController();
  $(ids.start).disabled = true;
  $(ids.abort).disabled = false;
  $(ids.log).textContent = "";
  $(ids.rate).textContent = "";
  $(ids.bar).style.width = "0";
  $(ids.state).textContent = "Preparing";
  const startedAt = performance.now();
  const source = $(ids.source).value;
  const wordlistFile = ($(ids.file).files || [])[0];
  if (source === "file" && !wordlistFile) throw new Error("Choose a wordlist file or switch Candidate source to Wordlist field");
  solverLog(ids, `targets=${targets.map((target) => target.path).join(", ")} mode=${mode} source=${source}${source === "field" && WEBGPU_STATE.fieldPrepared ? " prepared=1" : ""} millis=${millisValues.length} delta=${deltaStart}:${deltaStop} session=${sessionStart}:${sessionStop}`);
  await nextAnimationFrame();

  try {
    let chunkNo = 0;
    let totalCandidates = 0;
    const chunks = source === "field"
      ? manualCandidateChunks($(ids.usernames).value, mode, aliasMax, chunkSize, { prepared: WEBGPU_STATE.fieldPrepared })
      : source === "file"
        ? wordlistCandidateChunks(wordlistFile, mode, aliasMax, chunkSize, WEBGPU_STATE.abort.signal)
        : maskCandidateChunks(ids, mode, aliasMax, chunkSize);
    for await (const candidates of chunks) {
      if (candidates.length === 0) continue;
      chunkNo += 1;
      totalCandidates += candidates.length;
      $(ids.state).textContent = `Chunk ${chunkNo}`;
      solverLog(ids, `chunk ${chunkNo}: ${fmtNum(candidates.length)} candidates`);
      const chunkStartedAt = performance.now();
      const hit = await scanChunk({
        ids,
        targets,
        candidates,
        mode,
        millisValues,
        deltaStart,
        deltaCount,
        sessionStart,
        sessionCount,
        secondOffsetMin,
        secondOffsetMax,
        startedAt
      });
      const chunkSeconds = Math.max(0.001, (performance.now() - chunkStartedAt) / 1000);
      const chunkAttempts = candidates.length * millisValues.length * deltaCount * sessionCount * targets.length * (secondOffsetMax - secondOffsetMin + 1);
      solverLog(ids, `chunk ${chunkNo}: ${formatHashrate(chunkAttempts / chunkSeconds)} over ${chunkSeconds.toFixed(2)}s`);
      if (hit) {
        $(ids.state).textContent = `Found after ${fmtNum(totalCandidates)} candidates`;
        return;
      }
    }
    if (chunkNo === 0) throw new Error("No usable username candidates");
    $(ids.state).textContent = `Done, no hit in ${fmtNum(totalCandidates)} candidates`;
    solverLog(ids, "no hit");
  } finally {
    $(ids.start).disabled = false;
    $(ids.abort).disabled = true;
    WEBGPU_STATE.abort = null;
  }
}

function syncWebGpuTargetUi({ applyDefaults = false } = {}) {
  const ids = webGpuIds();
  const key = $(ids.targetPreset).value;
  const custom = key === "custom";
  document.querySelectorAll("#webgpu .custom-pdf-field").forEach((el) => {
    el.hidden = !custom;
  });
  const preset = modules.presets.PRESET_TARGETS[key];
  $(ids.mode).disabled = false;
  if (preset && !preset.modeEditable) {
    $(ids.mode).value = preset.mode;
    $(ids.mode).disabled = true;
  } else if (preset && applyDefaults) {
    $(ids.mode).value = preset.mode;
  }
  if (preset && applyDefaults && preset.defaultUsernames?.length) {
    $(ids.usernames).value = preset.defaultUsernames.join("\n");
    WEBGPU_STATE.fieldPrepared = false;
  }
}

function syncWebGpuCandidateSourceUi() {
  const ids = webGpuIds();
  const source = $(ids.source).value;
  const transform = $(ids.wordTransform).value;
  const usesMask = source === "mask" || (source !== "mask" && transform !== "none");
  document.querySelectorAll("#webgpu .candidate-source-field").forEach((el) => {
    el.hidden = source !== "field";
  });
  document.querySelectorAll("#webgpu .candidate-source-file").forEach((el) => {
    el.hidden = source !== "file";
  });
  document.querySelectorAll("#webgpu .candidate-source-mask").forEach((el) => {
    el.hidden = source !== "mask";
  });
  document.querySelectorAll("#webgpu .wordlist-transform-option").forEach((el) => {
    el.hidden = source === "mask";
  });
  document.querySelectorAll("#webgpu .prefix-mask-option").forEach((el) => {
    el.hidden = source === "mask" || (transform !== "prefix" && transform !== "both");
  });
  document.querySelectorAll("#webgpu .suffix-mask-option").forEach((el) => {
    el.hidden = source === "mask" || (transform !== "suffix" && transform !== "both");
  });
  document.querySelectorAll("#webgpu .mask-option").forEach((el) => {
    el.hidden = !usesMask;
  });
}

function markWebGpuFieldUnprepared() {
  WEBGPU_STATE.fieldPrepared = false;
}

function bindWebGpu() {
  const ids = webGpuIds();
  $(ids.form).addEventListener("submit", (event) => {
    event.preventDefault();
    runWebGpu().catch((err) => {
      if (err.name === "AbortError") {
        $(ids.state).textContent = "Aborted";
        solverLog(ids, "aborted");
      } else {
        $(ids.state).textContent = "Error";
        solverLog(ids, `error: ${err.message || err}`);
        console.error(err);
      }
      $(ids.start).disabled = false;
      $(ids.abort).disabled = true;
      WEBGPU_STATE.abort = null;
    });
  });
  $(ids.abort).addEventListener("click", () => {
    if (!WEBGPU_STATE.abort || WEBGPU_STATE.abort.signal.aborted) return;
    $(ids.state).textContent = "Aborting";
    $(ids.abort).disabled = true;
    WEBGPU_STATE.abort.abort();
  });
  $(ids.previewGenerated).addEventListener("click", () => {
    refreshGeneratorPreview().catch((err) => {
      $(ids.generatorStats).textContent = `Error: ${err.message || err}`;
    });
  });
  $(ids.useGenerated).addEventListener("click", () => {
    refreshGeneratorPreview({ useGenerated: true }).catch((err) => {
      $(ids.generatorStats).textContent = `Error: ${err.message || err}`;
    });
  });
  $(ids.diagnostics).addEventListener("click", () => {
    runWebGpuDiagnostics().catch((err) => {
      $(ids.diagnosticSummary).textContent = `Error: ${err.message || err}`;
    });
  });
  $(ids.profileGenerator).addEventListener("click", () => {
    profileGenerator().catch((err) => {
      $(ids.generatorStats).textContent = `Error: ${err.message || err}`;
    });
  });
  $(ids.previewField).addEventListener("click", () => {
    previewManualTransformForWebGpu().catch((err) => {
      $(ids.prepareStats).textContent = `Error: ${err.message || err}`;
    });
  });
  $(ids.prepareUsernames).addEventListener("click", () => {
    prepareManualUsernamesForWebGpu().catch((err) => {
      $(ids.prepareStats).textContent = `Error: ${err.message || err}`;
    });
  });
  $(ids.targetPreset).addEventListener("change", () => syncWebGpuTargetUi({ applyDefaults: true }));
  $(ids.source).addEventListener("change", syncWebGpuCandidateSourceUi);
  $(ids.wordTransform).addEventListener("change", syncWebGpuCandidateSourceUi);
  $(ids.usernames).addEventListener("input", markWebGpuFieldUnprepared);
  [
    ids.wordTransform,
    ids.prefixMask,
    ids.suffixMask,
    ids.nameVariants,
    ids.aliasMax,
    ids.mode
  ].forEach((id) => {
    $(id).addEventListener("change", markWebGpuFieldUnprepared);
    $(id).addEventListener("input", markWebGpuFieldUnprepared);
  });
  syncWebGpuTargetUi();
  syncWebGpuCandidateSourceUi();
}

function initSupportStatus() {
  $("webGpuSupport").textContent = navigator.gpu ? "WebGPU API visible" : "WebGPU unavailable";
}

bindWebGpu();
initSupportStatus();
