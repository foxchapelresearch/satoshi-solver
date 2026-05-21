import { bytesToHex, hexToBytes } from "./md5.js";
import { N_COUNTERS, candidateDigestBytes, counterText } from "./ooo24.js";

function digestEquals(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function verifyCandidate({ prefixSnapshot, infoBytes, targetBytes, session, delta }) {
  return digestEquals(candidateDigestBytes(prefixSnapshot, infoBytes, session, delta), targetBytes);
}

export async function scanCpu({
  targetBytes,
  targetHex,
  infoBytes,
  prefixes,
  deltaStart = 0,
  deltaCount = 1,
  sessionStart = 0,
  sessionCount = N_COUNTERS,
  signal,
  onProgress,
  yieldEvery = 250000
}) {
  const target = targetBytes || hexToBytes(targetHex);
  let processed = 0;
  const total = prefixes.length * deltaCount * sessionCount;
  for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex++) {
    const prefix = prefixes[prefixIndex];
    for (let d = 0; d < deltaCount; d++) {
      const delta = deltaStart + d;
      for (let s = 0; s < sessionCount; s++) {
        if (signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
        const session = sessionStart + s;
        const digest = candidateDigestBytes(prefix.snapshot, infoBytes, session, delta);
        processed++;
        if (digestEquals(digest, target)) {
          const pdf = (session + delta) % N_COUNTERS;
          return {
            hit: true,
            prefixIndex,
            userIndex: prefix.userIndex,
            timeIndex: prefix.timeIndex,
            candidate: prefix.candidate,
            session,
            delta,
            pdf,
            sessionText: counterText(session),
            pdfText: counterText(pdf),
            digestHex: bytesToHex(digest).toUpperCase(),
            processed,
            total
          };
        }
        if (processed % yieldEvery === 0) {
          onProgress?.({ processed, total });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
  }
  onProgress?.({ processed, total });
  return { hit: false, processed, total };
}
