import { OPENING_CAPTURE_CHUNK_CHARACTERS, OPENING_CAPTURE_MAX_CHUNKS } from "@shared/types/inventory-opening-capture";

/** Serialize a validated DTO without cloning/stringifying its entire census.
 * Chunks are transport boundaries only; none is independently usable evidence. */
function* jsonTokens(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* jsonTokens(value[index]);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key); yield ":"; yield* jsonTokens(item);
    }
    yield "}";
  } else {
    const token = JSON.stringify(value);
    if (token === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error("CUTOVER_CAPTURE_ARTIFACT_INVALID");
    }
    yield token;
  }
}

export function* openingCaptureChunks(value: unknown): Generator<string> {
  let pending = "";
  let count = 0;
  for (const token of jsonTokens(value)) {
    pending += token;
    while (pending.length >= OPENING_CAPTURE_CHUNK_CHARACTERS) {
      let end = OPENING_CAPTURE_CHUNK_CHARACTERS;
      // PostgreSQL text cannot store an isolated UTF-16 surrogate. Preserve
      // supplementary Unicode characters across the UTF-8 database boundary.
      const last = pending.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      if (++count > OPENING_CAPTURE_MAX_CHUNKS) throw new Error("CUTOVER_CAPTURE_ARTIFACT_LIMIT");
      yield pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
  if (pending) {
    if (++count > OPENING_CAPTURE_MAX_CHUNKS) throw new Error("CUTOVER_CAPTURE_ARTIFACT_LIMIT");
    yield pending;
  }
}
