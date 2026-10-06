import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";

export class CostEvidenceError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "CostEvidenceError";
  }
}

export function costFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function costInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CostEvidenceError("COST_EVIDENCE_INVALID_INTEGER", `${field} is not a supported integer.`, { field });
  }
  return parsed;
}
