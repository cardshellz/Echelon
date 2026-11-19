// Compatibility export: persisted fingerprint bytes and existing callers stay unchanged.
export { costFingerprint } from "../domain/cost-fingerprint";

export class CostEvidenceError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "CostEvidenceError";
  }
}

export function costInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CostEvidenceError("COST_EVIDENCE_INVALID_INTEGER", `${field} is not a supported integer.`, { field });
  }
  return parsed;
}
