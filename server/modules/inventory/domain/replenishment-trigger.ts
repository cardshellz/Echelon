import { ValidationError } from "../../../../shared/errors";

/** Preserve the complete audit reason. PostgreSQL text cannot contain NUL. */
export function validateReplenishmentTrigger(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new ValidationError("Replenishment trigger must be nonblank text without NUL characters", {
      field: "triggeredBy",
    });
  }
  return value;
}
