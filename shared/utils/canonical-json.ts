/**
 * Deterministic JSON serialization for request identities and audit hashes.
 *
 * Object keys are sorted recursively while array order is preserved. Values
 * that cannot be represented safely in JSON are rejected instead of being
 * silently coerced into a different command identity.
 */
export function canonicalJson(value: unknown): string {
  const active = new WeakSet<object>();

  const normalize = (candidate: unknown, inArray: boolean): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers");
      }
      return candidate;
    }
    if (candidate instanceof Date) {
      if (Number.isNaN(candidate.getTime())) {
        throw new TypeError("Canonical JSON does not support invalid dates");
      }
      return candidate.toISOString();
    }
    if (candidate === undefined) return inArray ? null : undefined;
    if (typeof candidate === "bigint") {
      throw new TypeError("Canonical JSON does not support bigint values");
    }
    if (typeof candidate === "function" || typeof candidate === "symbol") {
      return inArray ? null : undefined;
    }
    if (typeof candidate !== "object") return candidate;

    const object = candidate as object;
    if (active.has(object)) {
      throw new TypeError("Canonical JSON does not support circular values");
    }
    active.add(object);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item) => normalize(item, true));
      }

      // A null-prototype target preserves data keys such as "__proto__"
      // instead of invoking Object.prototype's legacy setter and silently
      // changing the command identity.
      const normalized: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        const item = normalize((candidate as Record<string, unknown>)[key], false);
        if (item !== undefined) normalized[key] = item;
      }
      return normalized;
    } finally {
      active.delete(object);
    }
  };

  const normalized = normalize(value, false);
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined) {
    throw new TypeError("Canonical JSON requires a JSON-serializable root value");
  }
  return serialized;
}
